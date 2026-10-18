import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import { expect, test } from 'vitest'
import { proveBillingLineage, type LineageProvider, type ObservedBillingLineage } from '../../src/modules/billing/lineage.server'
import { provePaidMonthlyInvoice, proveUnpaidMonthlyInvoice, type BoundMonthlyInvoice, type MonetaryProvider } from '../../src/modules/billing/reconcile.server'
import { config, checkoutOperation, customer, termsA, termsB } from '../helpers/billing-fixtures'
import * as f from '../helpers/billing-provider-fixtures'
import type { billingCustomer, billingOperation } from '../../src/modules/billing/schema.server'
import { buildCheckoutParameters } from '../../src/modules/billing/stripe.server'

function provider(open = false) {
  // SAFETY: these frozen synthetic read fixtures contain every field consumed by lineage and monetary proof; no runtime adapter is installed.
  return { async retrieveInvoice() { return structuredClone(f.invoice) }, async retrieveSubscription() { return structuredClone(f.subscription) },
    async retrieveCheckoutSession() { return open ? { ...f.session, status: 'open', subscription: null, invoice: null } : structuredClone(f.session) },
    async listCheckoutSessions() { return f.list('/v1/checkout/sessions', [open ? { ...f.session, status: 'open', subscription: null, invoice: null } : f.session]) },
    async listCheckoutLineItems() { return f.list('/v1/checkout/sessions/cs_test_fixture123/line_items', [f.line]) },
    async listInvoicePayments() { return f.list('/v1/invoice_payments', [f.allocation]) }, async retrievePaymentIntent() { return structuredClone(f.pi) },
    async retrieveCharge() { return structuredClone(f.charge) }, async listCustomerBalanceTransactions() { return f.list('/v1/customers/cus_fixture/balance_transactions', []) },
  } as LineageProvider & MonetaryProvider
}
test('UNKNOWN operation A with a completed Session and invoice remains provable after a later agreement and archived Price A', async () => {
  expect(f.price.active).toBe(false)
  const lineage = await proveBillingLineage(config, provider(), checkoutOperation, customer, 'in_fixture123', termsA)
  expect(lineage.boundInvoice).toMatchObject({ agreedTermsId: termsA.id, monthlyPriceId: 'price_negotiatedA', expectedAmount: 1500, currency: 'eur' })
  expect(await provePaidMonthlyInvoice(config, provider(), lineage.boundInvoice)).toMatchObject({ amount: 1500, invoiceId: 'in_fixture123' })
})
test('lineage rejects substituting latest agreement B for the immutable operation A', async () => {
  await expect(proveBillingLineage(config, provider(), checkoutOperation, customer, 'in_fixture123', termsB)).rejects.toThrow()
})
test('UNKNOWN Session still open without a subscription and invoice is unresolved', async () => {
  const client = provider(true)
  await expect(proveBillingLineage(config, client, checkoutOperation, customer, 'in_fixture123', termsA)).rejects.toThrow()
})

const unrelatedAdjustment: Awaited<ReturnType<MonetaryProvider['listCustomerBalanceTransactions']>>['data'][number] = {
  id: 'cbtxn_adjustment', object: 'customer_balance_transaction', customer: 'cus_fixture', customer_account: null,
  livemode: false, currency: 'eur', amount: -200, ending_balance: -200, created: 1793491300,
  type: 'adjustment', invoice: null, checkout_session: null, credit_note: null,
}

test.each([
  { label: 'a credit applied to this invoice', balance: { ...unrelatedAdjustment, type: 'applied_to_invoice', invoice: 'in_fixture123' } },
  { label: 'another customer balance', balance: { ...unrelatedAdjustment, customer: 'cus_other' } },
])('monthly paid proof refuses $label despite a succeeded payment', async ({ balance }) => {
  const client = provider()
  const lineage = await proveBillingLineage(config, client, checkoutOperation, customer, 'in_fixture123', termsA)
  const withBalance: MonetaryProvider = { ...client, async listCustomerBalanceTransactions() {
    return f.list('/v1/customers/cus_fixture/balance_transactions', [balance])
  } }
  await expect(provePaidMonthlyInvoice(config, withBalance, lineage.boundInvoice)).rejects.toThrow('Billing monetary proof unavailable')
})

test('monthly paid proof refuses a newly observed customer adjustment during captured-payment verification', async () => {
  const client = provider()
  const lineage = await proveBillingLineage(config, client, checkoutOperation, customer, 'in_fixture123', termsA)
  let balanceRead = 0
  const withChangingBalance: MonetaryProvider = { ...client, async listCustomerBalanceTransactions() {
    const rows = [unrelatedAdjustment]
    if (balanceRead++ > 0) rows.unshift({ ...unrelatedAdjustment, id: 'cbtxn_later', amount: 200, ending_balance: 0, created: 1793491301 })
    return f.list('/v1/customers/cus_fixture/balance_transactions', rows)
  } }
  await expect(provePaidMonthlyInvoice(config, withChangingBalance, lineage.boundInvoice)).rejects.toThrow('Billing monetary proof unavailable')
  expect(balanceRead).toBe(2)
})
const originalBound: BoundMonthlyInvoice = {
  environment: 'sandbox', accountId: 'acct_fixture', customerId: 'cus_fixture', subscriptionId: 'sub_fixture123',
  invoiceId: 'in_fixture123', agreedTermsId: termsA.id, monthlyPriceId: 'price_negotiatedA', currency: 'eur',
  expectedAmount: 1500, periodStart: 1790812800, periodEnd: 1793491200, firstPeriod: true, onboarding: null,
}
const originalLineage: ObservedBillingLineage = {
  operationId: checkoutOperation.id, workspaceId: checkoutOperation.workspaceId, environment: 'sandbox', accountId: 'acct_fixture',
  customerId: 'cus_fixture', checkoutSessionId: 'cs_test_fixture123', subscriptionId: 'sub_fixture123', invoiceId: 'in_fixture123',
  boundInvoice: originalBound,
}
const originalPaidProof = {
  invoiceId: 'in_fixture123', subscriptionId: 'sub_fixture123', customerId: 'cus_fixture', currency: 'eur', amount: 1500,
  periodStart: 1790812800, periodEnd: 1793491200, allocationIds: ['inpay_fixture123'],
  paymentIntentIds: ['pi_fixture123'], chargeIds: ['ch_fixture123'],
}

function lineageInputs() {
  const operation: typeof billingOperation.$inferSelect = { ...checkoutOperation }
  const customerInput: typeof billingCustomer.$inferSelect = { ...customer }
  return { config: { ...config }, operation, customer: customerInput, terms: { ...termsA } }
}

function holdFirstInvoice(client: LineageProvider & MonetaryProvider) {
  let release!: () => void, entered!: () => void, first = true
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const requests: string[] = []
  const observed: LineageProvider & MonetaryProvider = {
    async retrieveInvoice(id) {
      requests.push(`invoice:${id}`)
      if (first) { first = false; entered(); await gate }
      return client.retrieveInvoice(id)
    },
    retrieveSubscription(id) { requests.push(`subscription:${id}`); return client.retrieveSubscription(id) },
    retrieveCheckoutSession(id) { requests.push(`checkout:${id}`); return client.retrieveCheckoutSession(id) },
    listCheckoutSessions(subscriptionId, customerId, cursor) {
      requests.push(`sessions:${subscriptionId}:${customerId}:${cursor ?? ''}`)
      return client.listCheckoutSessions(subscriptionId, customerId, cursor)
    },
    listCheckoutLineItems(id, cursor) { requests.push(`lines:${id}:${cursor ?? ''}`); return client.listCheckoutLineItems(id, cursor) },
    listInvoicePayments(id, cursor) { requests.push(`allocations:${id}:${cursor ?? ''}`); return client.listInvoicePayments(id, cursor) },
    listCustomerBalanceTransactions(id, cursor) {
      requests.push(`balance:${id}:${cursor ?? ''}`)
      return client.listCustomerBalanceTransactions(id, cursor)
    },
    retrievePaymentIntent(id) { requests.push(`intent:${id}`); return client.retrievePaymentIntent(id) },
    retrieveCharge(id) { requests.push(`charge:${id}`); return client.retrieveCharge(id) },
  }
  return { client: observed, started, release, requests }
}

const lineageMutations: ReadonlyArray<{ label: string; mutate(input: ReturnType<typeof lineageInputs>): void }> = [
  { label: 'operation identity', mutate(input) {
    input.operation.id = '11111111-1111-4111-8111-111111111111'
    input.operation.workspaceId = '22222222-2222-4222-8222-222222222222'
  } },
  { label: 'config and agreement identity', mutate(input) {
    input.config.environment = 'live'; input.config.accountId = 'acct_alias'; input.config.origin = 'https://alias.example.invalid'
    input.terms.id = termsB.id; input.terms.monthlyPriceId = termsB.monthlyPriceId; input.terms.monthlyUnitAmount = termsB.monthlyUnitAmount
  } },
  { label: 'monthly operation scalars', mutate(input) {
    input.operation.monthlyPriceId = termsB.monthlyPriceId; input.operation.monthlyUnitAmount = termsB.monthlyUnitAmount
    input.operation.currency = 'usd'; input.operation.integrationIdentifier = 'alias_ABCDEFGH'
  } },
  { label: 'known subscription and completed Session', mutate(input) {
    input.customer.knownSubscriptionId = 'sub_alias'; input.customer.stripeCustomerId = 'cus_alias'
    input.operation.stripeObjectId = 'cs_test_alias'
  } },
  { label: 'forbidden onboarding alias', mutate(input) { input.operation.onboardingPriceId = 'price_alias' } },
]

test.each(lineageMutations)('lineage owns $label before its first provider await', async ({ mutate }) => {
  const input = lineageInputs(), held = holdFirstInvoice(provider())
  const pending = proveBillingLineage(input.config, held.client, input.operation, input.customer, 'in_fixture123', input.terms)
  try {
    await Promise.race([held.started, pending.then(() => { throw new Error('Lineage completed before the invoice barrier') })])
    mutate(input); held.release()
    expect(await pending).toEqual(originalLineage)
    expect(held.requests).toEqual(['invoice:in_fixture123', 'subscription:sub_fixture123',
      'sessions:sub_fixture123:cus_fixture:', 'checkout:cs_test_fixture123', 'lines:cs_test_fixture123:'])
  } finally { held.release(); await pending.catch(() => undefined) }
})

function unpaidProvider(status: 'open' | 'canceled'): LineageProvider & MonetaryProvider {
  const client = provider()
  return {
    ...client,
    async retrieveInvoice(id) {
      const invoice = await client.retrieveInvoice(id)
      return { ...invoice, status: 'open', amount_paid: 0, amount_remaining: 1500 }
    },
    async listInvoicePayments(id, cursor) {
      const page = await client.listInvoicePayments(id, cursor)
      return { ...page, data: page.data.map(payment => ({ ...payment, status, amount_paid: null,
        status_transitions: { paid_at: null, canceled_at: status === 'canceled' ? 1790812802 : null } })) }
    },
    async retrievePaymentIntent(id) {
      const intent = await client.retrievePaymentIntent(id)
      return { ...intent, status: status === 'canceled' ? 'canceled' : 'requires_payment_method', amount_received: 0, latest_charge: null }
    },
  }
}

const monetaryMutations: ReadonlyArray<{ label: string; mutate(bound: ReturnType<typeof mutableBound>): void }> = [
  { label: 'identity', mutate(bound) {
    bound.invoiceId = 'in_alias'; bound.customerId = 'cus_alias'; bound.subscriptionId = 'sub_alias'
  } },
  { label: 'monthly amount and period', mutate(bound) {
    bound.monthlyPriceId = 'price_alias'; bound.currency = 'usd'; bound.expectedAmount = 2900
    bound.periodStart = 1793491200; bound.periodEnd = 1796083200
  } },
  { label: 'first-period witness', mutate(bound) { bound.firstPeriod = false } },
  { label: 'forbidden onboarding alias', mutate(bound) { bound.onboarding = { priceId: 'price_alias', amount: 0 } } },
]
function mutableBound() { return { ...originalBound } }

test.each(monetaryMutations)('paid proof owns bound $label before its first provider await', async ({ mutate }) => {
  const bound = mutableBound(), held = holdFirstInvoice(provider())
  const pending = provePaidMonthlyInvoice({ ...config }, held.client, bound)
  try {
    await Promise.race([held.started, pending.then(() => { throw new Error('Paid proof completed before the invoice barrier') })])
    mutate(bound); held.release()
    expect(await pending).toEqual(originalPaidProof)
    expect(held.requests).toEqual(['invoice:in_fixture123', 'allocations:in_fixture123:', 'invoice:in_fixture123',
      'allocations:in_fixture123:', 'balance:cus_fixture:', 'intent:pi_fixture123', 'charge:ch_fixture123', 'balance:cus_fixture:'])
  } finally { held.release(); await pending.catch(() => undefined) }
})

test.each(monetaryMutations)('unpaid proof owns bound $label and cannot acquire paid rights', async ({ mutate }) => {
  const baseline = await proveUnpaidMonthlyInvoice(config, unpaidProvider('open'), originalBound)
  const bound = mutableBound(), held = holdFirstInvoice(unpaidProvider('open'))
  const pending = proveUnpaidMonthlyInvoice({ ...config }, held.client, bound)
  try {
    await Promise.race([held.started, pending.then(() => { throw new Error('Unpaid proof completed before the invoice barrier') })])
    mutate(bound); held.release()
    expect(await pending).toEqual(baseline)
    expect(baseline).toEqual({ kind: 'unpaid-invoice', invoiceId: 'in_fixture123', customerId: 'cus_fixture',
      subscriptionId: 'sub_fixture123', currency: 'eur', status: 'open', amountDue: 1500, amountPaid: 0, amountRemaining: 1500,
      periodStart: 1790812800, periodEnd: 1793491200, invoicePaymentIds: ['inpay_fixture123'], observationDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(held.requests).toEqual(['invoice:in_fixture123', 'allocations:in_fixture123:', 'invoice:in_fixture123',
      'allocations:in_fixture123:', 'balance:cus_fixture:', 'intent:pi_fixture123', 'balance:cus_fixture:'])
  } finally { held.release(); await pending.catch(() => undefined) }
})

test.each(['open', 'canceled'] satisfies Array<'open' | 'canceled'>)('unpaid %s allocation preserves null paid amount and no captured charge proof', async status => {
  const result = await proveUnpaidMonthlyInvoice(config, unpaidProvider(status), originalBound)
  expect(result).toMatchObject({ kind: 'unpaid-invoice', amountPaid: 0, amountDue: 1500, amountRemaining: 1500,
    invoicePaymentIds: ['inpay_fixture123'] })
  expect(result).not.toHaveProperty('chargeIds')
  expect(result).toMatchSnapshot()
})

test.each([
  { firstPeriod: true, onboarding: null }, { firstPeriod: true, onboarding: undefined },
  { firstPeriod: undefined, onboarding: null }, { firstPeriod: undefined, onboarding: undefined },
  { firstPeriod: false, onboarding: null }, { firstPeriod: false, onboarding: undefined },
])('monthly witnesses firstPeriod=$firstPeriod onboarding=$onboarding preserve both proof results', async witness => {
  const client = provider(), bound = { ...originalBound, ...witness }
  const cycleClient: LineageProvider & MonetaryProvider = { ...client, async retrieveInvoice(id) {
    const invoice = await client.retrieveInvoice(id)
    return { ...invoice, billing_reason: witness.firstPeriod === false ? 'subscription_cycle' : 'subscription_create' }
  } }
  expect(await provePaidMonthlyInvoice(config, cycleClient, bound)).toEqual(originalPaidProof)
  const unpaid = unpaidProvider('open')
  const unpaidCycle: LineageProvider & MonetaryProvider = { ...unpaid, async retrieveInvoice(id) {
    const invoice = await unpaid.retrieveInvoice(id)
    return { ...invoice, billing_reason: witness.firstPeriod === false ? 'subscription_cycle' : 'subscription_create' }
  } }
  expect(await proveUnpaidMonthlyInvoice(config, unpaidCycle, bound)).toMatchObject({ kind: 'unpaid-invoice', amountPaid: 0 })
})

test.each([
  { onboardingPriceId: 'price_alias', onboardingUnitAmount: null },
  { onboardingPriceId: null, onboardingUnitAmount: 0 },
  { onboardingPriceId: 'price_alias', onboardingUnitAmount: 500 },
])('lineage refuses forbidden onboarding $onboardingPriceId/$onboardingUnitAmount at entry before provider I/O', async fee => {
  const input = lineageInputs(), held = holdFirstInvoice(provider()); held.release()
  input.operation = { ...input.operation, ...fee }
  await expect(proveBillingLineage(input.config, held.client, input.operation, input.customer, 'in_fixture123', input.terms))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual([])
})

test.each([
  { label: 'paid', prove: provePaidMonthlyInvoice, firstPeriod: true },
  { label: 'unpaid', prove: proveUnpaidMonthlyInvoice, firstPeriod: true },
  { label: 'paid', prove: provePaidMonthlyInvoice, firstPeriod: false },
  { label: 'unpaid', prove: proveUnpaidMonthlyInvoice, firstPeriod: false },
])('$label proof refuses nonnull onboarding firstPeriod=$firstPeriod at entry before provider I/O', async ({ prove, firstPeriod }) => {
  const held = holdFirstInvoice(provider()); held.release()
  await expect(prove(config, held.client, { ...originalBound, firstPeriod, onboarding: { priceId: 'price_alias', amount: 0 } }))
    .rejects.toMatchObject({ name: 'BillingMonetaryError', message: 'Billing monetary proof unavailable' })
  expect(held.requests).toEqual([])
})
function legacyInputs() {
  const input = lineageInputs()
  input.operation.checkoutReferenceVersion = 'legacy-v1'
  input.operation.phase = 'SUCCEEDED'
  input.operation.stripeObjectId = 'cs_test_fixture123'
  input.operation.requestHash = createHash('sha256').update(JSON.stringify(buildCheckoutParameters(input.config, {
    workspaceId: input.operation.workspaceId, customerId: 'cus_fixture', idempotencyKey: input.operation.idempotencyKey,
    integrationIdentifier: 'template_ABCDEFGH', terms: {
      id: termsA.id, monthlyPriceId: 'price_negotiatedA', currency: 'eur', monthlyUnitAmount: 1500,
    },
  }))).digest('hex')
  return input
}

test('monthly lineage preserves the original legacy Session witness and exact legacy request hash', async () => {
  const input = legacyInputs(), client = provider()
  const legacy: LineageProvider & MonetaryProvider = { ...client, async retrieveCheckoutSession(id) {
    const session = await client.retrieveCheckoutSession(id)
    return { ...session, client_reference_id: input.operation.workspaceId }
  } }
  expect(await proveBillingLineage(input.config, legacy, input.operation, input.customer, 'in_fixture123', input.terms)).toEqual(originalLineage)
})

test('legacy without an original positive Session witness refuses before provider I/O', async () => {
  const input = legacyInputs(), held = holdFirstInvoice(provider())
  input.operation.phase = 'UNKNOWN'; input.operation.stripeObjectId = null
  await expect(proveBillingLineage(input.config, held.client, input.operation, input.customer, 'in_fixture123', input.terms))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual([])
})

test('wrong original request hash still refuses before provider I/O', async () => {
  const input = lineageInputs(), held = holdFirstInvoice(provider())
  input.operation.requestHash = '0'.repeat(64)
  await expect(proveBillingLineage(input.config, held.client, input.operation, input.customer, 'in_fixture123', input.terms))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual([])
})

test.each([
  { label: 'another workspace', changes: { workspaceId: '22222222-2222-4222-8222-222222222222' } },
  { label: 'another Stripe account', changes: { accountId: 'acct_other' } },
])('checkout lineage refuses a Customer binding from $label before provider reads', async ({ changes }) => {
  const held = holdFirstInvoice(provider())
  await expect(proveBillingLineage(config, held.client, checkoutOperation, { ...customer, ...changes }, 'in_fixture123', termsA))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual([])
})

test('a completed Session for the same Customer cannot substitute another original Checkout operation', async () => {
  const client = provider()
  const substituted: LineageProvider & MonetaryProvider = { ...client, async retrieveCheckoutSession(id) {
    return { ...await client.retrieveCheckoutSession(id), client_reference_id: '11111111-1111-4111-8111-111111111111' }
  } }
  const held = holdFirstInvoice(substituted); held.release()
  await expect(proveBillingLineage(config, held.client, checkoutOperation, customer, 'in_fixture123', termsA))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'subscription:sub_fixture123',
    'sessions:sub_fixture123:cus_fixture:', 'checkout:cs_test_fixture123'])
})

test.each([
  { label: 'a proration', proration: true, period: { start: 1790812800, end: 1793491200 } },
  { label: 'a zero-duration service period', proration: false, period: { start: 1790812800, end: 1790812800 } },
])('monthly lineage cannot bind $label as the agreed monthly service', async ({ proration, period }) => {
  const client = provider()
  const changed: LineageProvider & MonetaryProvider = { ...client, async retrieveInvoice(id) {
    const invoice = await client.retrieveInvoice(id), monthly = invoice.lines.data[0]!
    return { ...invoice, lines: { ...invoice.lines, data: [{ ...monthly, period,
      parent: { ...monthly.parent!, subscription_item_details: { ...monthly.parent!.subscription_item_details!, proration } },
    }] } }
  } }
  const held = holdFirstInvoice(changed); held.release()
  await expect(proveBillingLineage(config, held.client, checkoutOperation, customer, 'in_fixture123', termsA))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'subscription:sub_fixture123',
    'sessions:sub_fixture123:cus_fixture:', 'checkout:cs_test_fixture123', 'lines:cs_test_fixture123:'])
})

test.each([
  { label: 'a different subscription', changes: { subscription: 'sub_other' } },
  { label: 'a different service period', changes: { period: { start: 1793491200, end: 1796083200 } } },
  { label: 'a line amount below the agreement', changes: { amount: 1499 } },
])('paid invoice totals cannot hide $label on the monthly service line', async ({ changes }) => {
  const client = provider()
  const changed: LineageProvider & MonetaryProvider = { ...client, async retrieveInvoice(id) {
    const invoice = await client.retrieveInvoice(id)
    return { ...invoice, lines: { ...invoice.lines, data: invoice.lines.data.map(line => ({ ...line, ...changes })) } }
  } }
  const held = holdFirstInvoice(changed); held.release()
  await expect(provePaidMonthlyInvoice(config, held.client, originalBound))
    .rejects.toMatchObject({ name: 'BillingMonetaryError', message: 'Billing monetary proof unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123'])
})

test.each([
  { label: 'another invoice', changes: { invoice: 'in_other' } },
  { label: 'an amount different from its paid allocation', changes: { amount_requested: 1600 } },
])('paid proof refuses an InvoicePayment describing $label before reading a PaymentIntent', async ({ changes }) => {
  const client = provider()
  const changed: LineageProvider & MonetaryProvider = { ...client, async listInvoicePayments(id, cursor) {
    const page = await client.listInvoicePayments(id, cursor)
    return { ...page, data: page.data.map(payment => ({ ...payment, ...changes })) }
  } }
  const held = holdFirstInvoice(changed); held.release()
  await expect(provePaidMonthlyInvoice(config, held.client, originalBound))
    .rejects.toMatchObject({ name: 'BillingMonetaryError', message: 'Billing monetary proof unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'allocations:in_fixture123:'])
})

test('a partially captured Charge cannot prove the full negotiated monthly amount despite paid invoice and allocation', async () => {
  const client = provider()
  const partial: LineageProvider & MonetaryProvider = { ...client, async retrieveCharge(id) {
    return { ...await client.retrieveCharge(id), amount_captured: 1499 }
  } }
  const held = holdFirstInvoice(partial); held.release()
  await expect(provePaidMonthlyInvoice(config, held.client, originalBound))
    .rejects.toMatchObject({ name: 'BillingMonetaryError', message: 'Billing monetary proof unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'allocations:in_fixture123:', 'invoice:in_fixture123',
    'allocations:in_fixture123:', 'balance:cus_fixture:', 'intent:pi_fixture123', 'charge:ch_fixture123'])
})

test('an unpaid allocation and zero received amount cannot erase a captured latest Charge', async () => {
  const client = unpaidProvider('open')
  const inconsistent: LineageProvider & MonetaryProvider = { ...client, async retrievePaymentIntent(id) {
    return { ...await client.retrievePaymentIntent(id), latest_charge: 'ch_fixture123' }
  } }
  const held = holdFirstInvoice(inconsistent); held.release()
  await expect(proveUnpaidMonthlyInvoice(config, held.client, originalBound))
    .rejects.toMatchObject({ name: 'BillingMonetaryError', message: 'Billing monetary proof unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'allocations:in_fixture123:', 'invoice:in_fixture123',
    'allocations:in_fixture123:', 'balance:cus_fixture:', 'intent:pi_fixture123', 'charge:ch_fixture123'])
})

test('monthly lineage refuses an extra zero-amount Checkout line instead of ignoring it', async () => {
  const client = provider()
  const extraLine: LineageProvider & MonetaryProvider = { ...client, async listCheckoutLineItems(id, cursor) {
    const page = await client.listCheckoutLineItems(id, cursor)
    const extra: (typeof page.data)[number] = { ...page.data[0]!, id: 'li_extraZero', amount_subtotal: 0, amount_total: 0,
      price: { ...f.price, id: 'price_extraZero', unit_amount: 0, unit_amount_decimal: Stripe.Decimal.from('0'),
        type: 'one_time', recurring: null } }
    return { ...page, data: [...page.data, extra] }
  } }
  const held = holdFirstInvoice(extraLine); held.release()
  await expect(proveBillingLineage(config, held.client, checkoutOperation, customer, 'in_fixture123', termsA))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'subscription:sub_fixture123',
    'sessions:sub_fixture123:cus_fixture:', 'checkout:cs_test_fixture123', 'lines:cs_test_fixture123:'])
})

test('monthly lineage refuses an extra zero-amount Invoice line instead of ignoring it', async () => {
  const client = provider()
  const extraLine: LineageProvider & MonetaryProvider = { ...client, async retrieveInvoice(id) {
    const invoice = await client.retrieveInvoice(id), monthly = invoice.lines.data[0]!
    const extra: typeof monthly = { ...monthly, id: 'il_extraZero', amount: 0,
      pricing: { type: 'price_details', unit_amount_decimal: Stripe.Decimal.from('0'),
        price_details: { price: 'price_extraZero', product: 'prod_extraZero' } } }
    return { ...invoice, lines: { ...invoice.lines, data: [...invoice.lines.data, extra] } }
  } }
  const held = holdFirstInvoice(extraLine); held.release()
  await expect(proveBillingLineage(config, held.client, checkoutOperation, customer, 'in_fixture123', termsA))
    .rejects.toMatchObject({ name: 'BillingLineageError', message: 'Billing lineage unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123', 'subscription:sub_fixture123',
    'sessions:sub_fixture123:cus_fixture:', 'checkout:cs_test_fixture123', 'lines:cs_test_fixture123:'])
})

test.each([
  { label: 'paid', prove: provePaidMonthlyInvoice, unpaid: false },
  { label: 'unpaid', prove: proveUnpaidMonthlyInvoice, unpaid: true },
])('$label monthly proof refuses an extra zero-amount Invoice line before later payment reads', async ({ prove, unpaid }) => {
  const client = unpaid ? unpaidProvider('open') : provider()
  const extraLine: LineageProvider & MonetaryProvider = { ...client, async retrieveInvoice(id) {
    const invoice = await client.retrieveInvoice(id), monthly = invoice.lines.data[0]!
    const extra: typeof monthly = { ...monthly, id: 'il_extraZero', amount: 0,
      pricing: { type: 'price_details', unit_amount_decimal: Stripe.Decimal.from('0'),
        price_details: { price: 'price_extraZero', product: 'prod_extraZero' } } }
    return { ...invoice, lines: { ...invoice.lines, data: [...invoice.lines.data, extra] } }
  } }
  const held = holdFirstInvoice(extraLine); held.release()
  await expect(prove(config, held.client, originalBound))
    .rejects.toMatchObject({ name: 'BillingMonetaryError', message: 'Billing monetary proof unavailable' })
  expect(held.requests).toEqual(['invoice:in_fixture123'])
})
