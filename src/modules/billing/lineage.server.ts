import { createHash } from 'node:crypto'
import { collectBillingPages } from './read-pages.server'
import type Stripe from 'stripe'
import type { StripeConfig } from './stripe-config.server'
import type { StripeReadClient } from './stripe-read.server'
import type { billingCustomer, billingOperation } from './schema.server'
import type { BoundMonthlyInvoice, MonetaryProvider } from './reconcile.server'
import type { VerifiedStripeEvent } from './stripe-webhook.server'
import { buildCheckoutParameters } from './stripe.server'
import { classifyBillingEvent } from './events.server'
import { operationMonthlyTerms, type AgreedMonthlyTerms } from './agreed-terms.server'

export type ObservedBillingLineage = Readonly<{
  operationId: string; workspaceId: string; environment: StripeConfig['environment']; accountId: string
  customerId: string; checkoutSessionId: string; subscriptionId: string; invoiceId: string
  boundInvoice: BoundMonthlyInvoice
}>

class BillingLineageError extends Error {
  constructor() { super('Billing lineage unavailable'); this.name = 'BillingLineageError' }
}
function fail(): never { throw new BillingLineageError() }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const patterns = {
  customer: /^cus_[A-Za-z0-9]+$/, subscription: /^sub_[A-Za-z0-9]+$/,
  invoice: /^in_[A-Za-z0-9]+$/, payment_intent: /^pi_[A-Za-z0-9]+$/, charge: /^ch_[A-Za-z0-9]+$/,
} as const
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
type LineageInvoice = Awaited<ReturnType<MonetaryProvider['retrieveInvoice']>>
type LineageSubscription = Pick<Stripe.Subscription, 'id' | 'object' | 'livemode' | 'customer' | 'customer_account' | 'currency' | 'collection_method'> & {
  items: { object: 'list'; has_more: boolean; data: Pick<Stripe.SubscriptionItem, 'id' | 'object' | 'subscription' | 'quantity' | 'price'>[] }
}
type LineageSession = Pick<Stripe.Checkout.Session, 'id' | 'object' | 'livemode' | 'mode' | 'customer_account' | 'customer' |
  'subscription' | 'client_reference_id' | 'integration_identifier' | 'currency' | 'status' | 'invoice'>
type LineageItem = Pick<Stripe.LineItem, 'id' | 'object' | 'price' | 'quantity' | 'currency' | 'amount_subtotal' | 'amount_total' | 'amount_tax' | 'amount_discount'>
export type LineageProvider = Readonly<{
  retrieveInvoice(id: string): Promise<LineageInvoice>
  retrieveSubscription(id: string): Promise<LineageSubscription>
  retrieveCheckoutSession(id: string): Promise<LineageSession>
  listCheckoutSessions(subscriptionId: string, customerId: string, cursor?: string): Promise<{ object: 'list'; has_more: boolean; data: LineageSession[] }>
  listCheckoutLineItems(sessionId: string, cursor?: string): Promise<{ object: 'list'; has_more: boolean; data: LineageItem[] }>
}>
function reference(value: unknown, kind: keyof typeof patterns, live: boolean): string {
  const id = typeof value === 'string' ? value
    : value !== null && typeof value === 'object' && 'id' in value ? value.id : null
  if (typeof id !== 'string' || !patterns[kind].test(id)
    || value !== null && typeof value === 'object' && (!('object' in value) || value.object !== kind
      || 'livemode' in value && value.livemode !== live || 'deleted' in value && value.deleted === true)) fail()
  return id
}
function checkoutId(id: string, live: boolean): void {
  if (!(live ? /^cs_live_[A-Za-z0-9]+$/ : /^cs_test_[A-Za-z0-9]+$/).test(id)) fail()
}

function requireLineagePageRow(row: { id: string }, seen: ReadonlySet<string>): void {
  if (typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) fail()
}

function invoiceScope(invoice: LineageInvoice, live: boolean) {
  if (invoice.object !== 'invoice' || invoice.livemode !== live || invoice.customer_account !== null
    || invoice.parent?.type !== 'subscription_details') fail()
  return { customerId: reference(invoice.customer, 'customer', live),
    subscriptionId: reference(invoice.parent.subscription_details?.subscription, 'subscription', live) }
}
function subscriptionCustomer(subscription: Pick<Stripe.Subscription, 'object' | 'livemode' | 'customer_account' | 'customer'>, live: boolean): string {
  if (subscription.object !== 'subscription' || subscription.livemode !== live || subscription.customer_account !== null) fail()
  return reference(subscription.customer, 'customer', live)
}
function matchesPrice(price: Stripe.Price | null, id: string, amount: number, currency: string, live: boolean): boolean {
  return price !== null && price.object === 'price' && price.id === id && price.livemode === live
    && price.currency === currency && price.unit_amount === amount && price.billing_scheme === 'per_unit'
    && price.type === 'recurring' && price.recurring?.interval === 'month'
    && price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed' && price.recurring.meter == null
}

type CheckoutOperation = typeof billingOperation.$inferSelect & {
  monthlyPriceId: string; monthlyUnitAmount: number; currency: string; integrationIdentifier: string
}
function requireCheckoutScope(config: StripeConfig, operation: typeof billingOperation.$inferSelect,
  customer: typeof billingCustomer.$inferSelect): asserts operation is typeof billingOperation.$inferSelect & { monthlyPriceId: string } {
  if (!uuid.test(operation.id) || !uuid.test(operation.workspaceId) || operation.kind !== 'CHECKOUT_CREATE'
    || !['DISPATCHING', 'UNKNOWN', 'SUCCEEDED'].includes(operation.phase)
    || operation.environment !== config.environment || operation.accountId !== config.accountId
    || operation.apiVersion !== config.apiVersion || customer.environment !== config.environment
    || customer.accountId !== config.accountId || customer.workspaceId !== operation.workspaceId
    || operation.customerId !== customer.stripeCustomerId || !operation.monthlyPriceId) fail()
}
function requireMonthlySnapshot(operation: typeof billingOperation.$inferSelect, terms: AgreedMonthlyTerms): void {
  if (!terms || operation.agreedTermsId !== terms.id || terms.workspaceId !== operation.workspaceId
    || terms.environment !== operation.environment || terms.accountId !== operation.accountId
    || !positive(terms.revision) || terms.monthlyPriceId !== operation.monthlyPriceId
    || terms.currency !== operation.currency || terms.monthlyUnitAmount !== operation.monthlyUnitAmount) fail()
}
function requireCheckoutSnapshot(operation: typeof billingOperation.$inferSelect & { monthlyPriceId: string }): asserts operation is CheckoutOperation {
  if (operation.onboardingPriceId !== null || operation.onboardingUnitAmount !== null
    || !operation.currency || !/^[a-z]{3}$/.test(operation.currency)
    || !positive(operation.monthlyUnitAmount) || !operation.integrationIdentifier
    || operation.checkoutReferenceVersion !== 'legacy-v1' && operation.checkoutReferenceVersion !== 'operation-v2'
    || operation.phase === 'SUCCEEDED' && operation.stripeObjectId === null
    || operation.phase !== 'SUCCEEDED' && operation.stripeObjectId !== null) fail()
}

function requireMonthlySubscription(subscription: LineageSubscription, subscriptionId: string,
  customerId: string, operation: CheckoutOperation, live: boolean): void {
  if (subscription.id !== subscriptionId || subscriptionCustomer(subscription, live) !== customerId
    || subscription.currency !== operation.currency || subscription.collection_method !== 'charge_automatically'
    || subscription.items?.object !== 'list' || subscription.items.has_more !== false
    || !Array.isArray(subscription.items.data) || subscription.items.data.length !== 1) fail()
  const item = subscription.items.data[0]!
  if (item.object !== 'subscription_item' || item.subscription !== subscription.id || item.quantity !== 1
    || !matchesPrice(item.price, operation.monthlyPriceId, operation.monthlyUnitAmount, operation.currency, live)) fail()
}

function requireCompletedSession(session: LineageSession, sessionId: string, subscriptionId: string,
  customerId: string, originalReference: string, operation: CheckoutOperation, live: boolean): void {
  if (session.id !== sessionId || session.object !== 'checkout.session' || session.livemode !== live
    || session.mode !== 'subscription' || session.customer_account !== null
    || reference(session.customer, 'customer', live) !== customerId
    || reference(session.subscription, 'subscription', live) !== subscriptionId
    || session.client_reference_id !== originalReference || session.integration_identifier !== operation.integrationIdentifier
    || session.currency !== operation.currency || session.status !== 'complete') fail()
}

function requireExactCheckoutLine(line: LineageItem, priceId: string, amount: number,
  operation: CheckoutOperation, live: boolean): void {
  if (line.object !== 'item'
    || line.quantity !== 1 || line.currency !== operation.currency || line.amount_subtotal !== amount
    || line.amount_total !== amount || line.amount_tax !== 0 || line.amount_discount !== 0
    || !matchesPrice(line.price, priceId, amount, operation.currency, live)) fail()
}

function requireCheckoutLines(lines: LineageItem[], operation: CheckoutOperation, live: boolean): void {
  if (lines.length !== 1) fail()
  requireExactCheckoutLine(lines[0]!, operation.monthlyPriceId, operation.monthlyUnitAmount, operation, live)
}

function requireMonthlyServicePeriod(monthly: LineageInvoice['lines']['data'][number], subscriptionId: string,
  operation: CheckoutOperation, live: boolean): void {
  if (monthly.object !== 'line_item' || monthly.livemode !== live || monthly.quantity !== 1
    || monthly.currency !== operation.currency || reference(monthly.subscription, 'subscription', live) !== subscriptionId
    || monthly.parent?.type !== 'subscription_item_details'
    || monthly.parent.subscription_item_details?.subscription !== subscriptionId
    || monthly.parent.subscription_item_details.proration !== false
    || !positive(monthly.period?.start) || !positive(monthly.period.end) || monthly.period.end <= monthly.period.start) fail()
}

function checkedMonthlyPeriod(invoice: LineageInvoice, subscriptionId: string,
  operation: CheckoutOperation, live: boolean) {
  const monthlyLines = invoice.lines.data.filter(row => row.pricing?.type === 'price_details'
    && (typeof row.pricing.price_details?.price === 'string' ? row.pricing.price_details.price : row.pricing.price_details?.price?.id) === operation.monthlyPriceId)
  if (monthlyLines.length !== 1 || invoice.lines.data.length !== 1) fail()
  const monthly = monthlyLines[0]!
  requireMonthlyServicePeriod(monthly, subscriptionId, operation, live)
  return monthly
}

function checkedInvoicePeriod(invoice: LineageInvoice, session: LineageSession, invoiceId: string,
  subscriptionId: string, operation: CheckoutOperation, live: boolean) {
  const firstPeriod = invoice.billing_reason === 'subscription_create'
  if (!firstPeriod && invoice.billing_reason !== 'subscription_cycle'
    || invoice.currency !== operation.currency || invoice.lines?.object !== 'list'
    || invoice.lines.has_more !== false || !Array.isArray(invoice.lines.data)) fail()
  if (firstPeriod && reference(session.invoice, 'invoice', live) !== invoiceId) fail()
  const monthly = checkedMonthlyPeriod(invoice, subscriptionId, operation, live)
  const expectedAmount = operation.monthlyUnitAmount
  if (!positive(expectedAmount)) fail()
  return { firstPeriod, monthly, expectedAmount }
}

// Own the four caller data inputs as one synchronous boundary before provider code runs.
function ownedLineageInputs(config: StripeConfig, operation: typeof billingOperation.$inferSelect,
  customer: typeof billingCustomer.$inferSelect, terms: AgreedMonthlyTerms) {
  config = config && { ...config }
  operation = operation && { ...operation }
  customer = customer && { ...customer }
  terms = terms && { ...terms }
  return { config, operation, customer, terms }
}

export async function proveBillingLineage(config: StripeConfig, provider: LineageProvider,
  operation: typeof billingOperation.$inferSelect, customer: typeof billingCustomer.$inferSelect,
  invoiceId: string, terms: AgreedMonthlyTerms): Promise<ObservedBillingLineage> {
  ({ config, operation, customer, terms } = ownedLineageInputs(config, operation, customer, terms))
  const live = config.environment === 'live'
  requireCheckoutScope(config, operation, customer)
  requireMonthlySnapshot(operation, terms)
  requireCheckoutSnapshot(operation)
  const customerId = reference(customer.stripeCustomerId, 'customer', live)
  reference(invoiceId, 'invoice', live)
  const originalReference = operation.checkoutReferenceVersion === 'operation-v2' ? operation.id : operation.workspaceId
  const parameters = buildCheckoutParameters(config, {
    workspaceId: operation.workspaceId, customerId, idempotencyKey: operation.idempotencyKey,
    integrationIdentifier: operation.integrationIdentifier,
    terms: operationMonthlyTerms(operation),
    ...(operation.checkoutReferenceVersion === 'operation-v2' ? { operationReference: operation.id } : {}),
  })
  if (createHash('sha256').update(JSON.stringify(parameters)).digest('hex') !== operation.requestHash) fail()
  // No original positive slot witness is established by a legacy marker,
  // metadata, email, or Customer+Price discovery, even if only one is seen.
  if (operation.stripeObjectId === null && operation.checkoutReferenceVersion === 'legacy-v1') fail()

  const invoice = await provider.retrieveInvoice(invoiceId)
  if (invoice.id !== invoiceId) fail()
  const scope = invoiceScope(invoice, live)
  if (scope.customerId !== customerId || customer.knownSubscriptionId !== null
    && customer.knownSubscriptionId !== scope.subscriptionId) fail()
  const subscription = await provider.retrieveSubscription(scope.subscriptionId)
  requireMonthlySubscription(subscription, scope.subscriptionId, customerId, operation, live)

  let sessionId = operation.stripeObjectId
  if (sessionId === null) {
    const sessions = await collectBillingPages(cursor => provider.listCheckoutSessions(subscription.id, customerId, cursor), requireLineagePageRow, fail)
    const matching = sessions.filter(row => row.client_reference_id === originalReference)
    if (matching.length !== 1) fail()
    sessionId = matching[0]!.id
  }
  checkoutId(sessionId, live)
  const session = await provider.retrieveCheckoutSession(sessionId)
  requireCompletedSession(session, sessionId, subscription.id, customerId, originalReference, operation, live)
  const lines = await collectBillingPages(cursor => provider.listCheckoutLineItems(sessionId, cursor), requireLineagePageRow, fail)
  requireCheckoutLines(lines, operation, live)

  const { firstPeriod, monthly, expectedAmount } = checkedInvoicePeriod(invoice, session, invoiceId, subscription.id, operation, live)
  const boundInvoice: BoundMonthlyInvoice = Object.freeze({ environment: config.environment, accountId: config.accountId,
    customerId, subscriptionId: subscription.id, invoiceId, agreedTermsId: terms.id, monthlyPriceId: operation.monthlyPriceId,
    currency: operation.currency, expectedAmount, periodStart: monthly.period.start, periodEnd: monthly.period.end,
    firstPeriod, onboarding: null })
  return Object.freeze({ operationId: operation.id, workspaceId: operation.workspaceId, environment: config.environment,
    accountId: config.accountId, customerId, checkoutSessionId: sessionId, subscriptionId: subscription.id, invoiceId, boundInvoice })
}

async function subscriptionEventSubject(provider: StripeReadClient, live: boolean,
  selected: ReturnType<typeof classifyBillingEvent>) {
  let subscriptionId: string, sessionInvoice: string | null = null, sessionCustomer: string | null = null
  if (selected.kind === 'checkout') {
    checkoutId(selected.id, live)
    const session = await provider.retrieveCheckoutSession(selected.id)
    if (session.id !== selected.id) fail()
    subscriptionId = reference(session.subscription, 'subscription', live)
    sessionCustomer = reference(session.customer, 'customer', live)
    if (session.invoice !== null) sessionInvoice = reference(session.invoice, 'invoice', live)
  } else subscriptionId = selected.id
  return { subscriptionId, sessionInvoice, sessionCustomer }
}

async function resolveSubscriptionInvoices(provider: StripeReadClient, live: boolean,
  selected: ReturnType<typeof classifyBillingEvent>, event: VerifiedStripeEvent, knownInvoiceIds: readonly string[]): Promise<readonly string[]> {
  const { subscriptionId, sessionInvoice, sessionCustomer } = await subscriptionEventSubject(provider, live, selected)
  const subscription = await provider.retrieveSubscription(subscriptionId)
  if (subscription.id !== subscriptionId) fail()
  const customerId = subscriptionCustomer(subscription, live)
  if (sessionCustomer !== null && sessionCustomer !== customerId) fail()
  if (event.references.customerId !== null && event.references.customerId !== customerId
    || event.references.subscriptionId !== null && event.references.subscriptionId !== subscriptionId) fail()
  const candidates = new Set(knownInvoiceIds)
  if (sessionInvoice !== null) candidates.add(sessionInvoice)
  if (subscription.latest_invoice !== null) candidates.add(reference(subscription.latest_invoice, 'invoice', live))
  if (candidates.size === 0) fail()
  for (const id of candidates) {
    const invoice = await provider.retrieveInvoice(id)
    const scope = invoiceScope(invoice, live)
    if (invoice.id !== id || scope.customerId !== customerId || scope.subscriptionId !== subscriptionId) fail()
  }
  return Object.freeze([...candidates].sort())
}

async function chargeEventSubject(provider: StripeReadClient, live: boolean,
  selected: ReturnType<typeof classifyBillingEvent>) {
  let chargeId = selected.id, riskIntent: string | null = null
  if (selected.kind === 'dispute' || selected.kind === 'early_fraud_warning') {
    const risk = selected.kind === 'dispute' ? await provider.retrieveDispute(selected.id)
      : await provider.retrieveEarlyFraudWarning(selected.id)
    if (risk.id !== selected.id || risk.livemode !== live) fail()
    chargeId = reference(risk.charge, 'charge', live)
    if (risk.payment_intent != null) riskIntent = reference(risk.payment_intent, 'payment_intent', live)
  }
  return { chargeId, riskIntent }
}

async function readChargeEventOwner(provider: StripeReadClient, live: boolean,
  chargeId: string, riskIntent: string | null, event: VerifiedStripeEvent) {
  const charge = await provider.retrieveCharge(chargeId)
  if (charge.id !== chargeId || charge.livemode !== live) fail()
  const customerId = reference(charge.customer, 'customer', live)
  const paymentIntentId = reference(charge.payment_intent, 'payment_intent', live)
  if (riskIntent !== null && riskIntent !== paymentIntentId) fail()
  if (event.references.chargeId !== null && event.references.chargeId !== chargeId
    || event.references.paymentIntentId !== null && event.references.paymentIntentId !== paymentIntentId
    || event.references.customerId !== null && event.references.customerId !== customerId) fail()
  const intent = await provider.retrievePaymentIntent(paymentIntentId)
  if (intent.id !== paymentIntentId || intent.livemode !== live
    || reference(intent.customer, 'customer', live) !== customerId) fail()
  return { customerId, paymentIntentId }
}

async function chargeInvoiceCandidates(provider: StripeReadClient, live: boolean,
  paymentIntentId: string, knownInvoiceIds: readonly string[]) {
  const allocations = await collectBillingPages(cursor => provider.listInvoicePaymentsForPaymentIntent(paymentIntentId, cursor), requireLineagePageRow, fail)
  if (allocations.length === 0) fail()
  const candidates = new Set<string>()
  for (const allocation of allocations) {
    if (allocation.payment?.type !== 'payment_intent'
      || reference(allocation.payment.payment_intent, 'payment_intent', live) !== paymentIntentId) fail()
    candidates.add(reference(allocation.invoice, 'invoice', live))
  }
  // A string snapshot cannot prove a historical edge that is now absent.
  // Refuse the incident; never silently discard or clear that known edge.
  for (const id of knownInvoiceIds) if (!candidates.has(id)) fail()
  return candidates
}

async function resolveChargeInvoices(provider: StripeReadClient, live: boolean,
  selected: ReturnType<typeof classifyBillingEvent>, event: VerifiedStripeEvent, knownInvoiceIds: readonly string[]): Promise<readonly string[]> {
  const { chargeId, riskIntent } = await chargeEventSubject(provider, live, selected)
  const { customerId, paymentIntentId } = await readChargeEventOwner(provider, live, chargeId, riskIntent, event)
  const candidates = await chargeInvoiceCandidates(provider, live, paymentIntentId, knownInvoiceIds)
  for (const id of candidates) {
    const invoice = await provider.retrieveInvoice(id)
    if (invoice.id !== id || invoiceScope(invoice, live).customerId !== customerId) fail()
  }
  return Object.freeze([...candidates].sort())
}

// Candidates only. Every downstream grant must still prove lineage and the
// separate monetary/risk facts; none of this DTO commits a SQL transition.
export async function resolveBillingEventInvoices(config: StripeConfig, provider: StripeReadClient,
  event: VerifiedStripeEvent, knownInvoiceIds: readonly string[]): Promise<readonly string[]> {
  const live = config.environment === 'live'
  if (event.environment !== config.environment || event.accountId !== config.accountId || event.projectionVersion !== 1) fail()
  const selected = classifyBillingEvent(event)
  if (selected.kind === 'invoice') return Object.freeze([selected.id])
  if (knownInvoiceIds.length > 500) fail()
  for (const id of knownInvoiceIds) reference(id, 'invoice', live)

  if (selected.kind === 'checkout' || selected.kind === 'subscription') {
    return resolveSubscriptionInvoices(provider, live, selected, event, knownInvoiceIds)
  }

  return resolveChargeInvoices(provider, live, selected, event, knownInvoiceIds)
}
