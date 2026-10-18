import { expect, test } from 'vitest'
import { proveBillingLineage, type LineageProvider } from '../../src/modules/billing/lineage.server'
import { provePaidMonthlyInvoice, type MonetaryProvider } from '../../src/modules/billing/reconcile.server'
import { config, checkoutOperation, customer, termsA, termsB } from '../helpers/billing-fixtures'
import * as f from '../helpers/billing-provider-fixtures'

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
