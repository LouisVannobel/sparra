import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { BillingWorkspaceLease } from '../../platform/db/auth-pg-lease.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import type { StripeConfig } from './stripe-config.server'
import { buildCheckoutParameters, type CheckoutIntent, type createStripeBillingClient } from './stripe.server'
import { billingAgreement, billingCurrentAgreement, billingCustomer, billingOperation } from './schema.server'

export type BillingClient = ReturnType<typeof createStripeBillingClient>
export type BillingInput = Readonly<{ workspaceId: string }>
export type BillingSummary = Readonly<{
  availability: 'available' | 'unavailable'
  state: 'not-started' | 'customer-pending' | 'checkout-pending' | 'checkout-ready' | 'subscription-present' | 'paid' | 'held' | 'incident' | 'unavailable'
  paidThrough: string | null
  cancellation: 'none' | 'pending' | 'confirmed' | 'incident'
}>

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const zero = '00000000-0000-0000-0000-000000000000'
// Drizzle's pinned SELECT builder becomes executable only after FROM.
// This static one-row source invokes exactly one named SQL function.
const singleRow = sql`(SELECT 1) AS billing_single_row`
function refusal(status: number): Response { return new Response('Billing unavailable', { status }) }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function options(signal?: AbortSignal) {
  return { deadlineAtMs: Date.now() + 10_000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal }
}
export function parseBillingInput(input: unknown): BillingInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'workspaceId')) throw refusal(400)
  const selected: unknown = (input as Record<string, unknown>).workspaceId
  if (typeof selected !== 'string' || !uuid.test(selected) || selected === zero) throw refusal(400)
  return { workspaceId: selected }
}
export function assertExactBillingOrigin(request: Request, config: StripeConfig) {
  if (request.method !== 'POST' || new URL(request.url).origin !== config.origin
    || request.headers.get('origin') !== config.origin
    || ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) throw refusal(403)
}
async function scoped<A>(owner: AuthTransactions, principal: AdmittedPrincipal, workspaceId: string,
  signal: AbortSignal | undefined, work: (lease: BillingWorkspaceLease) => Promise<A>): Promise<A> {
  return owner.withBillingWorkspacePromise(options(signal), principal, workspaceId, lease => {
    if (!lease) throw refusal(404)
    return work(lease)
  })
}
type Snapshot = Readonly<{
  customer: typeof billingCustomer.$inferSelect | null
  customerOperation: typeof billingOperation.$inferSelect | null
  checkoutOperation: typeof billingOperation.$inferSelect | null
  cancellationOperation: typeof billingOperation.$inferSelect | null
  observedAtSeconds: number
}>
async function snapshot(lease: BillingWorkspaceLease, config: StripeConfig): Promise<Snapshot> {
  const scope = and(eq(billingCustomer.workspaceId, lease.workspaceId), eq(billingCustomer.environment, config.environment),
    eq(billingCustomer.accountId, config.accountId))
  const operationScope = and(eq(billingOperation.workspaceId, lease.workspaceId), eq(billingOperation.environment, config.environment),
    eq(billingOperation.accountId, config.accountId))
  const [customer] = await lease.db.select().from(billingCustomer).where(scope)
  const operations = await lease.db.select().from(billingOperation).where(operationScope)
  // The resolver already locked User, Session and Workspace. This independent
  // statement reads PostgreSQL time after those waits, never request time.
  const [clock] = await lease.db.select({ seconds: sql<number>`extract(epoch from clock_timestamp())::float8` }).from(singleRow)
  if (!clock || !Number.isFinite(clock.seconds)) throw refusal(503)
  return { customer: customer ?? null,
    customerOperation: operations.find(operation => operation.kind === 'CUSTOMER_CREATE') ?? null,
    checkoutOperation: operations.find(operation => operation.kind === 'CHECKOUT_CREATE') ?? null,
    cancellationOperation: operations.find(operation => operation.kind === 'CANCEL_AT_PERIOD_END') ?? null,
    observedAtSeconds: clock.seconds }
}
function cancellationState(current: Snapshot, config: StripeConfig): BillingSummary['cancellation'] {
  const operation = current.cancellationOperation
  if (!operation) return 'none'
  const customer = current.customer, checkout = current.checkoutOperation
  // CANCEL has no Price fields. Its canonical literal-true intention and the
  // immutable Customer -> subscription binding are independent of today's price.
  if (!customer?.knownSubscriptionId || !checkout || checkout.customerId !== customer.stripeCustomerId
    || checkout.apiVersion !== config.apiVersion || !['DISPATCHING', 'SUCCEEDED', 'UNKNOWN'].includes(checkout.phase)
    || operation.workspaceId !== customer.workspaceId || operation.environment !== config.environment
    || operation.accountId !== config.accountId || operation.apiVersion !== config.apiVersion
    || operation.customerId !== customer.stripeCustomerId || operation.idempotencyKey !== `cancel:${operation.id}`
    || operation.requestHash !== sha256(JSON.stringify({ cancel_at_period_end: true }))
    || operation.monthlyPriceId !== null || operation.onboardingPriceId !== null || operation.currency !== null
    || operation.monthlyUnitAmount !== null || operation.onboardingUnitAmount !== null || operation.integrationIdentifier !== null
    || operation.checkoutUrl !== null || operation.checkoutExpiresAt !== null) return 'incident'
  if (operation.phase === 'SUCCEEDED') return operation.stripeObjectId === customer.knownSubscriptionId ? 'confirmed' : 'incident'
  if (operation.stripeObjectId !== null || operation.phase === 'UNKNOWN') return 'incident'
  return operation.phase === 'ADMITTED' || operation.phase === 'DISPATCHING' ? 'pending' : 'incident'
}
function state(snapshotValue: Snapshot): BillingSummary['state'] {
  if (snapshotValue.customer?.knownSubscriptionId) return 'subscription-present'
  const checkout = snapshotValue.checkoutOperation
  if (checkout?.phase === 'SUCCEEDED') return checkout.checkoutExpiresAt !== null
    && checkout.checkoutExpiresAt > snapshotValue.observedAtSeconds ? 'checkout-ready' : 'incident'
  if (checkout?.phase === 'UNKNOWN' || checkout?.phase === 'DISPATCHING') return 'incident'
  if (checkout?.phase === 'ADMITTED') return 'checkout-pending'
  const customer = snapshotValue.customerOperation
  if (customer?.phase === 'UNKNOWN' || customer?.phase === 'DISPATCHING') return 'incident'
  if (customer?.phase === 'ADMITTED') return 'customer-pending'
  return 'not-started'
}
export async function readBillingState(owner: AuthTransactions, principal: AdmittedPrincipal, config: StripeConfig | null,
  workspaceId: string, signal?: AbortSignal): Promise<BillingSummary> {
  return scoped(owner, principal, workspaceId, signal, async lease => {
    if (!config) return { availability: 'unavailable', state: 'unavailable', paidThrough: null, cancellation: 'none' }
    const current = await snapshot(lease, config)
    const cancellation = cancellationState(current, config)
    const [pointer] = await lease.db.select().from(billingCurrentAgreement)
      .where(eq(billingCurrentAgreement.workspaceId, lease.workspaceId))
    if (!pointer) return { availability: 'available', state: state(current), paidThrough: null, cancellation }
    const [agreement] = await lease.db.select().from(billingAgreement).where(and(
      eq(billingAgreement.id, pointer.agreementId), eq(billingAgreement.workspaceId, lease.workspaceId),
      eq(billingAgreement.environment, config.environment), eq(billingAgreement.accountId, config.accountId)))
    if (!agreement || !Number.isSafeInteger(agreement.periodEnd) || agreement.periodEnd <= 0) throw refusal(503)
    return { availability: 'available', state: pointer.heldAt !== null ? 'held'
      : agreement.periodEnd > current.observedAtSeconds ? 'paid' : 'incident',
    paidThrough: new Date(agreement.periodEnd * 1000).toISOString(), cancellation }
  })
}

type Catalog = Readonly<{ currency: string; monthlyAmount: number; onboardingAmount: number | null }>
function validPrice(price: Stripe.Price, id: string, live: boolean) {
  return price.object === 'price' && price.id === id && price.livemode === live && price.active
    && /^[a-z]{3}$/.test(price.currency) && typeof price.unit_amount === 'number'
    && Number.isSafeInteger(price.unit_amount) && price.unit_amount > 0
}
async function catalog(owner: AuthTransactions, config: StripeConfig, client: BillingClient): Promise<Catalog> {
  owner.assertNoActiveAuthTransaction()
  let monthly: Stripe.Price, onboarding: Stripe.Price | null = null
  try {
    monthly = await client.retrievePrice(config.monthlyPriceId)
    if (config.onboardingPriceId) onboarding = await client.retrievePrice(config.onboardingPriceId)
  } catch { throw refusal(503) }
  const live = config.environment === 'live'
  if (!validPrice(monthly, config.monthlyPriceId, live) || monthly.type !== 'recurring'
    || monthly.billing_scheme !== 'per_unit' || monthly.recurring?.interval !== 'month'
    || monthly.recurring.interval_count !== 1 || monthly.recurring.usage_type !== 'licensed'
    || monthly.recurring.meter != null || config.onboardingPriceId === config.monthlyPriceId
    || onboarding && (!validPrice(onboarding, config.onboardingPriceId!, live) || onboarding.type !== 'one_time'
      || onboarding.recurring != null || onboarding.currency !== monthly.currency)) throw refusal(503)
  return { currency: monthly.currency, monthlyAmount: monthly.unit_amount!, onboardingAmount: onboarding?.unit_amount ?? null }
}
function customerBody(workspaceId: string) { return JSON.stringify({ metadata: { workspace_id: workspaceId } }) }
function checkoutBody(config: StripeConfig, intent: CheckoutIntent) { return JSON.stringify(buildCheckoutParameters(config, intent)) }
function integrationIdentifier(id: string) {
  const bytes = createHash('sha256').update(id).digest().subarray(0, 8)
  return `template_${[...bytes].map(value => String.fromCharCode(65 + value % 26)).join('')}`
}
function matchesConfig(operation: typeof billingOperation.$inferSelect, config: StripeConfig) {
  return operation.environment === config.environment && operation.accountId === config.accountId && operation.apiVersion === config.apiVersion
    && (operation.kind === 'CUSTOMER_CREATE' || operation.monthlyPriceId === config.monthlyPriceId
      && operation.onboardingPriceId === config.onboardingPriceId)
}
async function customerFor(owner: AuthTransactions, principal: AdmittedPrincipal, workspaceId: string,
  config: StripeConfig, client: BillingClient, signal?: AbortSignal): Promise<string> {
  const newId = randomUUID(), newKey = `customer:${newId}`, hash = sha256(customerBody(workspaceId))
  const admitted = await scoped(owner, principal, workspaceId, signal, async lease => {
    const [result] = await lease.db.select({ id: sql<string | null>`app_private.billing_admit_customer(${principal.userId},${principal.sessionId},${workspaceId}::uuid,
      ${config.environment},${config.accountId},${config.apiVersion},${newId}::uuid,${newKey},${hash})` }).from(singleRow)
    const current = await snapshot(lease, config)
    return { id: result?.id ?? null, current }
  })
  if (admitted.current.customer) return admitted.current.customer.stripeCustomerId
  const operation = admitted.current.customerOperation
  if (!admitted.id || !operation || operation.id !== admitted.id || !matchesConfig(operation, config)
    || operation.requestHash !== hash) throw refusal(503)
  if (operation.id !== newId) throw refusal(409)
  if (operation.phase !== 'ADMITTED') throw refusal(409)
  const claimed = await scoped(owner, principal, workspaceId, signal, async lease => {
    const [row] = await lease.db.select({ claimed: sql<boolean>`app_private.billing_claim_operation(${principal.userId},${principal.sessionId},${workspaceId}::uuid,${operation.id}::uuid)` }).from(singleRow)
    return row?.claimed === true
  })
  if (!claimed) throw refusal(409)
  owner.assertNoActiveAuthTransaction()
  let customer: { id: string }
  try { customer = await client.createCustomer({ workspaceId, idempotencyKey: operation.idempotencyKey }) }
  catch {
    await markUnknown(owner, principal, workspaceId, operation.id, signal)
    throw refusal(503)
  }
  const persisted = await scoped(owner, principal, workspaceId, signal, async lease => {
    const [row] = await lease.db.select({ persisted: sql<boolean>`app_private.billing_complete_customer(${principal.userId},${principal.sessionId},
      ${workspaceId}::uuid,${operation.id}::uuid,${customer.id})` }).from(singleRow)
    return row?.persisted === true
  })
  if (!persisted) throw refusal(503)
  return customer.id
}
async function markUnknown(owner: AuthTransactions, principal: AdmittedPrincipal, workspaceId: string, operationId: string, signal?: AbortSignal) {
  try { await scoped(owner, principal, workspaceId, signal, async lease => {
    await lease.db.select({ marked: sql<boolean>`app_private.billing_mark_unknown(${principal.userId},${principal.sessionId},${workspaceId}::uuid,${operationId}::uuid)` }).from(singleRow)
  }) } catch { /* A retained DISPATCHING fact is already an unresolved incident. */ }
}

export async function startCheckout(owner: AuthTransactions, principal: AdmittedPrincipal, config: StripeConfig,
  client: BillingClient, workspaceId: string, signal?: AbortSignal): Promise<{ url: string }> {
  const initial = await scoped(owner, principal, workspaceId, signal, lease => snapshot(lease, config))
  if (initial.customer?.knownSubscriptionId) throw refusal(409)
  const previous = initial.checkoutOperation
  if (previous) {
    if (!matchesConfig(previous, config)) throw refusal(409)
    if (previous.phase === 'SUCCEEDED' && previous.checkoutUrl) {
      if (previous.checkoutExpiresAt !== null && previous.checkoutExpiresAt > initial.observedAtSeconds) return { url: previous.checkoutUrl }
      throw refusal(409)
    }
    if (previous.phase !== 'ADMITTED') throw refusal(409)
  }
  if (initial.customerOperation && initial.customerOperation.phase !== 'SUCCEEDED'
    && initial.customerOperation.phase !== 'ADMITTED') throw refusal(409)
  const prices = await catalog(owner, config, client)
  const customerId = initial.customer?.stripeCustomerId ?? await customerFor(owner, principal, workspaceId, config, client, signal)
  const newId = randomUUID(), newKey = `checkout:${newId}`, newIntegration = integrationIdentifier(newId)
  const proposed: CheckoutIntent = { workspaceId, customerId, idempotencyKey: newKey, integrationIdentifier: newIntegration, operationReference: newId }
  const hash = sha256(checkoutBody(config, proposed))
  const admitted = await scoped(owner, principal, workspaceId, signal, async lease => {
    const [result] = await lease.db.select({ id: sql<string | null>`app_private.billing_admit_checkout_v2(${principal.userId},${principal.sessionId},
      ${workspaceId}::uuid,${config.environment},${config.accountId},${config.apiVersion},${newId}::uuid,${newKey},${hash},
      ${customerId},${config.monthlyPriceId},${config.onboardingPriceId},${prices.currency},${prices.monthlyAmount},
      ${prices.onboardingAmount},${newIntegration})` }).from(singleRow)
    const current = await snapshot(lease, config)
    return { id: result?.id ?? null, current }
  })
  if (admitted.current.customer?.knownSubscriptionId) throw refusal(409)
  const operation = admitted.current.checkoutOperation
  if (!admitted.id || !operation || operation.id !== admitted.id || !matchesConfig(operation, config)
    || operation.customerId !== customerId || operation.currency !== prices.currency
    || operation.monthlyUnitAmount !== prices.monthlyAmount || operation.onboardingUnitAmount !== prices.onboardingAmount) throw refusal(503)
  if (operation.phase === 'SUCCEEDED' && operation.checkoutUrl) {
    if (operation.checkoutExpiresAt !== null && operation.checkoutExpiresAt > admitted.current.observedAtSeconds) return { url: operation.checkoutUrl }
    throw refusal(409)
  }
  if (operation.id !== newId) throw refusal(409)
  if (operation.phase !== 'ADMITTED' || !operation.integrationIdentifier) throw refusal(409)
  const intent: CheckoutIntent = { workspaceId, customerId, idempotencyKey: operation.idempotencyKey,
    integrationIdentifier: operation.integrationIdentifier,
    ...(operation.checkoutReferenceVersion === 'operation-v2' ? { operationReference: operation.id } : {}) }
  if (sha256(checkoutBody(config, intent)) !== operation.requestHash) throw refusal(503)
  const claimed = await scoped(owner, principal, workspaceId, signal, async lease => {
    const [row] = await lease.db.select({ claimed: sql<boolean>`app_private.billing_claim_operation(${principal.userId},${principal.sessionId},${workspaceId}::uuid,${operation.id}::uuid)` }).from(singleRow)
    return row?.claimed === true
  })
  if (!claimed) throw refusal(409)
  owner.assertNoActiveAuthTransaction()
  let navigation: { id: string; url: string; expiresAt: number }
  try { navigation = await client.createCheckout(intent) }
  catch {
    await markUnknown(owner, principal, workspaceId, operation.id, signal)
    throw refusal(503)
  }
  const persisted = await scoped(owner, principal, workspaceId, signal, async lease => {
    const [row] = await lease.db.select({ persisted: sql<boolean>`app_private.billing_complete_checkout(${principal.userId},${principal.sessionId},
      ${workspaceId}::uuid,${operation.id}::uuid,${navigation.id},${navigation.url},${navigation.expiresAt}::bigint)` }).from(singleRow)
    return row?.persisted === true
  })
  if (!persisted) throw refusal(503)
  return { url: navigation.url }
}
