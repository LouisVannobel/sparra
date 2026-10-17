import { createHash } from 'node:crypto'
import type Stripe from 'stripe'
import type { StripeConfig } from './stripe-config.server'
import type { UnpaidInvoiceObservation } from './billing-agreement.server'

type MonthlyLine = Pick<Stripe.InvoiceLineItem,
  'id' | 'object' | 'amount' | 'currency' | 'livemode' | 'period' | 'pricing' |
  'quantity' | 'subscription' | 'parent' | 'pretax_credit_amounts'>
type MonthlyInvoice = Pick<Stripe.Invoice,
  'id' | 'object' | 'livemode' | 'customer' | 'customer_account' | 'parent' |
  'billing_reason' | 'collection_method' | 'currency' | 'status' | 'amount_due' |
  'amount_paid' | 'amount_remaining' | 'amount_overpaid' | 'total' |
  'starting_balance' | 'ending_balance' | 'pre_payment_credit_notes_amount' |
  'post_payment_credit_notes_amount' | 'period_start' | 'period_end' |
  'amount_paid_off_stripe' | 'total_pretax_credit_amounts'> & {
    lines: { object: 'list'; data: MonthlyLine[]; has_more: boolean }
  }
type InvoiceAllocation = Pick<Stripe.InvoicePayment,
  'id' | 'object' | 'invoice' | 'livemode' | 'currency' | 'amount_requested' |
  'amount_paid' | 'status' | 'status_transitions' | 'payment' | 'is_default' | 'created'>
type CapturedIntent = Pick<Stripe.PaymentIntent,
  'id' | 'object' | 'livemode' | 'customer' | 'amount' | 'amount_received' |
  'currency' | 'status' | 'latest_charge'>
type CapturedCharge = Pick<Stripe.Charge,
  'id' | 'object' | 'livemode' | 'customer' | 'amount' | 'amount_captured' |
  'amount_refunded' | 'captured' | 'currency' | 'disputed' | 'paid' |
  'payment_intent' | 'refunded' | 'status' | 'fraud_details' | 'review' | 'outcome'>
type BalanceTransaction = Pick<Stripe.CustomerBalanceTransaction,
  'id' | 'object' | 'amount' | 'checkout_session' | 'created' | 'credit_note' |
  'currency' | 'customer' | 'customer_account' | 'ending_balance' | 'invoice' |
  'livemode' | 'type'>

export type MonetaryProvider = Readonly<{
  retrieveInvoice(id: string): Promise<MonthlyInvoice>
  listInvoicePayments(invoiceId: string, cursor?: string): Promise<{
    object: 'list'; data: InvoiceAllocation[]; has_more: boolean
  }>
  listCustomerBalanceTransactions(customerId: string, cursor?: string): Promise<{
    object: 'list'; data: BalanceTransaction[]; has_more: boolean
  }>
  retrievePaymentIntent(id: string): Promise<CapturedIntent>
  retrieveCharge(id: string): Promise<CapturedCharge>
}>
export type BoundMonthlyInvoice = Readonly<{
  environment: 'sandbox' | 'live'; accountId: string; customerId: string
  subscriptionId: string; invoiceId: string; monthlyPriceId: string
  currency: string; expectedAmount: number; periodStart: number; periodEnd: number
  firstPeriod?: boolean
  onboarding?: Readonly<{ priceId: string; amount: number }> | null
}>
export type PaidMonthlyInvoiceProof = Readonly<{
  invoiceId: string; subscriptionId: string; customerId: string; currency: string
  amount: number; periodStart: number; periodEnd: number
  allocationIds: readonly string[]; paymentIntentIds: readonly string[]; chargeIds: readonly string[]
}>

export class BillingMonetaryError extends Error {
  constructor() { super('Billing monetary proof unavailable'); this.name = 'BillingMonetaryError' }
}

const invoiceId = /^in_[A-Za-z0-9]+$/
const customerId = /^cus_[A-Za-z0-9]+$/
const subscriptionId = /^sub_[A-Za-z0-9]+$/
const priceId = /^price_[A-Za-z0-9]+$/
const allocationId = /^inpay_[A-Za-z0-9]+$/
const balanceTransactionId = /^cbtxn_[A-Za-z0-9]+$/
const intentId = /^pi_[A-Za-z0-9]+$/
const chargeId = /^ch_[A-Za-z0-9]+$/
const creditNoteId = /^cn_[A-Za-z0-9]+$/
const checkoutId = { sandbox: /^cs_test_[A-Za-z0-9]+$/, live: /^cs_live_[A-Za-z0-9]+$/ } as const
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const zero = (value: number): boolean => Number.isSafeInteger(value) && value === 0
function fail(): never { throw new BillingMonetaryError() }
const idOf = (value: unknown): string | null => typeof value === 'string' ? value
  : value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : null

function requireBound(config: StripeConfig, bound: BoundMonthlyInvoice): void {
  if (bound.environment !== config.environment || bound.accountId !== config.accountId
    || bound.monthlyPriceId !== config.monthlyPriceId || !customerId.test(bound.customerId)
    || !subscriptionId.test(bound.subscriptionId) || !invoiceId.test(bound.invoiceId)
    || !priceId.test(bound.monthlyPriceId) || !/^[a-z]{3}$/.test(bound.currency)
    || !positive(bound.expectedAmount) || !positive(bound.periodStart)
    || !positive(bound.periodEnd) || bound.periodEnd <= bound.periodStart
    || config.onboardingPriceId === null && bound.onboarding != null
    || config.onboardingPriceId !== null && typeof bound.firstPeriod !== 'boolean'
    || bound.onboarding != null && (bound.onboarding.priceId !== config.onboardingPriceId
      || bound.onboarding.priceId === bound.monthlyPriceId || !positive(bound.onboarding.amount))
    || config.onboardingPriceId !== null && bound.firstPeriod === true && bound.onboarding == null
    || !positive(bound.expectedAmount - (bound.firstPeriod ? bound.onboarding?.amount ?? 0 : 0))) fail()
}

function checkedInvoice(invoice: MonthlyInvoice, bound: BoundMonthlyInvoice, expectedLive: boolean, unpaid = false): string {
  const onboarding = bound.firstPeriod ? bound.onboarding : null
  const monthlyAmount = bound.expectedAmount - (onboarding?.amount ?? 0)
  if (invoice.id !== bound.invoiceId || invoice.object !== 'invoice' || invoice.livemode !== expectedLive
    || idOf(invoice.customer) !== bound.customerId || invoice.customer_account !== null
    || invoice.parent?.type !== 'subscription_details'
    || idOf(invoice.parent.subscription_details?.subscription) !== bound.subscriptionId
    || invoice.billing_reason !== 'subscription_cycle' && invoice.billing_reason !== 'subscription_create'
    || invoice.collection_method !== 'charge_automatically'
    || bound.firstPeriod !== undefined && invoice.billing_reason !== (bound.firstPeriod ? 'subscription_create' : 'subscription_cycle')
    || invoice.currency !== bound.currency
    || (unpaid ? invoice.status !== 'open' && invoice.status !== 'uncollectible' : invoice.status !== 'paid')
    || !positive(invoice.amount_due) || invoice.amount_due !== bound.expectedAmount
    || invoice.amount_paid !== (unpaid ? 0 : bound.expectedAmount) || invoice.total !== bound.expectedAmount
    || invoice.amount_remaining !== (unpaid ? bound.expectedAmount : 0) || !zero(invoice.amount_overpaid)
    || !zero(invoice.starting_balance) || invoice.ending_balance !== 0
    || !zero(invoice.pre_payment_credit_notes_amount)
    || !zero(invoice.post_payment_credit_notes_amount)
    || invoice.amount_paid_off_stripe !== undefined && !zero(invoice.amount_paid_off_stripe)
    || unpaid && invoice.amount_paid_off_stripe === undefined
    || !Array.isArray(invoice.total_pretax_credit_amounts)
    || invoice.total_pretax_credit_amounts.length !== 0
    || !Number.isSafeInteger(invoice.period_start) || invoice.period_start < 0
    || !Number.isSafeInteger(invoice.period_end) || invoice.period_end < invoice.period_start
    || invoice.lines?.object !== 'list' || invoice.lines.has_more !== false
    || !Array.isArray(invoice.lines.data) || invoice.lines.data.length !== (onboarding ? 2 : 1)) fail()

  const line = invoice.lines.data.find(row => idOf(row.pricing?.price_details?.price) === bound.monthlyPriceId)
  const subscriptionItem = line?.parent?.subscription_item_details
  if (!line || line.object !== 'line_item' || line.livemode !== expectedLive
    || line.currency !== bound.currency || line.amount !== monthlyAmount
    || line.quantity !== 1 || idOf(line.subscription) !== bound.subscriptionId
    || line.period?.start !== bound.periodStart || line.period.end !== bound.periodEnd
    || line.parent?.type !== 'subscription_item_details'
    || idOf(subscriptionItem?.subscription) !== bound.subscriptionId
    || subscriptionItem?.proration !== false
    || line.pricing?.type !== 'price_details'
    || idOf(line.pricing.price_details?.price) !== bound.monthlyPriceId
    || !Array.isArray(line.pretax_credit_amounts) || line.pretax_credit_amounts.length !== 0) fail()

  const extra = onboarding ? invoice.lines.data.find(row => row.id !== line.id) : undefined
  if (onboarding && (!extra || extra.object !== 'line_item' || extra.livemode !== expectedLive
    || extra.currency !== bound.currency || extra.amount !== onboarding.amount || extra.quantity !== 1
    || idOf(extra.subscription) !== bound.subscriptionId || extra.parent?.type !== 'invoice_item_details'
    || extra.parent.invoice_item_details?.proration !== false
    || idOf(extra.parent.invoice_item_details.subscription) !== bound.subscriptionId
    || extra.pricing?.type !== 'price_details' || idOf(extra.pricing.price_details?.price) !== onboarding.priceId
    || !Array.isArray(extra.pretax_credit_amounts) || extra.pretax_credit_amounts.length !== 0
    || !Number.isSafeInteger(extra.period.start) || !Number.isSafeInteger(extra.period.end)
    || extra.period.start < 0 || extra.period.end < extra.period.start)) fail()

  // Compare values rather than the provider object's identity. A second
  // response can be a different allocation or line snapshot for the same ID.
  return JSON.stringify({
    id: invoice.id, customer: bound.customerId, subscription: bound.subscriptionId,
    billingReason: invoice.billing_reason, amount: invoice.amount_paid, currency: invoice.currency,
    invoiceWindowStart: invoice.period_start, invoiceWindowEnd: invoice.period_end,
    servicePeriodStart: bound.periodStart, servicePeriodEnd: bound.periodEnd,
    lineId: line.id, lineAmount: line.amount, linePeriod: line.period,
    price: bound.monthlyPriceId, amountPaidOffStripe: invoice.amount_paid_off_stripe ?? 0,
    status: invoice.status, remaining: invoice.amount_remaining,
    onboarding: extra ? { id: extra.id, amount: extra.amount, period: extra.period,
      price: onboarding!.priceId, invoiceItem: extra.parent?.invoice_item_details?.invoice_item } : null,
  })
}

function checkedAllocation(payment: InvoiceAllocation, bound: BoundMonthlyInvoice, expectedLive: boolean) {
  const amount = payment.amount_paid
  const paidAt = payment.status_transitions?.paid_at
  const piId = payment.payment?.payment_intent
  if (typeof amount !== 'number' || typeof paidAt !== 'number' || typeof piId !== 'string') fail()
  if (payment.object !== 'invoice_payment' || !allocationId.test(payment.id)
    || idOf(payment.invoice) !== bound.invoiceId || payment.livemode !== expectedLive
    || payment.currency !== bound.currency || payment.status !== 'paid'
    || !positive(amount) || payment.amount_requested !== amount
    || !Number.isSafeInteger(payment.created) || payment.created < 0
    || !Number.isSafeInteger(paidAt) || paidAt < 0
    || payment.status_transitions.canceled_at !== null
    || payment.payment?.type !== 'payment_intent'
    || !intentId.test(piId)
    || payment.payment.charge != null || payment.payment.payment_record != null) fail()
  return {
    id: payment.id, invoiceId: bound.invoiceId, amount,
    currency: payment.currency, paymentIntentId: piId,
    created: payment.created, paidAt,
    isDefault: payment.is_default,
  }
}

async function allocations(provider: MonetaryProvider, bound: BoundMonthlyInvoice, expectedLive: boolean) {
  const all: ReturnType<typeof checkedAllocation>[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await provider.listInvoicePayments(bound.invoiceId, cursor)
    if (page?.object !== 'list' || !Array.isArray(page.data) || page.data.length > 100
      || typeof page.has_more !== 'boolean' || page.has_more && page.data.length === 0) fail()
    for (const payment of page.data) {
      const fact = checkedAllocation(payment, bound, expectedLive)
      if (seen.has(fact.id)) fail()
      seen.add(fact.id)
      all.push(fact)
    }
    if (!page.has_more) {
      if (all.length === 0) fail()
      return all.sort((a, b) => a.id.localeCompare(b.id))
    }
    const next = all.at(-1)?.id
    if (!next || next === cursor || seen.size > 500) fail()
    cursor = next
  }
  return fail()
}

function checkedBalanceTransaction(row: BalanceTransaction, bound: BoundMonthlyInvoice, expectedLive: boolean) {
  const invoice = idOf(row.invoice), checkout = idOf(row.checkout_session), creditNote = idOf(row.credit_note)
  if (row.object !== 'customer_balance_transaction' || !balanceTransactionId.test(row.id)
    || row.livemode !== expectedLive || idOf(row.customer) !== bound.customerId
    || row.customer_account !== null || !Number.isSafeInteger(row.amount)
    || !Number.isSafeInteger(row.ending_balance)
    || !Number.isSafeInteger(row.created) || row.created < 0
    || !/^[a-z]{3}$/.test(row.currency) || typeof row.type !== 'string' || row.type.length === 0
    || row.invoice !== null && (!invoice || !invoiceId.test(invoice))
    || row.checkout_session !== null && (!checkout || !checkoutId[bound.environment].test(checkout))
    || row.credit_note !== null && (!creditNote || !creditNoteId.test(creditNote))) fail()

  // Even an unapplied/reversed entry is a relevant credit-history fact.
  // Without an Invoice reference, these application types cannot be proved
  // unrelated to the invoice under reconciliation.
  if (invoice === bound.invoiceId || invoice === null && (
    row.type !== 'adjustment' && row.type !== 'initial' && row.type !== 'migration'
    || checkout !== null || creditNote !== null)) fail()
  return {
    id: row.id, type: row.type, amount: row.amount, endingBalance: row.ending_balance,
    created: row.created, currency: row.currency, customer: bound.customerId,
    customerAccount: row.customer_account, livemode: row.livemode,
    invoice, checkout, creditNote,
  }
}

async function customerBalance(provider: MonetaryProvider, bound: BoundMonthlyInvoice, expectedLive: boolean) {
  const all: ReturnType<typeof checkedBalanceTransaction>[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await provider.listCustomerBalanceTransactions(bound.customerId, cursor)
    if (page?.object !== 'list' || !Array.isArray(page.data) || page.data.length > 100
      || typeof page.has_more !== 'boolean' || page.has_more && page.data.length === 0) fail()
    for (const row of page.data) {
      const fact = checkedBalanceTransaction(row, bound, expectedLive)
      if (seen.has(fact.id)) fail()
      seen.add(fact.id)
      all.push(fact)
    }
    if (!page.has_more) return all.sort((a, b) => a.id.localeCompare(b.id))
    const next = all.at(-1)?.id
    if (!next || next === cursor) fail()
    cursor = next
  }
  return fail()
}

function digest(facts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

function safeChargeOutcome(charge: CapturedCharge): boolean {
  if (charge.review !== null) return false
  const outcome = charge.outcome
  if (outcome === null) return true
  if (!outcome || outcome.type !== 'authorized'
    || outcome.network_status === 'declined_by_network'
    || outcome.network_status === 'reversed_after_approval'
    || outcome.risk_level !== undefined && outcome.risk_level !== 'normal'
      && outcome.risk_level !== 'not_assessed'
    || outcome.reason !== null && outcome.reason !== 'rule') return false
  return true
}

export async function provePaidMonthlyInvoice(config: StripeConfig, provider: MonetaryProvider,
  bound: BoundMonthlyInvoice): Promise<PaidMonthlyInvoiceProof> {
  requireBound(config, bound)
  const expectedLive = config.environment === 'live'
  const firstInvoice = checkedInvoice(await provider.retrieveInvoice(bound.invoiceId), bound, expectedLive)
  const firstAllocations = await allocations(provider, bound, expectedLive)
  const secondInvoice = checkedInvoice(await provider.retrieveInvoice(bound.invoiceId), bound, expectedLive)
  const secondAllocations = await allocations(provider, bound, expectedLive)
  if (firstInvoice !== secondInvoice || digest(firstAllocations) !== digest(secondAllocations)) fail()
  const firstBalance = await customerBalance(provider, bound, expectedLive)

  let sum = 0
  const paymentIntentIds: string[] = [], chargeIds: string[] = []
  const seenIntents = new Set<string>(), seenCharges = new Set<string>()
  for (const allocation of secondAllocations) {
    const allocationPiId = allocation.paymentIntentId
    const allocationAmount = allocation.amount
    const pi = await provider.retrievePaymentIntent(allocationPiId)
    const latestChargeId = pi.latest_charge
    if (typeof latestChargeId !== 'string' || !chargeId.test(latestChargeId)) fail()
    if (pi.id !== allocationPiId || pi.object !== 'payment_intent'
      || pi.livemode !== expectedLive || idOf(pi.customer) !== bound.customerId
      || pi.currency !== bound.currency || pi.status !== 'succeeded'
      || pi.amount !== allocationAmount || pi.amount_received !== allocationAmount
      || seenIntents.has(pi.id)) fail()
    const charge = await provider.retrieveCharge(latestChargeId)
    if (charge.id !== latestChargeId || charge.object !== 'charge'
      || charge.livemode !== expectedLive || idOf(charge.customer) !== bound.customerId
      || charge.currency !== bound.currency || charge.status !== 'succeeded'
      || charge.amount !== allocationAmount || charge.amount_captured !== allocationAmount
      || charge.captured !== true || charge.paid !== true
      || !zero(charge.amount_refunded) || charge.refunded !== false || charge.disputed !== false
      || idOf(charge.payment_intent) !== pi.id || seenCharges.has(charge.id)
      || !safeChargeOutcome(charge)
      || charge.fraud_details !== null && (charge.fraud_details.stripe_report !== undefined
        || charge.fraud_details.user_report !== undefined && charge.fraud_details.user_report !== 'safe')) fail()
    sum += allocationAmount
    if (!Number.isSafeInteger(sum) || sum > bound.expectedAmount) fail()
    seenIntents.add(pi.id); seenCharges.add(charge.id)
    paymentIntentIds.push(pi.id); chargeIds.push(charge.id)
  }
  if (sum !== bound.expectedAmount) fail()
  const secondBalance = await customerBalance(provider, bound, expectedLive)
  if (digest(firstBalance) !== digest(secondBalance)) fail()
  return Object.freeze({
    invoiceId: bound.invoiceId, subscriptionId: bound.subscriptionId,
    customerId: bound.customerId, currency: bound.currency,
    amount: sum, periodStart: bound.periodStart, periodEnd: bound.periodEnd,
    allocationIds: Object.freeze(secondAllocations.map(payment => payment.id)),
    paymentIntentIds: Object.freeze(paymentIntentIds), chargeIds: Object.freeze(chargeIds),
  })
}

async function unpaidAllocations(provider: MonetaryProvider, bound: BoundMonthlyInvoice, live: boolean) {
  const all: Array<{ id: string; paymentIntentId: string; amount: number; status: 'open' | 'canceled';
    created: number; canceledAt: number | null; isDefault: boolean }> = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let count = 0; count < 5; count++) {
    const page = await provider.listInvoicePayments(bound.invoiceId, cursor)
    if (page.object !== 'list' || !Array.isArray(page.data) || page.data.length > 100
      || typeof page.has_more !== 'boolean' || page.has_more && page.data.length === 0) fail()
    for (const payment of page.data) {
      const intent = payment.payment?.payment_intent, canceledAt = payment.status_transitions?.canceled_at
      if (payment.object !== 'invoice_payment' || !allocationId.test(payment.id) || seen.has(payment.id)
        || idOf(payment.invoice) !== bound.invoiceId || payment.livemode !== live || payment.currency !== bound.currency
        || payment.status !== 'open' && payment.status !== 'canceled' || payment.amount_paid !== 0
        || !positive(payment.amount_requested) || payment.amount_requested > bound.expectedAmount
        || payment.status_transitions?.paid_at !== null
        || payment.status === 'open' && canceledAt !== null
        || payment.status === 'canceled' && (typeof canceledAt !== 'number' || !positive(canceledAt))
        || !Number.isSafeInteger(payment.created) || payment.created < 0 || typeof payment.is_default !== 'boolean'
        || payment.payment?.type !== 'payment_intent' || typeof intent !== 'string' || !intentId.test(intent)
        || payment.payment.charge != null || payment.payment.payment_record != null) fail()
      seen.add(payment.id)
      all.push({ id: payment.id, paymentIntentId: intent, amount: payment.amount_requested, status: payment.status,
        created: payment.created, canceledAt, isDefault: payment.is_default })
    }
    if (!page.has_more) return all.sort((a, b) => a.id.localeCompare(b.id))
    const next = page.data.at(-1)?.id
    if (!next || next === cursor) fail()
    cursor = next
  }
  return fail()
}

export async function proveUnpaidMonthlyInvoice(config: StripeConfig, provider: MonetaryProvider,
  bound: BoundMonthlyInvoice): Promise<UnpaidInvoiceObservation> {
  requireBound(config, bound)
  const live = config.environment === 'live'
  const invoice = await provider.retrieveInvoice(bound.invoiceId)
  const first = checkedInvoice(invoice, bound, live, true)
  const firstAllocations = await unpaidAllocations(provider, bound, live)
  const second = checkedInvoice(await provider.retrieveInvoice(bound.invoiceId), bound, live, true)
  const secondAllocations = await unpaidAllocations(provider, bound, live)
  if (first !== second || digest(firstAllocations) !== digest(secondAllocations)) fail()
  const firstBalance = await customerBalance(provider, bound, live)
  const intents: unknown[] = [], seen = new Set<string>()
  for (const allocation of secondAllocations) {
    if (seen.has(allocation.paymentIntentId)) fail()
    seen.add(allocation.paymentIntentId)
    const pi = await provider.retrievePaymentIntent(allocation.paymentIntentId)
    if (pi.object !== 'payment_intent' || pi.id !== allocation.paymentIntentId || pi.livemode !== live
      || idOf(pi.customer) !== bound.customerId || pi.currency !== bound.currency || pi.amount !== allocation.amount
      || pi.amount_received !== 0 || !['requires_payment_method', 'requires_confirmation', 'requires_action', 'canceled'].includes(pi.status)
      || allocation.status === 'canceled' && pi.status !== 'canceled') fail()
    let observedCharge: CapturedCharge | null = null
    if (pi.latest_charge !== null) {
      if (typeof pi.latest_charge !== 'string' || !chargeId.test(pi.latest_charge)) fail()
      observedCharge = await provider.retrieveCharge(pi.latest_charge)
      if (observedCharge.id !== pi.latest_charge || observedCharge.object !== 'charge' || observedCharge.livemode !== live
        || idOf(observedCharge.customer) !== bound.customerId || idOf(observedCharge.payment_intent) !== pi.id
        || observedCharge.currency !== bound.currency || observedCharge.amount !== pi.amount
        || observedCharge.amount_captured !== 0 || observedCharge.amount_refunded !== 0
        || observedCharge.captured !== false || observedCharge.paid !== false || observedCharge.refunded !== false) fail()
    }
    intents.push({ id: pi.id, status: pi.status, amount: pi.amount, received: pi.amount_received,
      chargeId: observedCharge?.id ?? null, captured: observedCharge?.amount_captured ?? 0 })
  }
  const secondBalance = await customerBalance(provider, bound, live)
  if (digest(firstBalance) !== digest(secondBalance) || invoice.status !== 'open' && invoice.status !== 'uncollectible') fail()
  const status: UnpaidInvoiceObservation['status'] = invoice.status === 'open' ? 'open' : 'uncollectible'
  return Object.freeze({ kind: 'unpaid-invoice', invoiceId: bound.invoiceId, customerId: bound.customerId,
    subscriptionId: bound.subscriptionId, currency: bound.currency, status,
    amountDue: bound.expectedAmount, amountPaid: 0, amountRemaining: bound.expectedAmount,
    periodStart: bound.periodStart, periodEnd: bound.periodEnd,
    invoicePaymentIds: Object.freeze(secondAllocations.map(value => value.id)),
    observationDigest: digest([first, secondAllocations, secondBalance, intents]) })
}
