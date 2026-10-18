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
