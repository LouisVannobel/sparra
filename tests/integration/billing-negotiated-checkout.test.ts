import { afterAll, beforeAll, expect, test } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { billingCustomer, billingOperation } from '../../src/modules/billing/schema.server'
import { readAgreedMonthlyTerms } from '../../src/modules/billing/agreed-terms.server'
import { readBillingState, startCheckout, type BillingClient } from '../../src/modules/billing/checkout.server'
import { buildCheckoutParameters } from '../../src/modules/billing/stripe.server'
import { cancelAtPeriodEnd } from '../../src/modules/billing/cancellation.server'
import { config, monthlyPrice } from '../helpers/billing-fixtures'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool, owner: ReturnType<typeof createTransactions>
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
})
afterAll(async () => { try { await pool?.end() } finally { await stores?.cleanup() } })
const one = sql`(SELECT 1) AS fixture`
const options = () => ({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
async function fixture(withCustomer = true) {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID(), customerId = 'cus_' + randomUUID().replaceAll('-', '')
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,\'Fixture\',$2,true)', [userId, userId + '@example.test'])
  await stores.administrator.query("INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES($1,$2,$3,now()+interval '1 day','ACTIVE','passkey',now(),0,now())", [sessionId, randomUUID(), userId])
  await stores.administrator.query("INSERT INTO workspace(id,kind,lifecycle,owner_user_id) VALUES($1,'personal','active',$2)", [workspaceId, userId])
  if (withCustomer) await stores.administrator.query("INSERT INTO billing_customer(workspace_id,environment,account_id,stripe_customer_id) VALUES($1,'sandbox','acct_fixture',$2)", [workspaceId, customerId])
  return { principal: { userId, sessionId, name: 'Fixture', email: userId + '@example.test' }, workspaceId, customerId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function agree(f: Fixture, revision: number, amount = 1500, price = 'price_agreedA') {
  const id = randomUUID()
  await stores.administrator.query("INSERT INTO billing_agreed_terms(id,workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,$2,'sandbox','acct_fixture',$3,$4,'eur',$5)", [id, f.workspaceId, revision, price, amount])
  return { id, revision, amount, price }
}
async function admit(f: Fixture, terms: Awaited<ReturnType<typeof agree>>, changes: { termsId?: string; revision?: number; amount?: number; currency?: string; price?: string } = {}) {
  const id = randomUUID(), hash = createHash('sha256').update('synthetic admitted body').digest('hex')
  return owner.withBillingWorkspacePromise(options(), f.principal, f.workspaceId, async lease => {
    const [row] = await lease!.db.select({ id: sql<string | null>`app_private.billing_admit_checkout_v3(${f.principal.userId},${f.principal.sessionId},
      ${f.workspaceId}::uuid,'sandbox','acct_fixture','2026-09-30.endive',${id}::uuid,${'checkout:' + id},${hash},${f.customerId},
      ${changes.termsId ?? terms.id}::uuid,${changes.revision ?? terms.revision}::bigint,${changes.price ?? terms.price},
      ${changes.currency ?? 'eur'},${changes.amount ?? terms.amount}::bigint,'template_ABCDEFGH')` }).from(one)
    return row!.id
  })
}
test('two Workspaces resolve only their own agreed monthly conditions under the financial lease', async () => {
  const a = await fixture(), b = await fixture(); const ta = await agree(a, 1), tb = await agree(b, 1, 2900, 'price_agreedB')
  expect(await owner.withBillingWorkspacePromise(options(), a.principal, a.workspaceId, lease => readAgreedMonthlyTerms(lease!, 'sandbox', 'acct_fixture'))).toMatchObject({ id: ta.id, monthlyUnitAmount: 1500 })
  expect(await owner.withBillingWorkspacePromise(options(), b.principal, b.workspaceId, lease => readAgreedMonthlyTerms(lease!, 'sandbox', 'acct_fixture'))).toMatchObject({ id: tb.id, monthlyUnitAmount: 2900 })
  expect(await owner.withBillingWorkspacePromise(options(), a.principal, b.workspaceId, async lease => lease)).toBeNull()
  expect(await admit(a, ta, { termsId: tb.id })).toBeNull()
})
test.each([{ amount: 1499 }, { price: 'price_wrong' }, { currency: 'usd' }, { revision: 2 }])('SQL admission refuses inconsistent commercial snapshot %#', async changes => {
  const f = await fixture(), terms = await agree(f, 1)
  expect(await admit(f, terms, changes)).toBeNull()
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_operation WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
})
test('A to B during the Price GET refuses stale A even when Price, currency and amount are identical', async () => {
  const f = await fixture(); const a = await agree(f, 1); const calls: string[] = []
  // SAFETY: this test replaces only external provider effects; all SQL admission and locks are native.
  const provider = { async retrievePrice(id: string) {
    calls.push('GET ' + id); await agree(f, 2)
    return monthlyPrice({ id })
  }, async createCustomer() { throw new Error('Unexpected Customer') }, async createCheckout() { calls.push('POST Checkout'); throw new Error('Unexpected POST') } } satisfies BillingClient
  await expect(startCheckout(owner, f.principal, config, provider, f.workspaceId)).rejects.toMatchObject({ status: 409 })
  expect(calls).toEqual(['GET price_agreedA'])
  expect(await admit(f, a)).toBeNull()
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_operation WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
})
test('after admission a newer agreement cannot replace the operation slot or its send identity', async () => {
  const f = await fixture(), a = await agree(f, 1), id = await admit(f, a)
  expect(id).toBeTypeOf('string')
  const before = (await stores.administrator.query('SELECT * FROM billing_operation WHERE id=$1', [id])).rows[0]
  const b = await agree(f, 2, 2900, 'price_agreedB')
  expect(await admit(f, b)).toBe(id)
  expect((await stores.administrator.query('SELECT * FROM billing_operation WHERE id=$1', [id])).rows[0]).toEqual(before)
  // SAFETY: these negative provider methods must never be reached; the real SQL operation already exists.
  const calls: string[] = [], provider = { async retrievePrice() { calls.push('GET'); throw new Error('Unexpected GET') },
    async createCustomer() { throw new Error('Unexpected Customer') }, async createCheckout() { calls.push('POST'); throw new Error('Unexpected POST') } } satisfies BillingClient
  await expect(startCheckout(owner, f.principal, config, provider, f.workspaceId)).rejects.toMatchObject({ status: 409 })
  expect(calls).toEqual([])
})
test('conditions and operation binding are immutable and runtime has no terms writer or legacy admission', async () => {
  const f = await fixture(), a = await agree(f, 1), id = await admit(f, a)
  await expect(stores.administrator.query('UPDATE billing_agreed_terms SET monthly_unit_amount=1 WHERE id=$1', [a.id])).rejects.toMatchObject({ code: '23514' })
  await expect(stores.administrator.query('DELETE FROM billing_agreed_terms WHERE id=$1', [a.id])).rejects.toMatchObject({ code: '23514' })
  const b = await agree(f, 2)
  await expect(stores.administrator.query('UPDATE billing_operation SET agreed_terms_id=$1 WHERE id=$2', [b.id, id])).rejects.toMatchObject({ code: '23514' })
  expect((await stores.administrator.query("SELECT to_regprocedure('app_private.billing_admit_checkout(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text)') AS v1,to_regprocedure('app_private.billing_admit_checkout_v2(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text)') AS v2")).rows[0]).toEqual({ v1: null, v2: null })
  for (const role of ['runtime', 'billing_relay', 'billing_worker']) {
    expect((await stores.administrator.query("SELECT has_table_privilege($1,'billing_agreed_terms','INSERT,UPDATE,DELETE,TRUNCATE') AS writable", [role])).rows[0].writable).toBe(false)
  }
  expect(await owner.withBillingWorkspacePromise(options(), f.principal, f.workspaceId, async lease => (await lease!.db.select().from(billingOperation)).length)).toBe(1)
})
test('without agreement and without existing Checkout there is zero provider I/O, including Customer creation', async () => {
  const f = await fixture(false), effects: string[] = []
  // SAFETY: these negative external methods fail immediately if the production no-agreement guard regresses.
  const provider = { async retrievePrice() { effects.push('Price'); throw new Error('Unexpected Price') },
    async createCustomer() { effects.push('Customer'); throw new Error('Unexpected Customer') },
    async createCheckout() { effects.push('Checkout'); throw new Error('Unexpected Checkout') } } satisfies BillingClient
  await expect(startCheckout(owner, f.principal, config, provider, f.workspaceId)).rejects.toMatchObject({ status: 503 })
  expect(effects).toEqual([])
})
test('known subscription cancellation after terms B still targets subscription A', async () => {
  const f = await fixture(), a = await agree(f, 1), id = await admit(f, a)
  await stores.administrator.query("UPDATE billing_operation SET phase='DISPATCHING' WHERE id=$1", [id])
  await stores.administrator.query("UPDATE billing_customer SET known_subscription_id=$1 WHERE workspace_id=$2", ['sub_' + f.principal.userId.replaceAll('-', ''), f.workspaceId])
  await agree(f, 2, 2900, 'price_agreedB')
  const targets: string[] = [], subscriptionId = 'sub_' + f.principal.userId.replaceAll('-', '')
  // SAFETY: this external-only double records the Subscription selected by native cancellation admission.
  const provider = { async cancelSubscriptionAtPeriodEnd(intent: { subscriptionId: string }) {
    targets.push(intent.subscriptionId); return { subscriptionId: intent.subscriptionId, cancelAtPeriodEnd: true as const }
  } }
  expect(await cancelAtPeriodEnd(owner, f.principal, config, provider, f.workspaceId)).toEqual({ state: 'confirmed' })
  expect(targets).toEqual([subscriptionId])
})

test('first native Checkout creates Customer and retains admitted A after B is inserted during the provider send', async () => {
  const f = await fixture(false), a = await agree(f, 1), effects: string[] = []
  const sessionId = 'cs_test_' + randomUUID().replaceAll('-', '')
  const navigation = { id: sessionId, url: 'https://checkout.stripe.com/c/pay/' + sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
  const sends: (typeof billingOperation.$inferSelect)[] = []
  const operations = () => owner.withBillingWorkspacePromise(options(), f.principal, f.workspaceId, async lease => {
    if (!lease) throw new Error('Native financial lease missing')
    return lease.db.select().from(billingOperation)
  })
  // SAFETY: only the provider effects are controlled; Customer/Checkout claims,
  // persisted snapshots and the agreement insertion lock are real owned SQL.
  const provider = {
    async retrievePrice(id) {
      owner.assertNoActiveAuthTransaction()
      effects.push('GET ' + id)
      return monthlyPrice({ id })
    },
    async createCustomer(intent) {
      owner.assertNoActiveAuthTransaction()
      effects.push('POST Customer')
      const customerOperation = (await operations())?.find(operation => operation.kind === 'CUSTOMER_CREATE')
      expect(customerOperation).toMatchObject({ workspaceId: f.workspaceId, phase: 'DISPATCHING',
        idempotencyKey: intent.idempotencyKey,
        requestHash: createHash('sha256').update(JSON.stringify({ metadata: { workspace_id: f.workspaceId } })).digest('hex') })
      expect(intent.workspaceId).toBe(f.workspaceId)
      return { id: f.customerId }
    },
    async createCheckout(intent) {
      owner.assertNoActiveAuthTransaction()
      effects.push('POST Checkout')
      const sent = (await operations())?.find(operation => operation.kind === 'CHECKOUT_CREATE')
      if (!sent) throw new Error('Claimed native Checkout missing')
      sends.push(sent)
      expect(sent).toMatchObject({ workspaceId: f.workspaceId, phase: 'DISPATCHING', customerId: f.customerId,
        agreedTermsId: a.id, monthlyPriceId: a.price, currency: 'eur', monthlyUnitAmount: a.amount,
        idempotencyKey: intent.idempotencyKey,
        requestHash: createHash('sha256').update(JSON.stringify(buildCheckoutParameters(config, intent))).digest('hex') })
      expect(intent).toMatchObject({ workspaceId: f.workspaceId, customerId: f.customerId, operationReference: sent.id,
        terms: { id: a.id, monthlyPriceId: a.price, currency: 'eur', monthlyUnitAmount: a.amount } })
      await stores.administrator.query('BEGIN')
      try {
        await stores.administrator.query("SET LOCAL lock_timeout='1000ms'")
        await agree(f, 2, 2900, 'price_agreedB')
        await stores.administrator.query('COMMIT')
      } catch (error) { await stores.administrator.query('ROLLBACK'); throw error }
      return navigation
    },
  } satisfies BillingClient
  expect(await startCheckout(owner, f.principal, config, provider, f.workspaceId)).toEqual({ url: navigation.url })
  expect(effects).toEqual(['GET price_agreedA', 'POST Customer', 'POST Checkout'])
  const rows = await operations(), completed = rows?.find(operation => operation.kind === 'CHECKOUT_CREATE'), sent = sends[0]
  if (!sent || !completed) throw new Error('Native Checkout completion missing')
  expect(sends).toHaveLength(1)
  expect(rows).toHaveLength(2)
  expect(rows?.find(operation => operation.kind === 'CUSTOMER_CREATE')).toMatchObject({ phase: 'SUCCEEDED', stripeObjectId: f.customerId })
  expect(completed).toEqual({ ...sent, phase: 'SUCCEEDED', stripeObjectId: navigation.id,
    checkoutUrl: navigation.url, checkoutExpiresAt: navigation.expiresAt, updatedAt: completed.updatedAt })
  expect(await owner.withBillingWorkspacePromise(options(), f.principal, f.workspaceId, async lease => lease!.db.select().from(billingCustomer)))
    .toMatchObject([{ stripeCustomerId: f.customerId, knownSubscriptionId: null }])
  expect(await readBillingState(owner, f.principal, config, f.workspaceId)).toMatchObject({ state: 'checkout-ready', paidThrough: null })
  expect(await startCheckout(owner, f.principal, config, provider, f.workspaceId)).toEqual({ url: navigation.url })
  expect(effects).toEqual(['GET price_agreedA', 'POST Customer', 'POST Checkout'])
  expect((await operations())?.find(operation => operation.kind === 'CHECKOUT_CREATE')).toEqual(completed)
})
