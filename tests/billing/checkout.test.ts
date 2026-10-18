import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import type Stripe from 'stripe'
import { expect, test } from 'vitest'
import type { AuthTransactions } from '../../src/platform/db/transactions.server'
import type { BillingWorkspaceLease } from '../../src/platform/db/auth-pg-lease.server'
import { parseBillingInput, startCheckout, type BillingClient } from '../../src/modules/billing/checkout.server'
import { billingCustomer, billingOperation } from '../../src/modules/billing/schema.server'
import { config, workspaceId, customer, checkoutOperation, termsA, termsB, monthlyPrice } from '../helpers/billing-fixtures'

const principal = { userId: 'fixture-user', sessionId: 'fixture-session', name: 'Fixture', email: 'fixture@example.test' }
// The query boundary double retains Drizzle's actual selection/mapping and SQL.
// SQL authority, locking and mutations are covered by the disposable-PG tests.
type Operation = typeof billingOperation.$inferSelect
type Row = Partial<typeof billingCustomer.$inferSelect & Operation>
function fixture(initial: typeof termsA | null = termsA, existing: Partial<Operation> | null = null, priceChanges: Partial<Stripe.Price> = {}) {
  let currentTerms = initial
  let operation: Operation | null = existing ? { ...checkoutOperation, ...existing } : null
  const effects: string[] = []
  const sent: unknown[] = []
  const rows = (table: typeof billingCustomer | typeof billingOperation, value: Row) => {
    // SAFETY: table is one of these two Drizzle schemas and Row retains all their keys.
    const keys = Object.keys(getTableColumns(table)) as Array<keyof Row>
    return keys.map(key => { const field = value[key]; return field instanceof Date ? field.toISOString() : field })
  }
  const db = drizzle(async (query, params) => {
    function stringAt(index: number) { const value = params[index]; if (typeof value !== 'string') throw new Error('Expected text SQL argument'); return value }
    if (query.includes('billing_admit_checkout_v3')) {
      effects.push('admit-v3')
      if (params[10] !== currentTerms?.id || params[11] !== currentTerms?.revision) return { rows: [[null]] }
      operation = { ...checkoutOperation, id: stringAt(6), idempotencyKey: stringAt(7),
        requestHash: stringAt(8), agreedTermsId: stringAt(10), integrationIdentifier: stringAt(15), phase: 'ADMITTED' }
      return { rows: [[operation.id]] }
    }
    if (query.includes('billing_admit_checkout_v2')) { effects.push('admit-v2'); return { rows: [[null]] } }
    if (query.includes('billing_claim_operation')) { operation = { ...operation!, phase: 'DISPATCHING' }; return { rows: [[true]] } }
    if (query.includes('billing_mark_unknown')) { operation = { ...operation!, phase: 'UNKNOWN' }; return { rows: [[true]] } }
    if (query.includes('from "billing_customer"')) return { rows: [rows(billingCustomer, customer)] }
    if (query.includes('from "billing_operation"')) return { rows: operation ? [rows(billingOperation, operation)] : [] }
    if (query.includes('from "billing_agreed_terms"')) {
      effects.push('terms')
      return { rows: currentTerms ? [[currentTerms.id, currentTerms.workspaceId, currentTerms.environment, currentTerms.accountId,
        currentTerms.revision, currentTerms.monthlyPriceId, currentTerms.currency, currentTerms.monthlyUnitAmount]] : [] }
    }
    if (query.includes('clock_timestamp')) return { rows: [[1790812800]] }
    throw new Error(`Unexpected SQL ${query} ${params.length}`)
  })
  // SAFETY: this test owns only the two transaction-owner methods used by Checkout; SQL authority has separate native tests.
  const owner = { assertNoActiveAuthTransaction() {}, async withBillingWorkspacePromise<A>(_opts: unknown, _principal: unknown,
    selected: string, work: (lease: BillingWorkspaceLease | null) => Promise<A>) {
    // SAFETY: both Drizzle PostgreSQL drivers share the SELECT schema contract; the test replaces only query execution.
    const lease = { db, workspaceId } as BillingWorkspaceLease
    return work(selected === workspaceId ? lease : null)
  } } as AuthTransactions
  const provider: BillingClient = { async retrievePrice() { effects.push('GET Price'); return monthlyPrice(priceChanges) },
  async createCustomer() { effects.push('POST Customer'); throw new Error('Unexpected Customer') },
  async createCheckout(intent) { effects.push('POST Checkout'); sent.push(intent); throw new Error('Lost acknowledgement') } }
  return { owner, provider, effects, sent, get operation() { return operation }, replaceTerms(value: typeof termsA) { currentTerms = value } }
}
test.each(['amount', 'priceId', 'customerId', 'successUrl', 'currency'])('browser input rejects commercial selector %s', key => {
  expect(() => parseBillingInput({ workspaceId, [key]: 'forged' })).toThrow()
})
test('without agreed terms Checkout performs no Price, Customer or Session I/O', async () => {
  const f = fixture(null)
  await expect(startCheckout(f.owner, principal, config, f.provider, workspaceId)).rejects.toMatchObject({ status: 503 })
  expect(f.effects).toEqual(['terms'])
})
test.each(['UNKNOWN', 'DISPATCHING', 'ADMITTED'] as const)('existing %s keeps its old send identity before latest terms or catalogue', async phase => {
  const f = fixture(termsB, { phase })
  await expect(startCheckout(f.owner, principal, config, f.provider, workspaceId)).rejects.toMatchObject({ status: 409 })
  expect(f.effects).toEqual([])
  expect(f.operation).toMatchObject({ agreedTermsId: termsA.id, monthlyPriceId: 'price_negotiatedA', monthlyUnitAmount: 1500,
    idempotencyKey: 'checkout:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', requestHash: checkoutOperation.requestHash })
})
test('ready old Checkout remains usable after newer commercial terms without a GET', async () => {
  const f = fixture(termsB, { phase: 'SUCCEEDED',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fixture', checkoutExpiresAt: 1790814600 })
  expect(await startCheckout(f.owner, principal, config, f.provider, workspaceId)).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' })
  expect(f.effects).toEqual([])
})
const invalidPrices: Partial<Stripe.Price>[] = [
  { active: false }, { currency: 'usd' }, { unit_amount: 1499 }, { livemode: true }, { type: 'one_time', recurring: null },
  { transform_quantity: { divide_by: 100, round: 'down' } }, { custom_unit_amount: { minimum: 1, maximum: 9000, preset: 1500 } },
  { billing_scheme: 'tiered' }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed', meter: null, trial_period_days: null } },
  { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: null, trial_period_days: null } },
  { recurring: { interval: 'month', interval_count: 2, usage_type: 'licensed', meter: null, trial_period_days: null } },
]
test.each(invalidPrices)('rejects a Price outside the agreed monthly contract before admitting a Checkout %#', async changes => {
  const f = fixture(termsA, null, changes)
  await expect(startCheckout(f.owner, principal, config, f.provider, workspaceId)).rejects.toMatchObject({ status: 503 })
  expect(f.effects).toEqual(['terms', 'GET Price'])
})
test('a replaced revision during the Price GET refuses even with identical Price and amount', async () => {
  const f = fixture(), retrieve = f.provider.retrievePrice
  const provider = { ...f.provider, async retrievePrice(id: string) { f.replaceTerms({ ...termsA, id: termsB.id, revision: 2 }); return retrieve(id) } }
  await expect(startCheckout(f.owner, principal, config, provider, workspaceId)).rejects.toMatchObject({ status: 409 })
  expect(f.effects).toEqual(['terms', 'GET Price', 'admit-v3'])
  expect(f.sent).toEqual([])
})
test('lost Checkout acknowledgement followed by terms B keeps A, its hash and send key without another provider request', async () => {
  const f = fixture()
  await expect(startCheckout(f.owner, principal, config, f.provider, workspaceId)).rejects.toMatchObject({ status: 503 })
  expect(f.sent).toEqual([expect.objectContaining({ terms: { id: termsA.id, monthlyPriceId: 'price_negotiatedA', currency: 'eur', monthlyUnitAmount: 1500 } })])
  expect(f.operation?.phase).toBe('UNKNOWN')
  const before = structuredClone(f.operation), effects = [...f.effects]
  f.replaceTerms(termsB)
  await expect(startCheckout(f.owner, principal, config, f.provider, workspaceId)).rejects.toMatchObject({ status: 409 })
  expect(f.operation).toEqual(before)
  expect(f.effects).toEqual(effects)
})
