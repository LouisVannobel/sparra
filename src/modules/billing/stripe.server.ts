import Stripe from 'stripe'
import { createStripeTransport, StripeInputError, StripeProviderError } from './stripe-transport.server'
export { StripeInputError, StripeProviderError } from './stripe-transport.server'
import type { StripeConfig } from './stripe-config.server'

export type CheckoutIntent = Readonly<{
  workspaceId: string
  customerId: string
  idempotencyKey: string
  integrationIdentifier: string
  operationReference?: string
  terms: Readonly<{ id: string; monthlyPriceId: string; currency: string; monthlyUnitAmount: number }>
}>

export type CheckoutNavigation = Readonly<{ id: string; url: string; expiresAt: number }>
export type CustomerCreateIntent = Readonly<{ workspaceId: string; idempotencyKey: string }>
export type SubscriptionCancellationIntent = Readonly<{
  subscriptionId: string
  customerId: string
  idempotencyKey: string
}>
export type SubscriptionCancellationObservation = Readonly<{ subscriptionId: string; cancelAtPeriodEnd: true }>

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const customer = /^cus_[A-Za-z0-9]+$/
const price = /^price_[A-Za-z0-9]+$/
const integration = /^[A-Za-z][A-Za-z0-9_-]*_[A-Za-z]{8}$/
const safeKey = /^[A-Za-z0-9:_-]{1,255}$/
const ids = {
  subscription: /^sub_[A-Za-z0-9]+$/,
  invoice: /^in_[A-Za-z0-9]+$/,
  invoicePayment: /^inpay_[A-Za-z0-9]+$/,
  paymentIntent: /^pi_[A-Za-z0-9]+$/,
  charge: /^ch_[A-Za-z0-9]+$/,
  customerBalanceTransaction: /^cbtxn_[A-Za-z0-9]+$/,
  creditNote: /^cn_[A-Za-z0-9]+$/,
  review: /^prv_[A-Za-z0-9]+$/,
  dispute: /^dp_[A-Za-z0-9]+$/,
  earlyFraudWarning: /^issfr_[A-Za-z0-9]+$/,
  lineItem: /^li_[A-Za-z0-9]+$/,
} as const

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id
  return null
}

function requireId(value: string, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) throw new StripeInputError()
}

function requireIntent(intent: CheckoutIntent): void {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new StripeInputError()
  const keys = Object.keys(intent).sort()
  if (keys.join(',') !== (Object.hasOwn(intent, 'operationReference')
    ? 'customerId,idempotencyKey,integrationIdentifier,operationReference,terms,workspaceId'
    : 'customerId,idempotencyKey,integrationIdentifier,terms,workspaceId')) throw new StripeInputError()
  if (Object.hasOwn(intent, 'operationReference')) requireId(intent.operationReference!, uuid)
  requireId(intent.workspaceId, uuid)
  requireId(intent.customerId, customer)
  requireId(intent.idempotencyKey, safeKey)
  requireId(intent.integrationIdentifier, integration)
  if (intent.integrationIdentifier.length > 255) throw new StripeInputError()
  const terms = intent.terms
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)
    || Object.keys(terms).sort().join(',') !== 'currency,id,monthlyPriceId,monthlyUnitAmount'
    || !Number.isSafeInteger(terms.monthlyUnitAmount) || terms.monthlyUnitAmount <= 0
    || !/^[a-z]{3}$/.test(terms.currency)) throw new StripeInputError()
  requireId(terms.id, uuid)
  requireId(terms.monthlyPriceId, price)
}

function requireCustomerIntent(intent: CustomerCreateIntent): void {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || Object.keys(intent).sort().join(',') !== 'idempotencyKey,workspaceId') throw new StripeInputError()
  requireId(intent.workspaceId, uuid)
  requireId(intent.idempotencyKey, safeKey)
}

function requireCancellationIntent(intent: SubscriptionCancellationIntent): void {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || Object.keys(intent).sort().join(',') !== 'customerId,idempotencyKey,subscriptionId') throw new StripeInputError()
  requireId(intent.subscriptionId, ids.subscription)
  requireId(intent.customerId, customer)
  requireId(intent.idempotencyKey, safeKey)
}

export function buildCheckoutParameters(config: StripeConfig, intent: CheckoutIntent): Stripe.Checkout.SessionCreateParams {
  requireIntent(intent)
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: intent.terms.monthlyPriceId, quantity: 1 },
  ]
  return {
    mode: 'subscription',
    ui_mode: 'hosted_page',
    customer: intent.customerId,
    client_reference_id: intent.operationReference ?? intent.workspaceId,
    integration_identifier: intent.integrationIdentifier,
    line_items: lineItems,
    currency: intent.terms.currency,
    subscription_data: { billing_mode: { type: 'flexible' } },
    success_url: `${config.origin}/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.origin}/billing?checkout=cancelled`,
  }
}

function acceptedSession(session: Stripe.Checkout.Session, config: StripeConfig, intent: CheckoutIntent): CheckoutNavigation {
  const expectedId = config.environment === 'sandbox' ? /^cs_test_[A-Za-z0-9]+$/ : /^cs_live_[A-Za-z0-9]+$/
  if (typeof session.id !== 'string' || !expectedId.test(session.id)
    || session.object !== 'checkout.session' || session.mode !== 'subscription'
    || session.livemode !== (config.environment === 'live')
    || session.customer !== intent.customerId || session.client_reference_id !== (intent.operationReference ?? intent.workspaceId)
    || session.status !== 'open' || typeof session.url !== 'string'
    || !Number.isSafeInteger(session.expires_at) || session.expires_at <= Math.floor(Date.now() / 1000)) throw new StripeProviderError()
  let destination: URL
  try { destination = new URL(session.url) }
  catch { throw new StripeProviderError() }
  if (destination.origin !== 'https://checkout.stripe.com'
    || destination.username || destination.password
    || destination.pathname !== `/c/pay/${session.id}`) throw new StripeProviderError()
  return Object.freeze({ id: session.id, url: session.url, expiresAt: session.expires_at })
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try { return await call() }
  catch { throw new StripeProviderError() }
}

export function createStripeBillingClient(config: StripeConfig, signal: AbortSignal, deadlineAtMs: number) {
  const transport = createStripeTransport(config, signal, deadlineAtMs)
  const { stripe } = transport
  const expectedLive = config.environment === 'live'
  const reads = createStripeReadMethods(config, stripe)
  return Object.freeze({
    async retrievePrice(id: string): Promise<Stripe.Price> {
      requireId(id, price)
      return transport.owned(async () => {
        const result = await stripe.prices.retrieve(id)
        if (result.id !== id || result.object !== 'price' || result.livemode !== expectedLive) throw new StripeProviderError()
        return result
      })
    },
    async createCustomer(intent: CustomerCreateIntent): Promise<Readonly<{ id: string }>> {
      requireCustomerIntent(intent)
      return transport.owned(async () => {
        const result = await stripe.customers.create({ metadata: { workspace_id: intent.workspaceId } },
          { idempotencyKey: intent.idempotencyKey })
        if (!customer.test(result.id) || result.object !== 'customer' || result.livemode !== expectedLive) throw new StripeProviderError()
        return Object.freeze({ id: result.id })
      })
    },
    async createCheckout(intent: CheckoutIntent): Promise<CheckoutNavigation> {
      const parameters = buildCheckoutParameters(config, intent)
      return transport.owned(async () => acceptedSession(
        await stripe.checkout.sessions.create(parameters, { idempotencyKey: intent.idempotencyKey }),
        config, intent,
      ))
    },
    async cancelSubscriptionAtPeriodEnd(intent: SubscriptionCancellationIntent): Promise<SubscriptionCancellationObservation> {
      requireCancellationIntent(intent)
      return transport.owned(async () => {
        const result = await stripe.subscriptions.update(intent.subscriptionId,
          { cancel_at_period_end: true }, { idempotencyKey: intent.idempotencyKey })
        if (result.id !== intent.subscriptionId || result.object !== 'subscription'
          || result.customer !== intent.customerId || result.customer_account !== null
          || result.livemode !== expectedLive || result.cancel_at_period_end !== true) throw new StripeProviderError()
        return Object.freeze({ subscriptionId: result.id, cancelAtPeriodEnd: true })
      })
    },
    retrieveSubscription: (id: string) => transport.owned(() => reads.retrieveSubscription(id)),
    retrieveInvoice: (id: string) => transport.owned(() => reads.retrieveInvoice(id)),
    listInvoicePayments: (id: string, cursor?: string) => transport.owned(() => reads.listInvoicePayments(id, cursor)),
    retrievePaymentIntent: (id: string) => transport.owned(() => reads.retrievePaymentIntent(id)),
    retrieveCharge: (id: string) => transport.owned(() => reads.retrieveCharge(id)),
    listCustomerBalanceTransactions: (id: string, cursor?: string) => transport.owned(() => reads.listCustomerBalanceTransactions(id, cursor)),
    close: transport.close,
  })
}

// Concrete SDK composition shared by the original billing client and the
// owned GET client. The original client projects only its existing surface.
export function createStripeReadMethods(config: StripeConfig, stripe: Stripe) {
  const expectedLive = config.environment === 'live'
  const checkout = expectedLive ? /^cs_live_[A-Za-z0-9]+$/ : /^cs_test_[A-Za-z0-9]+$/
  function reference(value: unknown, pattern: RegExp, object: string): string {
    const id = idOf(value)
    if (!id || !pattern.test(id) || value !== null && typeof value === 'object'
      && (!('object' in value) || value.object !== object
        || 'livemode' in value && value.livemode !== expectedLive
        || 'deleted' in value && value.deleted === true)) throw new StripeProviderError()
    return id
  }
  function page<T>(result: Stripe.ApiList<T>, path: string): void {
    if (result.object !== 'list' || result.url !== path || !Array.isArray(result.data)
      || result.data.length > 100 || typeof result.has_more !== 'boolean'
      || result.has_more && result.data.length === 0) throw new StripeProviderError()
  }
  function checkedSession(result: Stripe.Checkout.Session): void {
    if (result.object !== 'checkout.session' || !checkout.test(result.id)
      || result.livemode !== expectedLive || result.mode !== 'subscription'
      || result.customer_account !== null) throw new StripeProviderError()
    reference(result.customer, customer, 'customer')
    if (result.subscription !== null) reference(result.subscription, ids.subscription, 'subscription')
    if (result.invoice !== null) reference(result.invoice, ids.invoice, 'invoice')
  }
  function checkedRisk(result: Stripe.Dispute | Stripe.Radar.EarlyFraudWarning, object: 'dispute' | 'radar.early_fraud_warning'): void {
    const pattern = object === 'dispute' ? ids.dispute : ids.earlyFraudWarning
    if (result.object !== object || !pattern.test(result.id) || result.livemode !== expectedLive) throw new StripeProviderError()
    reference(result.charge, ids.charge, 'charge')
    if (result.payment_intent != null) reference(result.payment_intent, ids.paymentIntent, 'payment_intent')
  }
  return Object.freeze({
    async retrieveSubscription(id: string) {
      requireId(id, ids.subscription)
      return guarded(async () => {
        const result = await stripe.subscriptions.retrieve(id)
        if (result.id !== id || result.object !== 'subscription' || result.livemode !== expectedLive) throw new StripeProviderError()
        return result
      })
    },
    async retrieveInvoice(id: string) {
      requireId(id, ids.invoice)
      return guarded(async () => {
        const result = await stripe.invoices.retrieve(id)
        if (result.id !== id || result.object !== 'invoice' || result.livemode !== expectedLive) throw new StripeProviderError()
        return result
      })
    },
    async listInvoicePayments(invoiceId: string, cursor?: string) {
      requireId(invoiceId, ids.invoice)
      if (cursor !== undefined) requireId(cursor, ids.invoicePayment)
      return guarded(async () => {
        const result = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 100,
          ...(cursor === undefined ? {} : { starting_after: cursor }) })
        if (result.object !== 'list' || !Array.isArray(result.data) || typeof result.has_more !== 'boolean'
          || result.data.some(payment => payment.object !== 'invoice_payment'
            || !ids.invoicePayment.test(payment.id)
            || (typeof payment.invoice === 'string' ? payment.invoice : payment.invoice?.id) !== invoiceId
            || payment.livemode !== expectedLive)) throw new StripeProviderError()
        return result
      })
    },
    async retrievePaymentIntent(id: string) {
      requireId(id, ids.paymentIntent)
      return guarded(async () => {
        const result = await stripe.paymentIntents.retrieve(id)
        if (result.id !== id || result.object !== 'payment_intent' || result.livemode !== expectedLive) throw new StripeProviderError()
        return result
      })
    },
    async retrieveCharge(id: string): Promise<Stripe.Charge> {
      requireId(id, ids.charge)
      return guarded(async () => {
        const result = await stripe.charges.retrieve(id)
        const review = result.review === null ? null : idOf(result.review)
        if (result.id !== id || result.object !== 'charge' || result.livemode !== expectedLive
          || !customer.test(idOf(result.customer) ?? '')
          || !ids.paymentIntent.test(idOf(result.payment_intent) ?? '')
          || !Number.isSafeInteger(result.amount) || result.amount <= 0
          || !Number.isSafeInteger(result.amount_captured) || result.amount_captured < 0
          || result.amount_captured > result.amount
          || !Number.isSafeInteger(result.amount_refunded) || result.amount_refunded < 0
          || result.amount_refunded > result.amount_captured
          || typeof result.captured !== 'boolean' || typeof result.paid !== 'boolean'
          || typeof result.disputed !== 'boolean' || typeof result.refunded !== 'boolean'
          || !/^[a-z]{3}$/.test(result.currency)
          || typeof result.status !== 'string' || result.status.length === 0
          || result.fraud_details === undefined || result.fraud_details !== null
            && (typeof result.fraud_details !== 'object' || Array.isArray(result.fraud_details))
          || result.review === undefined || review !== null && !ids.review.test(review ?? '')
          || result.outcome === undefined || result.outcome !== null
            && (typeof result.outcome.type !== 'string' || result.outcome.type.length === 0
              || result.outcome.reason !== null && typeof result.outcome.reason !== 'string'
              || result.outcome.network_status !== null && typeof result.outcome.network_status !== 'string')) {
          throw new StripeProviderError()
        }
        return result
      })
    },
    async listCustomerBalanceTransactions(customerId: string, cursor?: string) {
      requireId(customerId, customer)
      if (cursor !== undefined) requireId(cursor, ids.customerBalanceTransaction)
      return guarded(async () => {
        const result = await stripe.customers.listBalanceTransactions(customerId, {
          limit: 100, ...(cursor === undefined ? {} : { starting_after: cursor }),
        })
        const expectedCheckout = expectedLive ? /^cs_live_[A-Za-z0-9]+$/ : /^cs_test_[A-Za-z0-9]+$/
        if (result.object !== 'list' || !Array.isArray(result.data) || result.data.length > 100
          || typeof result.has_more !== 'boolean' || result.has_more && result.data.length === 0
          || result.url !== `/v1/customers/${customerId}/balance_transactions`
          || result.data.some(row => row.object !== 'customer_balance_transaction'
            || !ids.customerBalanceTransaction.test(row.id)
            || row.livemode !== expectedLive || idOf(row.customer) !== customerId
            || row.customer_account !== null
            || !Number.isSafeInteger(row.amount) || !Number.isSafeInteger(row.ending_balance)
            || !Number.isSafeInteger(row.created) || row.created < 0
            || !/^[a-z]{3}$/.test(row.currency)
            || typeof row.type !== 'string' || row.type.length === 0
            || row.invoice !== null && !ids.invoice.test(idOf(row.invoice) ?? '')
            || row.checkout_session !== null && !expectedCheckout.test(idOf(row.checkout_session) ?? '')
            || row.credit_note !== null && !ids.creditNote.test(idOf(row.credit_note) ?? ''))) throw new StripeProviderError()
        return result
      })
    },
    async retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session> {
      requireId(id, checkout)
      return guarded(async () => {
        const result = await stripe.checkout.sessions.retrieve(id)
        checkedSession(result)
        if (result.id !== id) throw new StripeProviderError()
        return result
      })
    },
    async listCheckoutSessions(subscriptionId: string, customerId: string, cursor?: string): Promise<Stripe.ApiList<Stripe.Checkout.Session>> {
      requireId(subscriptionId, ids.subscription)
      requireId(customerId, customer)
      if (cursor !== undefined) requireId(cursor, checkout)
      return guarded(async () => {
        const result = await stripe.checkout.sessions.list({ subscription: subscriptionId, customer: customerId,
          limit: 100, ...(cursor === undefined ? {} : { starting_after: cursor }) })
        page(result, '/v1/checkout/sessions')
        for (const row of result.data) {
          checkedSession(row)
          if (idOf(row.subscription) !== subscriptionId || idOf(row.customer) !== customerId) throw new StripeProviderError()
        }
        return result
      })
    },
    async listCheckoutLineItems(sessionId: string, cursor?: string): Promise<Stripe.ApiList<Stripe.LineItem>> {
      requireId(sessionId, checkout)
      if (cursor !== undefined) requireId(cursor, ids.lineItem)
      return guarded(async () => {
        const result = await stripe.checkout.sessions.listLineItems(sessionId, {
          limit: 100, ...(cursor === undefined ? {} : { starting_after: cursor }) })
        page(result, `/v1/checkout/sessions/${sessionId}/line_items`)
        for (const row of result.data) {
          if (row.object !== 'item' || !ids.lineItem.test(row.id)) throw new StripeProviderError()
          reference(row.price, price, 'price')
        }
        return result
      })
    },
    async listInvoicePaymentsForPaymentIntent(paymentIntentId: string, cursor?: string): Promise<Stripe.ApiList<Stripe.InvoicePayment>> {
      requireId(paymentIntentId, ids.paymentIntent)
      if (cursor !== undefined) requireId(cursor, ids.invoicePayment)
      return guarded(async () => {
        const result = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId },
          limit: 100, ...(cursor === undefined ? {} : { starting_after: cursor }) })
        page(result, '/v1/invoice_payments')
        for (const row of result.data) {
          if (row.object !== 'invoice_payment' || !ids.invoicePayment.test(row.id) || row.livemode !== expectedLive
            || row.payment?.type !== 'payment_intent'
            || reference(row.payment.payment_intent, ids.paymentIntent, 'payment_intent') !== paymentIntentId
            || row.payment.charge != null || row.payment.payment_record != null) throw new StripeProviderError()
          reference(row.invoice, ids.invoice, 'invoice')
        }
        return result
      })
    },
    async retrieveDispute(id: string): Promise<Stripe.Dispute> {
      requireId(id, ids.dispute)
      return guarded(async () => {
        const result = await stripe.disputes.retrieve(id)
        checkedRisk(result, 'dispute')
        if (result.id !== id) throw new StripeProviderError()
        return result
      })
    },
    async listDisputes(chargeId: string, cursor?: string): Promise<Stripe.ApiList<Stripe.Dispute>> {
      requireId(chargeId, ids.charge)
      if (cursor !== undefined) requireId(cursor, ids.dispute)
      return guarded(async () => {
        const result = await stripe.disputes.list({ charge: chargeId, limit: 100,
          ...(cursor === undefined ? {} : { starting_after: cursor }) })
        page(result, '/v1/disputes')
        for (const row of result.data) {
          checkedRisk(row, 'dispute')
          if (idOf(row.charge) !== chargeId) throw new StripeProviderError()
        }
        return result
      })
    },
    async retrieveEarlyFraudWarning(id: string): Promise<Stripe.Radar.EarlyFraudWarning> {
      requireId(id, ids.earlyFraudWarning)
      return guarded(async () => {
        const result = await stripe.radar.earlyFraudWarnings.retrieve(id)
        checkedRisk(result, 'radar.early_fraud_warning')
        if (result.id !== id) throw new StripeProviderError()
        return result
      })
    },
    async listEarlyFraudWarnings(chargeId: string, cursor?: string): Promise<Stripe.ApiList<Stripe.Radar.EarlyFraudWarning>> {
      requireId(chargeId, ids.charge)
      if (cursor !== undefined) requireId(cursor, ids.earlyFraudWarning)
      return guarded(async () => {
        const result = await stripe.radar.earlyFraudWarnings.list({ charge: chargeId,
          limit: 100, ...(cursor === undefined ? {} : { starting_after: cursor }) })
        page(result, '/v1/radar/early_fraud_warnings')
        for (const row of result.data) {
          checkedRisk(row, 'radar.early_fraud_warning')
          if (idOf(row.charge) !== chargeId) throw new StripeProviderError()
        }
        return result
      })
    },
  })
}
