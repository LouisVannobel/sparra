import { createHash } from 'node:crypto'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import type Stripe from 'stripe'
import { expect, test } from 'vitest'
import type { AuthTransactions } from '../../src/platform/db/transactions.server'
import type { BillingWorkspaceLease } from '../../src/platform/db/auth-pg-lease.server'
import { parseBillingInput, readBillingState, startCheckout, type BillingClient } from '../../src/modules/billing/checkout.server'
import { billingAgreement, billingCurrentAgreement, billingCustomer, billingOperation } from '../../src/modules/billing/schema.server'
import { config, workspaceId, customer, checkoutOperation, termsA, termsB, monthlyPrice } from '../helpers/billing-fixtures'

const principal = { userId: 'fixture-user', sessionId: 'fixture-session', name: 'Fixture', email: 'fixture@example.test' }
// The query boundary double retains Drizzle's actual selection/mapping and SQL.
// SQL authority, locking and mutations are covered by the disposable-PG tests.
type Operation = typeof billingOperation.$inferSelect
type BillingTable = typeof billingCustomer | typeof billingOperation | typeof billingAgreement | typeof billingCurrentAgreement
type Visibility = Readonly<{
  customer?: typeof billingCustomer.$inferSelect | null
  operations?: readonly Operation[]
  pointer?: typeof billingCurrentAgreement.$inferSelect
  agreement?: typeof billingAgreement.$inferSelect
  observedAtSeconds?: number
}>
function fixture(initial: typeof termsA | null = termsA, existing: Partial<Operation> | null = null,
  priceChanges: Partial<Stripe.Price> = {}, visibility: Visibility = {}) {
  let currentTerms = initial
  let operation: Operation | null = existing ? { ...checkoutOperation, ...existing } : null
  const effects: string[] = []
  const sent: unknown[] = []
  const rows = <Table extends BillingTable>(table: Table, value: Table['$inferSelect']) => {
    // SAFETY: each value has this table's SELECT shape; the keys come from the same Drizzle schema.
    const keys = Object.keys(getTableColumns(table)) as Array<keyof Table['$inferSelect']>
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
    if (query.includes('from "billing_customer"')) {
      const retained = visibility.customer === undefined ? customer : visibility.customer
      return { rows: retained ? [rows(billingCustomer, retained)] : [] }
    }
    if (query.includes('from "billing_operation"')) return {
      rows: (visibility.operations ?? (operation ? [operation] : [])).map(value => rows(billingOperation, value)),
    }
    if (query.includes('from "billing_current_agreement"')) return {
      rows: visibility.pointer ? [rows(billingCurrentAgreement, visibility.pointer)] : [],
    }
    if (query.includes('from "billing_agreement"')) return {
      rows: visibility.agreement ? [rows(billingAgreement, visibility.agreement)] : [],
    }
    if (query.includes('from "billing_agreed_terms"')) {
      effects.push('terms')
      return { rows: currentTerms ? [[currentTerms.id, currentTerms.workspaceId, currentTerms.environment, currentTerms.accountId,
        currentTerms.revision, currentTerms.monthlyPriceId, currentTerms.currency, currentTerms.monthlyUnitAmount]] : [] }
    }
    if (query.includes('clock_timestamp')) return { rows: [[visibility.observedAtSeconds ?? 1790812800]] }
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

test('Billing without negotiated terms stays unavailable and cannot expose another Workspace', async () => {
  const f = fixture(null)
  const unavailable = { availability: 'unavailable', state: 'unavailable', paidThrough: null, cancellation: 'none' }
  expect(await readBillingState(f.owner, principal, null, workspaceId)).toEqual(unavailable)
  expect(f.effects).toEqual([])
  expect(await readBillingState(f.owner, principal, config, workspaceId)).toEqual(unavailable)
  expect(f.effects).toEqual(['terms'])
  await expect(readBillingState(f.owner, principal, config, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).rejects.toMatchObject({ status: 404 })
  expect(f.effects).toEqual(['terms'])
})

test('Billing projects retained Customer and Checkout admissions without provider I/O or commercial amounts', async () => {
  const customerAdmission: Operation = { ...checkoutOperation, kind: 'CUSTOMER_CREATE', phase: 'ADMITTED',
    idempotencyKey: `customer:${checkoutOperation.id}`,
    requestHash: createHash('sha256').update(JSON.stringify({ metadata: { workspace_id: workspaceId } })).digest('hex'),
    customerId: null, agreedTermsId: null, monthlyPriceId: null, currency: null, monthlyUnitAmount: null,
    integrationIdentifier: null, checkoutReferenceVersion: 'legacy-v1' }
  const pendingCustomer = fixture(termsA, null, {}, { customer: null, operations: [customerAdmission] })
  expect(await readBillingState(pendingCustomer.owner, principal, config, workspaceId)).toEqual({
    availability: 'available', state: 'customer-pending', paidThrough: null, cancellation: 'none',
  })
  expect(pendingCustomer.effects).toEqual(['terms'])
  const pendingCheckout = fixture(termsB, { phase: 'ADMITTED' })
  expect(await readBillingState(pendingCheckout.owner, principal, config, workspaceId)).toEqual({
    availability: 'available', state: 'checkout-pending', paidThrough: null, cancellation: 'none',
  })
  expect(pendingCheckout.effects).toEqual([])
})

test('Billing keeps unresolved sends and a Checkout expired at the SQL clock as incidents without reopening them', async () => {
  const operations: Operation[] = [
    { ...checkoutOperation, phase: 'UNKNOWN' },
    { ...checkoutOperation, phase: 'DISPATCHING' },
    { ...checkoutOperation, phase: 'SUCCEEDED', stripeObjectId: 'cs_test_fixture',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fixture', checkoutExpiresAt: 1790814600 },
  ]
  for (const operation of operations) {
    const f = fixture(termsB, operation, {}, { observedAtSeconds: 1790814600 })
    expect(await readBillingState(f.owner, principal, config, workspaceId)).toEqual({
      availability: 'available', state: 'incident', paidThrough: null, cancellation: 'none',
    })
    expect(f.operation).toEqual(operation)
    expect(f.effects).toEqual([])
    expect(f.sent).toEqual([])
  }
})

test('Billing confirms cancellation only for the retained subscription and canonical cancellation intention', async () => {
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const cancellation: Operation = { ...checkoutOperation, id, kind: 'CANCEL_AT_PERIOD_END', phase: 'ADMITTED',
    idempotencyKey: `cancel:${id}`, requestHash: createHash('sha256').update(JSON.stringify({ cancel_at_period_end: true })).digest('hex'),
    agreedTermsId: null, monthlyPriceId: null, currency: null, monthlyUnitAmount: null, integrationIdentifier: null,
    checkoutReferenceVersion: 'legacy-v1' }
  const observations: Array<{ operation: Operation; expected: 'pending' | 'confirmed' | 'incident' }> = [
    { operation: cancellation, expected: 'pending' },
    { operation: { ...cancellation, phase: 'SUCCEEDED', stripeObjectId: 'sub_fixture' }, expected: 'confirmed' },
    { operation: { ...cancellation, phase: 'SUCCEEDED', stripeObjectId: 'sub_other' }, expected: 'incident' },
    { operation: { ...cancellation, customerId: 'cus_other' }, expected: 'incident' },
    { operation: { ...cancellation, idempotencyKey: 'cancel:changed' }, expected: 'incident' },
    { operation: { ...cancellation, currency: 'eur' }, expected: 'incident' },
  ]
  for (const observation of observations) {
    const f = fixture(termsB, null, {}, { customer: { ...customer, knownSubscriptionId: 'sub_fixture' },
      operations: [checkoutOperation, observation.operation] })
    expect(await readBillingState(f.owner, principal, config, workspaceId)).toEqual({
      availability: 'available', state: 'subscription-present', paidThrough: null, cancellation: observation.expected,
    })
    expect(f.effects).toEqual([])
  }
})

test('Billing projects paid or held only from the current agreement and expires payment against the SQL clock', async () => {
  const agreement: typeof billingAgreement.$inferSelect = { id: '99999999-9999-4999-8999-999999999999', workspaceId,
    operationId: checkoutOperation.id, environment: config.environment, accountId: config.accountId, subscriptionId: 'sub_fixture',
    invoiceId: 'in_fixture', periodStart: 1790812800, periodEnd: 1790816400, proof: { fixture: 'retained paid proof' },
    createdAt: checkoutOperation.createdAt }
  const pointer: typeof billingCurrentAgreement.$inferSelect = { workspaceId, agreementId: agreement.id, version: 1, heldAt: null }
  const observations = [
    { pointer, observedAtSeconds: agreement.periodStart, expected: 'paid' },
    { pointer: { ...pointer, heldAt: checkoutOperation.createdAt }, observedAtSeconds: agreement.periodStart, expected: 'held' },
    { pointer, observedAtSeconds: agreement.periodEnd, expected: 'incident' },
  ]
  for (const observation of observations) {
    const f = fixture(termsB, checkoutOperation, {}, { customer: { ...customer, knownSubscriptionId: 'sub_fixture' },
      pointer: observation.pointer, agreement, observedAtSeconds: observation.observedAtSeconds })
    expect(await readBillingState(f.owner, principal, config, workspaceId)).toEqual({
      availability: 'available', state: observation.expected, paidThrough: new Date(agreement.periodEnd * 1000).toISOString(), cancellation: 'none',
    })
    expect(f.effects).toEqual([])
  }
})
