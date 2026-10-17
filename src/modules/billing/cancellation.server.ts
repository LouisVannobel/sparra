import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { BillingWorkspaceLease } from '../../platform/db/auth-pg-lease.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import type { StripeConfig } from './stripe-config.server'
import type { createStripeBillingClient } from './stripe.server'
import { billingCustomer, billingOperation } from './schema.server'

const one = sql`(SELECT 1) AS billing_cancellation_row`
const requestHash = createHash('sha256').update(JSON.stringify({ cancel_at_period_end: true })).digest('hex')
const confirmed = Object.freeze({ state: 'confirmed' as const })
function refusal(status: number): Response { return new Response('Billing unavailable', { status }) }

export async function cancelAtPeriodEnd(owner: AuthTransactions, principal: AdmittedPrincipal, config: StripeConfig,
  client: ReturnType<typeof createStripeBillingClient>, workspaceId: string, signal?: AbortSignal): Promise<typeof confirmed> {
  function scoped<A>(work: (lease: BillingWorkspaceLease) => Promise<A>): Promise<A> {
    return owner.withBillingWorkspacePromise({ deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000,
      cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal }, principal, workspaceId, lease => {
      if (!lease) throw refusal(404)
      return work(lease)
    })
  }
  const newId = randomUUID(), newKey = `cancel:${newId}`
  const admitted = await scoped(async lease => {
    const [row] = await lease.db.select({ id: sql<string | null>`app_private.billing_admit_cancellation(
      ${principal.userId},${principal.sessionId},${workspaceId}::uuid,${config.environment},${config.accountId},
      ${config.apiVersion},${newId}::uuid,${newKey},${requestHash})` }).from(one)
    const [customer] = await lease.db.select().from(billingCustomer).where(and(
      eq(billingCustomer.workspaceId, workspaceId), eq(billingCustomer.environment, config.environment),
      eq(billingCustomer.accountId, config.accountId)))
    const [operation] = await lease.db.select().from(billingOperation).where(and(
      eq(billingOperation.workspaceId, workspaceId), eq(billingOperation.environment, config.environment),
      eq(billingOperation.accountId, config.accountId), eq(billingOperation.kind, 'CANCEL_AT_PERIOD_END')))
    return { id: row?.id ?? null, customer, operation }
  })
  if (!admitted.id) throw refusal(409)
  const { customer, operation } = admitted
  if (!customer?.knownSubscriptionId || !operation || operation.id !== admitted.id
    || operation.workspaceId !== workspaceId || operation.environment !== config.environment
    || operation.accountId !== config.accountId || operation.apiVersion !== config.apiVersion
    || operation.customerId !== customer.stripeCustomerId || operation.requestHash !== requestHash
    || operation.idempotencyKey !== `cancel:${operation.id}`) throw refusal(503)
  const subscriptionId = customer.knownSubscriptionId
  if (operation.phase === 'SUCCEEDED') {
    if (operation.stripeObjectId !== subscriptionId) throw refusal(503)
    return confirmed
  }
  // A prior admission, including lost COMMIT acknowledgement, cannot be
  // adopted by another request and turned into a replacement provider effect.
  if (operation.phase !== 'ADMITTED' || operation.id !== newId) throw refusal(409)
  const claimed = await scoped(async lease => {
    const [row] = await lease.db.select({ claimed: sql<boolean>`app_private.billing_claim_cancellation(
      ${principal.userId},${principal.sessionId},${workspaceId}::uuid,${operation.id}::uuid,
      ${config.environment},${config.accountId},${subscriptionId})` }).from(one)
    return row?.claimed === true
  })
  if (!claimed) throw refusal(409)
  owner.assertNoActiveAuthTransaction()
  if (signal?.aborted) throw refusal(503)
  try {
    const observation = await client.cancelSubscriptionAtPeriodEnd({ customerId: customer.stripeCustomerId,
      subscriptionId, idempotencyKey: operation.idempotencyKey })
    if (observation.subscriptionId !== subscriptionId || observation.cancelAtPeriodEnd !== true) throw refusal(503)
  } catch {
    try { await scoped(async lease => {
      await lease.db.select({ marked: sql<boolean>`app_private.billing_mark_unknown(${principal.userId},
        ${principal.sessionId},${workspaceId}::uuid,${operation.id}::uuid)` }).from(one)
    }) } catch { /* A retained DISPATCHING fact is already unresolved. */ }
    throw refusal(503)
  }
  const persisted = await scoped(async lease => {
    const [row] = await lease.db.select({ persisted: sql<boolean>`app_private.billing_complete_cancellation(
      ${principal.userId},${principal.sessionId},${workspaceId}::uuid,${operation.id}::uuid,${subscriptionId})` }).from(one)
    return row?.persisted === true
  })
  if (!persisted) throw refusal(503)
  return confirmed
}
