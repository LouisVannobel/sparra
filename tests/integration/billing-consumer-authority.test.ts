import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Effect } from 'effect'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { acquireDatabase } from '../../src/platform/db/resources.server'
import { readDatabaseConfig } from '../../src/platform/db/config.server'
import { billingCustomer } from '../../src/modules/billing/schema.server'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let owner: ReturnType<typeof createTransactions>
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
})
afterAll(async () => {
  try { await pool?.end() } finally { await stores?.cleanup() }
})
const options = () => ({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
async function fixture() {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,\'Fixture\',$2,true)', [userId, userId + '@example.test'])
  await stores.administrator.query("INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES($1,$2,$3,now()+interval '1 day','ACTIVE','passkey',now(),0,now())", [sessionId, randomUUID(), userId])
  await stores.administrator.query("INSERT INTO workspace(id,kind,lifecycle,owner_user_id) VALUES($1,'personal','active',$2)", [workspaceId, userId])
  return { principal: { userId, sessionId, name: 'Fixture', email: userId + '@example.test' }, workspaceId }
}

test('native financial lease admits a fresh passkey and exposes only that Workspace', async () => {
  const a = await fixture(), b = await fixture()
  for (const [input, customer] of [[a, 'cus_fixtureA'], [b, 'cus_fixtureB']] as const) {
    await stores.administrator.query("INSERT INTO billing_customer(workspace_id,environment,account_id,stripe_customer_id) VALUES($1,'sandbox','acct_fixture',$2)", [input.workspaceId, customer])
  }
  expect(await owner.withBillingWorkspacePromise(options(), a.principal, a.workspaceId, async lease => lease!.db.select({ customer: billingCustomer.stripeCustomerId }).from(billingCustomer))).toEqual([{ customer: 'cus_fixtureA' }])
  expect(await owner.withBillingWorkspacePromise(options(), a.principal, b.workspaceId, async lease => lease)).toBeNull()
  expect(await owner.withBillingWorkspacePromise(options(), { ...a.principal, sessionId: b.principal.sessionId }, a.workspaceId, async lease => lease)).toBeNull()
})

test.each([
  ['Google session', "UPDATE session SET auth_method='google' WHERE id=$1", 'session'],
  ['stale passkey', "UPDATE session SET authenticated_at=now()-interval '301 seconds' WHERE id=$1", 'session'],
  ['pending session', "UPDATE session SET auth_state='MFA_PENDING' WHERE id=$1", 'session'],
  ['expired session', "UPDATE session SET expires_at=now()-interval '1 second' WHERE id=$1", 'session'],
  ['stale activity', "UPDATE session SET last_activity_at=now()-interval '43201 seconds' WHERE id=$1", 'session'],
  ['future passkey', "UPDATE session SET authenticated_at=now()+interval '1 minute' WHERE id=$1", 'session'],
  ['generation mismatch', 'UPDATE "user" SET recovery_generation=1 WHERE id=$1', 'user'],
  ['recovery', 'UPDATE "user" SET recovering=true WHERE id=$1', 'user'],
  ['hold', "UPDATE \"user\" SET hold_until=now()+interval '1 hour' WHERE id=$1", 'user'],
  ['unverified email', 'UPDATE "user" SET email_verified=false WHERE id=$1', 'user'],
  ['deleting Workspace', "UPDATE workspace SET lifecycle='deleting' WHERE id=$1", 'workspace'],
] as const)('native financial authority refuses %s', async (_label, mutation, target) => {
  const input = await fixture()
  await stores.administrator.query(mutation, [target === 'user' ? input.principal.userId : target === 'workspace' ? input.workspaceId : input.principal.sessionId])
  expect(await owner.withBillingWorkspacePromise(options(), input.principal, input.workspaceId, async lease => lease)).toBeNull()
})

test('technical billing logins enforce exact function grants, FORCE RLS and no role impersonation', async () => {
  const roles = (await stores.administrator.query("SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname IN ('billing_owner','billing_definer','billing_relay','billing_worker') ORDER BY rolname")).rows
  expect(roles).toEqual(['billing_definer', 'billing_owner', 'billing_relay', 'billing_worker'].map(rolname => ({ rolname, rolcanlogin: ['billing_relay', 'billing_worker'].includes(rolname), rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false })))
  expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'billing_%' AND relkind='r' AND (NOT relrowsecurity OR NOT relforcerowsecurity)")).rows[0].n).toBe(0)
  for (const login of ['billing_relay', 'billing_worker'] as const) {
    const password = randomBytes(24).toString('hex')
    await stores.administrator.query(`ALTER ROLE ${login} PASSWORD '${password}'`)
    const url = new URL(stores.directRuntimeUrl); url.username = login; url.password = password
    const config = readDatabaseConfig({ DATABASE_URL: url.href, DB_POOL_MAX: '1' })
    expect(await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* acquireDatabase(config, login)
      return database.isReady()
    })))).toBe(true)
  }
  const functions = (await stores.administrator.query("SELECT p.proname,has_function_privilege('billing_relay',p.oid,'EXECUTE') AS relay,has_function_privilege('billing_worker',p.oid,'EXECUTE') AS worker FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND (has_function_privilege('billing_relay',p.oid,'EXECUTE') OR has_function_privilege('billing_worker',p.oid,'EXECUTE')) ORDER BY p.proname")).rows
  expect(functions).toEqual([
    { proname: 'billing_apply_command', relay: false, worker: true },
    { proname: 'billing_claim_admission', relay: true, worker: false },
    { proname: 'billing_claim_command', relay: false, worker: true },
    { proname: 'billing_finalize_admission', relay: true, worker: false },
    { proname: 'billing_observe_command', relay: false, worker: true },
    { proname: 'billing_record_risk', relay: false, worker: true },
  ])
})
