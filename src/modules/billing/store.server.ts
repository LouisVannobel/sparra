import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { sql } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { VerifiedStripeEvent } from './stripe-webhook.server'
import type { ObservedBillingLineage } from './lineage.server'
import { classifyBillingEvent } from './events.server'
import { billingUuid, billingNatural, billingPositive, billingIds, billingHash, billingEnvironment, bounded,
  decodeBilling, decodeBillingResult, BillingStoreError, lineageSchema, observationSchema, observationInputSchema,
  decisionSchema, riskFactsSchema, targetProgressSchema,
  type BillingObservation, type BillingObservationInput, type BillingApplyDecision, type VerifiedRiskFacts } from './billing-agreement.server'
export type { BillingObservation, BillingObservationInput, ObservedChargeBinding, TargetProgress, BillingApplyDecision,
  VerifiedRiskFacts, BillingEffectResult, UnpaidInvoiceObservation } from './billing-agreement.server'

const jobSchema = Schema.Struct({ outboxId: billingUuid, tenantId: billingUuid })
export type BillingJobInput = typeof jobSchema.Type
const completedClaimSchema = Schema.Struct({ input: jobSchema, commandCompleted: Schema.Literal(true) })
export type BillingCompletedClaim = typeof completedClaimSchema.Type
const admissionResultSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('admitted'), runId: billingUuid }),
  Schema.Struct({ state: Schema.Literal('unknown') }),
  Schema.Struct({ state: Schema.Literal('terminal'), runId: billingUuid, terminalDisposition: Schema.Literals(['completed', 'failed', 'cancelled']) }),
])
export type BillingAdmissionResult = typeof admissionResultSchema.Type
const eventSchema = Schema.Struct({ id: billingIds.event, type: Schema.String, created: billingNatural,
  objectId: Schema.String.check(Schema.isMaxLength(255)), objectType: Schema.String, projectionVersion: Schema.Literal(1),
  environment: billingEnvironment, accountId: billingIds.account,
  references: Schema.Struct({ customerId: Schema.NullOr(billingIds.customer), subscriptionId: Schema.NullOr(billingIds.subscription),
    paymentIntentId: Schema.NullOr(billingIds.intent), chargeId: Schema.NullOr(billingIds.charge),
    riskId: Schema.NullOr(Schema.Union([billingIds.dispute, billingIds.warning])) }),
})
const operationSchema = Schema.Struct({ id: billingUuid, workspaceId: billingUuid,
  kind: Schema.Literals(['CUSTOMER_CREATE', 'CHECKOUT_CREATE']), phase: Schema.Literals(['ADMITTED', 'DISPATCHING', 'SUCCEEDED', 'UNKNOWN']),
  environment: billingEnvironment, accountId: billingIds.account, apiVersion: Schema.Literal('2026-09-30.endive'),
  idempotencyKey: Schema.String.check(Schema.isMaxLength(255), Schema.isPattern(/^[A-Za-z0-9:_-]+$/)), requestHash: billingHash,
  customerId: Schema.NullOr(billingIds.customer), monthlyPriceId: Schema.NullOr(billingIds.price), onboardingPriceId: Schema.NullOr(billingIds.price),
  currency: Schema.NullOr(Schema.String), monthlyUnitAmount: Schema.NullOr(billingPositive), onboardingUnitAmount: Schema.NullOr(billingPositive),
  integrationIdentifier: Schema.NullOr(Schema.String), checkoutReferenceVersion: Schema.Literals(['legacy-v1', 'operation-v2']),
  stripeObjectId: Schema.NullOr(Schema.String), checkoutUrl: Schema.NullOr(Schema.String), checkoutExpiresAt: Schema.NullOr(billingPositive),
  createdAt: Schema.DateFromString, updatedAt: Schema.DateFromString,
})
const customerSchema = Schema.Struct({ id: billingUuid, workspaceId: billingUuid, environment: billingEnvironment,
  accountId: billingIds.account, stripeCustomerId: billingIds.customer, knownSubscriptionId: Schema.NullOr(billingIds.subscription), createdAt: Schema.DateFromString })
const claimSchema = Schema.Struct({ input: jobSchema, commandCompleted: Schema.Literal(false), fence: billingPositive, deadlineAtMs: billingPositive, event: eventSchema,
  operation: operationSchema, customer: customerSchema, knownInvoiceIds: bounded(billingIds.invoice),
  manifestRevision: billingNatural, targetProgress: bounded(targetProgressSchema) })
export type BillingClaim = typeof claimSchema.Type
const one = sql`(SELECT 1) AS billing_single_row`
const json = (value: unknown) => JSON.stringify(value)
function claimIdentity(claim: BillingClaim) {
  decodeBilling(Schema.Literal(false), claim?.commandCompleted)
  const input = decodeBilling(jobSchema, claim?.input)
  const fence = decodeBilling(billingPositive, claim?.fence)
  return { input, fence }
}
export function createBillingStore(owner: AuthTransactions) {
  const options = (signal?: AbortSignal) => ({ deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000,
    cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal })
  async function receive(event: VerifiedStripeEvent, signal: AbortSignal) {
    const checked = decodeBilling(eventSchema, event)
    classifyBillingEvent(checked)
    return owner.withAuthPromise(options(signal), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_receive_event(${json(checked)}::jsonb)` }).from(one)
      return decodeBilling(Schema.Struct({ status: Schema.Literals(['enqueued', 'duplicate', 'unassigned-risk']) }), row?.value).status
    })
  }
  async function claimAdmission(signal: AbortSignal) {
    return owner.withAuthPromise(options(signal), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_claim_admission()` }).from(one)
      if (row?.value === null) return null
      const result = decodeBilling(Schema.Struct({ input: jobSchema, fence: billingPositive,
        state: Schema.Literals(['dispatch', 'reconcile']), runId: Schema.NullOr(billingUuid) }), row?.value)
      if (result.state === 'dispatch' && result.runId !== null) throw new BillingStoreError()
      return result
    })
  }
  async function finalizeAdmission(input: BillingJobInput, fence: number, result: BillingAdmissionResult) {
    input = decodeBilling(jobSchema, input); fence = decodeBilling(billingPositive, fence)
    result = decodeBilling(admissionResultSchema, result)
    return owner.withAuthPromise(options(), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_finalize_admission(${input.outboxId}::uuid,${input.tenantId}::uuid,${fence}::bigint,${json(result)}::jsonb)` }).from(one)
      return decodeBilling(Schema.Boolean, row?.value)
    })
  }
  async function claim(input: BillingJobInput, signal: AbortSignal): Promise<BillingClaim | BillingCompletedClaim | null> {
    input = decodeBilling(jobSchema, input)
    return owner.withAuthPromise(options(signal), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_claim_command(${input.outboxId}::uuid,${input.tenantId}::uuid)` }).from(one)
      if (row?.value === null) return null
      const result = decodeBilling(Schema.Union([claimSchema, completedClaimSchema]), row?.value)
      if (result.input.outboxId !== input.outboxId || result.input.tenantId !== input.tenantId) throw new BillingStoreError()
      if (result.commandCompleted) return result
      if (result.operation.workspaceId !== input.tenantId || result.customer.workspaceId !== input.tenantId
        || result.operation.environment !== result.event.environment || result.operation.accountId !== result.event.accountId
        || result.customer.environment !== result.event.environment || result.customer.accountId !== result.event.accountId
        || result.operation.customerId !== result.customer.stripeCustomerId) throw new BillingStoreError()
      return result
    })
  }
  async function observe(claim: BillingClaim, lineage: ObservedBillingLineage, input: BillingObservationInput, signal: AbortSignal): Promise<BillingObservation> {
    const identity = claimIdentity(claim)
    lineage = decodeBilling(lineageSchema, lineage); input = decodeBilling(observationInputSchema, input)
    return owner.withAuthPromise(options(signal), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_observe_command(${identity.input.outboxId}::uuid,${identity.input.tenantId}::uuid,${identity.fence}::bigint,${json(lineage)}::jsonb,${json(input)}::jsonb)` }).from(one)
      return decodeBilling(observationSchema, row?.value)
    })
  }
  async function apply(claim: BillingClaim, observation: BillingObservation, decision: BillingApplyDecision, signal: AbortSignal) {
    const identity = claimIdentity(claim)
    observation = decodeBilling(observationSchema, observation); decision = decodeBilling(decisionSchema, decision)
    return owner.withAuthPromise(options(signal), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_apply_command(${identity.input.outboxId}::uuid,${identity.input.tenantId}::uuid,${identity.fence}::bigint,${json(observation)}::jsonb,${json(decision)}::jsonb)` }).from(one)
      return decodeBillingResult(row?.value)
    })
  }
  async function recordRisk(claim: BillingClaim, observation: BillingObservation, facts: VerifiedRiskFacts, signal: AbortSignal) {
    const identity = claimIdentity(claim)
    observation = decodeBilling(observationSchema, observation); facts = decodeBilling(riskFactsSchema, facts)
    return owner.withAuthPromise(options(signal), async ({ db }) => {
      const [row] = await db.select({ value: sql`app_private.billing_record_risk(${identity.input.outboxId}::uuid,${identity.input.tenantId}::uuid,${identity.fence}::bigint,${json({ observation, facts })}::jsonb)` }).from(one)
      return decodeBillingResult(row?.value)
    })
  }
  return { receive, claimAdmission, finalizeAdmission, claim, observe, apply, recordRisk }
}
export type BillingStore = ReturnType<typeof createBillingStore>
