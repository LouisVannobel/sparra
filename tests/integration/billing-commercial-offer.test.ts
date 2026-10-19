import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Redacted } from 'effect'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { startCheckout } from '../../src/modules/billing/checkout.server'
import type { CheckoutIntent } from '../../src/modules/billing/stripe.server'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'
import { startMigrationCommitProxy } from '../helpers/migration-commit-proxy.mjs'
import { fixtureDockerEnvironment } from '../fixtures/db/docker-endpoint'
import { readMigrationConfig } from '../../src/platform/db/config.server.ts'
import { assignBillingTerms, type BillingTermsInput } from '../../scripts/assign-billing-terms.ts'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { config, monthlyPrice } from '../helpers/billing-fixtures'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, database: ReturnType<typeof readMigrationConfig>, pool: Pool
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  const admin = stores.administrator
  const url = new URL('postgresql://127.0.0.1/auth')
  url.username = admin.user!; url.password = admin.password!; url.port = String(admin.port)
  database = readMigrationConfig({ MIGRATION_DATABASE_URL: url.href })
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
})
afterAll(async () => {
  try {
    if (stores) expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='sparra-billing-operator'")).rows[0].n).toBe(0)
  } finally { try { await pool?.end() } finally { await stores?.cleanup() } }
})
async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,\'Fixture\',$2,true)', [userId, userId + '@example.test'])
  await stores.administrator.query("INSERT INTO workspace(id,kind,lifecycle,owner_user_id) VALUES($1,'personal','active',$2)", [workspaceId, userId])
  return { userId, workspaceId }
}
function input(workspaceId: string, changes: Partial<BillingTermsInput> = {}): BillingTermsInput {
  return { workspaceId, accountId: config.accountId, environment: 'sandbox', monthlyPriceId: 'price_fixture',
    monthlyUnitAmount: 1500, expectedRevision: 0, ...changes }
}
// SAFETY: only external provider effects are doubled. Assignment, locks, triggers,
// commit acknowledgement and resource cleanup execute against real disposable SQL.
function provider() { return { async retrievePrice(id: string) { return monthlyPrice({ id }) }, async close() {} } }
async function count(workspaceId: string) {
  return (await stores.administrator.query('SELECT count(*)::int AS n FROM billing_agreed_terms WHERE workspace_id=$1', [workspaceId])).rows[0].n
}
test('first assignment inserts once and an identical explicit retry observes the same immutable row', async () => {
  const f = await fixture(), args = input(f.workspaceId)
  const assigned = await assignBillingTerms(args, database, config, provider)
  expect(assigned).toMatchObject({ workspaceId: f.workspaceId, environment: 'sandbox', accountId: 'acct_fixture', revision: 1, status: 'assigned' })
  expect(await count(f.workspaceId)).toBe(1)
  expect(await assignBillingTerms(args, database, config, provider)).toEqual({ ...assigned, status: 'existing' })
  expect(await count(f.workspaceId)).toBe(1)
})
test('a stale or competing offer cannot append while an explicitly newer revision can', async () => {
  const f = await fixture(), args = input(f.workspaceId)
  await assignBillingTerms(args, database, config, provider)
  await expect(assignBillingTerms({ ...args, monthlyPriceId: 'price_competing' }, database, config, provider)).rejects.toThrow('Billing offer conflict')
  expect(await count(f.workspaceId)).toBe(1)
  expect(await assignBillingTerms({ ...args, expectedRevision: 1, monthlyUnitAmount: 2900 }, database, config,
    () => ({ ...provider(), async retrievePrice(id: string) { return monthlyPrice({ id, unit_amount: 2900 }) } })))
    .toMatchObject({ revision: 2, status: 'assigned' })
  await expect(assignBillingTerms(args, database, config, provider)).rejects.toThrow('Billing offer conflict')
  expect(await count(f.workspaceId)).toBe(2)
})
test('two concurrent competing assignments with the same expected revision have one winner', async () => {
  const f = await fixture(), args = input(f.workspaceId)
  const outcomes = await Promise.allSettled([
    assignBillingTerms(args, database, config, provider),
    assignBillingTerms({ ...args, monthlyPriceId: 'price_competing' }, database, config, provider),
  ])
  expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(await count(f.workspaceId)).toBe(1)
})

test.each([
  { reason: 'wrong object', changes: { object: 'customer' } },
  { reason: 'inactive', changes: { active: false } },
  { reason: 'foreign ID', changes: { id: 'price_other' } },
  { reason: 'wrong mode', changes: { livemode: true } },
  { reason: 'wrong currency', changes: { currency: 'usd' } },
  { reason: 'wrong amount', changes: { unit_amount: 1499 } },
  { reason: 'missing amount', changes: { unit_amount: null } },
  { reason: 'zero amount', changes: { unit_amount: 0 } },
  { reason: 'unsafe amount', changes: { unit_amount: 9007199254740992 } },
  { reason: 'one time', changes: { type: 'one_time' as const } },
  { reason: 'missing recurrence', changes: { recurring: null } },
  { reason: 'tiered', changes: { billing_scheme: 'tiered' as const } },
  { reason: 'yearly', changes: { recurring: { ...monthlyPrice().recurring!, interval: 'year' as const } } },
  { reason: 'two months', changes: { recurring: { ...monthlyPrice().recurring!, interval_count: 2 } } },
  { reason: 'metered', changes: { recurring: { ...monthlyPrice().recurring!, usage_type: 'metered' as const } } },
  { reason: 'meter', changes: { recurring: { ...monthlyPrice().recurring!, meter: 'mtr_fixture' } } },
  { reason: 'quantity transformation', changes: { transform_quantity: { divide_by: 10, round: 'up' as const } } },
  { reason: 'custom amount', changes: { custom_unit_amount: { minimum: 100, maximum: 2000, preset: 1500 } } },
])('invalid provider Price ($reason) causes zero native terms writes and only owned GETs', async ({ changes }) => {
  const f = await fixture(), peer = await startStripeFinancialPeer()
  try {
    peer.setReply('/v1/prices/price_fixture', { body: { ...monthlyPrice({ id: 'price_fixture' }), ...changes } })
    await expect(assignBillingTerms(input(f.workspaceId), database, config)).rejects.toThrow('Billing offer unavailable')
    expect(await count(f.workspaceId)).toBe(0)
    expect(peer.requests().map(request => request.method + ' ' + request.path)).toEqual(['GET /v1/account', 'GET /v1/prices/price_fixture'])
    expect(peer.requests().every(request => !request.accountHeader && !request.contextHeader && request.authorized)).toBe(true)
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
  } finally { await peer.close() }
})
test('a foreign own Account is refused before the Price read or any terms write', async () => {
  const f = await fixture(), peer = await startStripeFinancialPeer()
  try {
    peer.setReply('/v1/account', { body: { id: 'acct_other', object: 'account' } })
    await expect(assignBillingTerms(input(f.workspaceId), database, config)).rejects.toThrow('Billing offer unavailable')
    expect(await count(f.workspaceId)).toBe(0)
    expect(peer.requests().map(request => request.method + ' ' + request.path)).toEqual(['GET /v1/account'])
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
  } finally { await peer.close() }
})
test('the real bounded provider reader performs only own-account and exact Price GETs before assignment', async () => {
  const f = await fixture(), peer = await startStripeFinancialPeer()
  try {
    peer.setReply('/v1/prices/price_fixture', { body: monthlyPrice({ id: 'price_fixture' }) })
    expect(await assignBillingTerms(input(f.workspaceId), database, config)).toMatchObject({ revision: 1, status: 'assigned' })
    expect(peer.requests().map(request => request.method + ' ' + request.path)).toEqual(['GET /v1/account', 'GET /v1/prices/price_fixture'])
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
  } finally { await peer.close() }
})
test.each([{ environment: 'live' as const }, { accountId: 'acct_other' }])('foreign protected config scope refuses before provider creation %#', async changes => {
  const f = await fixture()
  // SAFETY: the external-only factory fails if invoked before the scope guard.
  await expect(assignBillingTerms(input(f.workspaceId, changes), database, config, () => { throw new Error('synthetic-private-factory') }))
    .rejects.toThrow('Billing offer input rejected')
  expect(await count(f.workspaceId)).toBe(0)
})
test('provider reads and cleanup complete outside a database transaction or Workspace lock', async () => {
  const f = await fixture()
  // SAFETY: each doubled provider stage competes for the real Workspace lock.
  const unlocked = async () => {
    const row = await stores.administrator.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE NOWAIT', [f.workspaceId])
    expect(row.rowCount).toBe(1)
    expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='sparra-billing-operator'")).rows[0].n).toBe(0)
  }
  await assignBillingTerms(input(f.workspaceId), database, config, () => ({
    async retrievePrice(id) { await unlocked(); return monthlyPrice({ id }) },
    async close() { await unlocked() },
  }))
})
test.each(['read', 'close'])('provider %s failure exposes a constant-safe error, performs zero SQL writes and retires ownership', async stage => {
  const f = await fixture()
  // SAFETY: only the external provider failure contains this synthetic private text.
  await expect(assignBillingTerms(input(f.workspaceId), database, config, () => ({
    async retrievePrice(id) { if (stage === 'read') throw new Error('synthetic-private-provider'); return monthlyPrice({ id }) },
    async close() { if (stage === 'close') throw new Error('synthetic-private-close') },
  }))).rejects.toThrow(/^Billing offer unavailable$/)
  expect(await count(f.workspaceId)).toBe(0)
  expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='sparra-billing-operator'")).rows[0].n).toBe(0)
})
test.each(['missing', 'provisioning', 'deleting'])('unavailable Workspace %s refuses without a terms row', async lifecycle => {
  const f = await fixture(), workspaceId = lifecycle === 'missing' ? randomUUID() : f.workspaceId
  if (lifecycle !== 'missing') await stores.administrator.query('UPDATE workspace SET lifecycle=$1 WHERE id=$2', [lifecycle, workspaceId])
  await expect(assignBillingTerms(input(workspaceId), database, config, provider)).rejects.toThrow('Billing Workspace unavailable')
  expect(await count(workspaceId)).toBe(0)
})
test('exact retry is scoped to Workspace/account/environment and does not borrow a foreign revision', async () => {
  const a = await fixture(), b = await fixture()
  await assignBillingTerms(input(a.workspaceId), database, config, provider)
  await expect(assignBillingTerms(input(b.workspaceId, { expectedRevision: 1 }), database, config, provider)).rejects.toThrow('Billing offer conflict')
  const other = { ...config, accountId: 'acct_second' }
  expect(await assignBillingTerms(input(a.workspaceId, { accountId: other.accountId }), database, other, provider))
    .toMatchObject({ revision: 1, accountId: 'acct_second' })
  expect(await count(a.workspaceId)).toBe(2); expect(await count(b.workspaceId)).toBe(0)
})
test('native triggers preserve immutability/revision and runtime, relay and worker cannot assign', async () => {
  const f = await fixture(), assigned = await assignBillingTerms(input(f.workspaceId), database, config, provider)
  await expect(stores.administrator.query('UPDATE billing_agreed_terms SET monthly_unit_amount=1 WHERE id=$1', [assigned.id])).rejects.toMatchObject({ code: '23514' })
  await expect(stores.administrator.query('DELETE FROM billing_agreed_terms WHERE id=$1', [assigned.id])).rejects.toMatchObject({ code: '23514' })
  await expect(stores.administrator.query("INSERT INTO billing_agreed_terms(workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,'sandbox','acct_fixture',9,'price_fixture','eur',1500)", [f.workspaceId])).rejects.toMatchObject({ code: '23514' })
  await expect(pool.query("INSERT INTO billing_agreed_terms(workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,'sandbox','acct_fixture',2,'price_fixture','eur',1500)", [f.workspaceId])).rejects.toMatchObject({ code: '42501' })
  for (const role of ['runtime', 'billing_relay', 'billing_worker']) {
    expect((await stores.administrator.query("SELECT has_table_privilege($1,'billing_agreed_terms','INSERT,UPDATE,DELETE,TRUNCATE') AS allowed", [role])).rows[0].allowed).toBe(false)
    await stores.administrator.query('BEGIN')
    try {
      // SAFETY: role is selected only from this fixed fixture-owned list.
      await stores.administrator.query('SET LOCAL ROLE ' + role)
      await expect(stores.administrator.query("INSERT INTO billing_agreed_terms(workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,'sandbox','acct_fixture',2,'price_fixture','eur',1500)", [f.workspaceId])).rejects.toMatchObject({ code: '42501' })
    } finally { await stores.administrator.query('ROLLBACK') }
  }
  expect(await count(f.workspaceId)).toBe(1)
})
test('an unacknowledged real COMMIT is unknown, never replayed, and a later explicit retry observes its row', async () => {
  const f = await fixture(), args = input(f.workspaceId), admin = stores.administrator
  const proxy = startMigrationCommitProxy({ targetHost: '127.0.0.1', targetPort: admin.port, host: '127.0.0.1', port: 0 })
  try {
    const address = await proxy.ready, url = new URL(Redacted.value(database.url)); url.port = String(address.port)
    const uncertain = readMigrationConfig({ MIGRATION_DATABASE_URL: url.href })
    await expect(assignBillingTerms(args, uncertain, config, provider)).rejects.toThrow('Billing offer commit unknown; rerun the identical command to observe')
    expect(await count(f.workspaceId)).toBe(1)
    expect(await proxy.stop()).toEqual({ type: 'terminal', connections: 1, commits: 1, upstreamCompletions: 1, accepting: false, activeSockets: 0 })
    expect(await assignBillingTerms(args, database, config, provider)).toMatchObject({ revision: 1, status: 'existing' })
    expect(await count(f.workspaceId)).toBe(1)
  } finally { await proxy.stop() }
})
test('Checkout consumes its operator-assigned terms and retains its admitted conditions after a newer assignment', async () => {
  const f = await fixture(), sessionId = randomUUID()
  await stores.administrator.query("INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES($1,$2,$3,now()+interval '1 day','ACTIVE','passkey',now(),0,now())", [sessionId, randomUUID(), f.userId])
  await stores.administrator.query("INSERT INTO billing_customer(workspace_id,environment,account_id,stripe_customer_id) VALUES($1,'sandbox','acct_fixture','cus_fixture')", [f.workspaceId])
  const assigned = await assignBillingTerms(input(f.workspaceId), database, config, provider)
  const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  // SAFETY: only outbound Checkout effects are doubled; native admission/terms resolution runs.
  const checkout = { async retrievePrice(id: string) { return monthlyPrice({ id }) }, async createCustomer() { throw new Error('Unexpected Customer') },
    async createCheckout(intent: CheckoutIntent) {
      expect(intent.terms).toEqual({ id: assigned.id, monthlyPriceId: 'price_fixture', currency: 'eur', monthlyUnitAmount: 1500 })
      return { id: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/cs_test_fixture', expiresAt: Math.floor(Date.now() / 1000) + 3600 }
    } }
  const principal = { userId: f.userId, sessionId, name: 'Fixture', email: f.userId + '@example.test' }
  expect(await startCheckout(owner, principal, config, checkout, f.workspaceId)).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' })
  await assignBillingTerms(input(f.workspaceId, { expectedRevision: 1 }), database, config, provider)
  expect(await startCheckout(owner, principal, config, checkout, f.workspaceId)).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' })
  expect((await stores.administrator.query('SELECT agreed_terms_id FROM billing_operation WHERE workspace_id=$1', [f.workspaceId])).rows[0].agreed_terms_id).toBe(assigned.id)
})
test('the native Node24 imported assignment executes real SQL without a bundler', async () => {
  const f = await fixture()
  const code = "const {assignBillingTerms}=await import('./scripts/assign-billing-terms.ts'); const {readMigrationConfig}=await import('./src/platform/db/config.server.ts'); const {readStripeOperatorConfig}=await import('./src/modules/billing/stripe-config.server.ts'); const terms=JSON.parse(process.env.SYNTHETIC_TERMS); const price=JSON.parse(process.env.SYNTHETIC_PRICE); const result=await assignBillingTerms(terms,readMigrationConfig(process.env),readStripeOperatorConfig(process.env),()=>({async retrievePrice(){return price},async close(){}})); process.stdout.write(JSON.stringify(result));"
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...fixtureDockerEnvironment(), MIGRATION_DATABASE_URL: Redacted.value(database.url), STRIPE_API_KEY: 'sk_test_fixture',
      STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox', SYNTHETIC_TERMS: JSON.stringify(input(f.workspaceId)),
      SYNTHETIC_PRICE: JSON.stringify(monthlyPrice({ id: 'price_fixture' })) }, windowsHide: true, timeout: 15000,
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ workspaceId: f.workspaceId, revision: 1, status: 'assigned' })
  expect(result.stderr).toBe(''); expect(await count(f.workspaceId)).toBe(1)
})
