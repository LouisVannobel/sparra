import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { googleCeremony } from '../helpers/google-ceremony'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let limiter: ReturnType<typeof createAuthRateLimiter>, personal: ReturnType<typeof createPersonalWorkspaces>
let ceremony: ReturnType<typeof googleCeremony>
let auth: ReturnType<typeof createApplicationAuth>, peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(url => Number(new URL(url).port)) })
  const { createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server')
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 4 })
  const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'workspace', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  await limiter.connect()
  auth = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
  ceremony = googleCeremony(auth, owner, peer); personal = createPersonalWorkspaces(owner)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  const failures: unknown[] = []
  for (const close of [() => auth?.close(), () => limiter?.close(), () => pool?.end(), () => peer?.close(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Workspace integration cleanup failed')
})
const audit = async (id: string) => (await stores.administrator.query('SELECT action FROM workspace_audit WHERE workspace_id=$1 ORDER BY occurred_at,id', [id])).rows.map(row => row.action)

test('creates only on explicit ensure, reads and atomically renames using the real BA principal', async () => {
  const { principal } = await ceremony()
  expect(await personal.readWorkspace(principal)).toBeNull()
  const created = await personal.ensurePersonalWorkspace(principal)
  expect(created).toEqual({ id: expect.any(String), displayName: 'Workspace' })
  expect(await personal.ensurePersonalWorkspace(principal)).toEqual(created)
  expect(await personal.renameWorkspace(principal, created!.id, '  Mon espace  ')).toEqual({ id: created!.id, displayName: 'Mon espace' })
  expect(await personal.readWorkspace(principal, created!.id)).toEqual({ id: created!.id, displayName: 'Mon espace' })
  await personal.renameWorkspace(principal, created!.id, 'Mon espace')
  expect(await audit(created!.id)).toEqual(['personal-created', 'display-name-changed'])
})
test('two real connections provision the same owner with exactly one creation fact', async () => {
  const { principal } = await ceremony()
  const [a,b] = await Promise.all([personal.ensurePersonalWorkspace(principal), personal.ensurePersonalWorkspace(principal)])
  expect(a).not.toBeNull(); expect(b).toEqual(a)
  expect(await audit(a!.id)).toEqual(['personal-created'])
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace WHERE owner_user_id=$1', [principal.userId])).rows[0].n).toBe(1)
})
test.each(['revoked','recovering','generation','MFA_PENDING','RECOVERY_RESTRICTED','expired','idle','absolute'])('refuses stale %s admission without mutation or success fact', async state => {
  const { principal } = await ceremony()
  if (state === 'revoked') await stores.administrator.query('DELETE FROM session WHERE id=$1', [principal.sessionId])
  else if (state === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [principal.userId])
  else if (state === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=1 WHERE id=$1', [principal.userId])
  else if (state === 'expired') await stores.administrator.query("UPDATE session SET expires_at=now()-interval '1 second' WHERE id=$1", [principal.sessionId])
  else if (state === 'idle') await stores.administrator.query("UPDATE session SET last_activity_at=now()-interval '12 hours 1 second' WHERE id=$1", [principal.sessionId])
  else if (state === 'absolute') await stores.administrator.query("UPDATE session SET authenticated_at=now()-interval '7 days 1 second' WHERE id=$1", [principal.sessionId])
  else await stores.administrator.query('UPDATE session SET auth_state=$1 WHERE id=$2', [state,principal.sessionId])
  expect(await personal.ensurePersonalWorkspace(principal)).toBeNull()
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace_audit WHERE actor_user_id=$1', [principal.userId])).rows[0].n).toBe(0)
})
test.each(['provisioning','deleting'])('never promotes an existing %s Workspace', async lifecycle => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  await stores.administrator.query('UPDATE workspace SET lifecycle=$1 WHERE id=$2', [lifecycle,created!.id])
  expect(await personal.ensurePersonalWorkspace(principal)).toBeNull()
  expect(await personal.readWorkspace(principal, created!.id)).toBeNull()
  expect(await personal.renameWorkspace(principal, created!.id, 'Forbidden')).toBeNull()
  expect(await audit(created!.id)).toEqual(['personal-created'])
})
test('cross-user selector and forged actor/session fail without success facts', async () => {
  const a = await ceremony(), b = await ceremony(), created = await personal.ensurePersonalWorkspace(b.principal)
  expect(await personal.readWorkspace(a.principal, created!.id)).toBeNull()
  expect(await personal.renameWorkspace(a.principal, created!.id, 'Forbidden')).toBeNull()
  expect(await personal.ensurePersonalWorkspace({ ...a.principal, userId: b.principal.userId })).toBeNull()
  expect(await audit(created!.id)).toEqual(['personal-created'])
})
test.each(['creation','rename'])('audit failure rolls back %s', async mode => {
  const { principal } = await ceremony(), created = mode === 'rename' ? await personal.ensurePersonalWorkspace(principal) : null
  await stores.administrator.query("CREATE FUNCTION fixture_fail_workspace_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-audit-marker'; END $$; CREATE TRIGGER fixture_fail_workspace_audit BEFORE INSERT ON workspace_audit FOR EACH ROW EXECUTE FUNCTION fixture_fail_workspace_audit()")
  try {
    const failure = await (created ? personal.renameWorkspace(principal, created.id, 'Rolled back') : personal.ensurePersonalWorkspace(principal)).catch(error => error)
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain('private-audit-marker')
    const rows = (await stores.administrator.query('SELECT display_name FROM workspace WHERE owner_user_id=$1', [principal.userId])).rows
    expect(rows).toEqual(created ? [{ display_name: 'Workspace' }] : [])
  } finally { await stores.administrator.query('DROP TRIGGER fixture_fail_workspace_audit ON workspace_audit; DROP FUNCTION fixture_fail_workspace_audit()') }
})
test('owner deletion is restricted, copied append-only audit survives explicit parent deletion', async () => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  await expect(stores.administrator.query('DELETE FROM "user" WHERE id=$1', [principal.userId])).rejects.toMatchObject({ code: '23503' })
  await expect(stores.administrator.query("UPDATE workspace_audit SET action='display-name-changed' WHERE workspace_id=$1", [created!.id])).rejects.toMatchObject({ code: '23514' })
  await expect(stores.administrator.query('DELETE FROM workspace_audit WHERE workspace_id=$1', [created!.id])).rejects.toMatchObject({ code: '23514' })
  await stores.administrator.query('DELETE FROM workspace WHERE id=$1', [created!.id])
  await stores.administrator.query('DELETE FROM "user" WHERE id=$1', [principal.userId])
  expect(await audit(created!.id)).toEqual(['personal-created'])
})
test('revocation holding the User lock wins over a waiting resolver', async () => {
  const { principal } = await ceremony()
  const revoker = new Client({ connectionString: stores.directRuntimeUrl }); await revoker.connect()
  try {
    await revoker.query('BEGIN'); await revoker.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [principal.userId])
    const pending = personal.ensurePersonalWorkspace(principal)
    await expect.poll(async () => (await stores.administrator.query("SELECT exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'SELECT app_private.resolve_personal_workspace%') AS waiting")).rows[0].waiting, { timeout: 750, interval: 10 }).toBe(true)
    await revoker.query('SELECT id FROM session WHERE id=$1 FOR UPDATE', [principal.sessionId])
    await revoker.query('DELETE FROM session WHERE id=$1', [principal.sessionId]); await revoker.query('COMMIT')
    expect(await pending).toBeNull()
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace WHERE owner_user_id=$1', [principal.userId])).rows[0].n).toBe(0)
  } finally { await revoker.end() }
})
test('catalog proves non-owner definer, forced RLS, pinned function and no PUBLIC or membership escalation', async () => {
  const row = (await stores.administrator.query(`SELECT r.rolname AS owner,r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,p.prosecdef,p.provolatile,p.proconfig
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='app_private.resolve_personal_workspace(text,text,boolean)'::regprocedure`)).rows[0]
  expect(row).toEqual({ owner: 'workspace_bootstrap', rolcanlogin:false, rolsuper:false, rolbypassrls:false, rolinherit:false, rolcreaterole:false, rolcreatedb:false, rolreplication:false, prosecdef:true, provolatile:'v', proconfig:['search_path=pg_catalog, pg_temp'] })
  const tables = (await stores.administrator.query("SELECT c.relname,r.rolname AS owner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid in ('workspace'::regclass,'workspace_audit'::regclass) ORDER BY c.relname")).rows
  expect(tables).toEqual(['workspace','workspace_audit'].map(relname => ({relname,owner:'workspace_owner',relrowsecurity:true,relforcerowsecurity:true})))
  expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname IN ('runtime','workspace_owner','workspace_bootstrap')")).rows[0].n).toBe(0)
  expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='app_private.resolve_personal_workspace(text,text,boolean)'::regprocedure AND a.grantee=0")).rows[0].n).toBe(0)
  expect((await stores.administrator.query("SELECT has_column_privilege('workspace_bootstrap','session','token','SELECT') AS token,has_table_privilege('runtime','workspace','INSERT,DELETE') AS mutation,has_table_privilege('runtime','workspace_audit','SELECT,UPDATE,DELETE') AS audit_mutation")).rows[0]).toEqual({ token:false,mutation:false,audit_mutation:false })
  await stores.administrator.query('CREATE ROLE fixture_workspace_unpermitted NOLOGIN; GRANT USAGE ON SCHEMA app_private TO fixture_workspace_unpermitted; BEGIN; SET LOCAL ROLE fixture_workspace_unpermitted')
  try { await expect(stores.administrator.query("SELECT app_private.resolve_personal_workspace('forged','forged',true)")).rejects.toMatchObject({ code:'42501' }) }
  finally { await stores.administrator.query('ROLLBACK') }
})
test('bootstrap validates missing/malformed correlation and exact actor/session before even an existing lookup', async () => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  const client = new Client({ connectionString: stores.directRuntimeUrl }); await client.connect()
  try {
    for (const correlation of [undefined,'','forged',randomUUID()]) {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
      if (correlation !== undefined) await client.query("SELECT set_config('app.correlation_id',$1,true)", [correlation])
      const resolved = (await client.query('SELECT app_private.resolve_personal_workspace($1,$2,false) AS id', [principal.userId,principal.sessionId])).rows[0].id
      expect(resolved).toBe(correlation && correlation !== 'forged' ? created!.id : null)
      expect((await client.query('SELECT app_private.resolve_personal_workspace($1,$2,true) AS id', [principal.userId,'forged'])).rows[0].id).toBeNull()
      await client.query('ROLLBACK')
    }
    expect(await audit(created!.id)).toEqual(['personal-created'])
  } finally { await client.end() }
})
test.each(['user','session','workspace'])('bootstrap cannot lock %s without required UPDATE privilege', async table => {
  const { principal } = await ceremony()
  await stores.administrator.query(`REVOKE UPDATE(id) ON public."${table}" FROM workspace_bootstrap`)
  try { await expect(personal.ensurePersonalWorkspace(principal)).rejects.toMatchObject({ name:'PgTransactionError' }) }
  finally { await stores.administrator.query(`GRANT UPDATE(id) ON public."${table}" TO workspace_bootstrap`) }
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace_audit WHERE actor_user_id=$1', [principal.userId])).rows[0].n).toBe(0)
})
test('FORCE RLS bootstrap insert policy is required even with table privileges', async () => {
  const { principal } = await ceremony()
  await stores.administrator.query('ALTER POLICY workspace_bootstrap ON workspace WITH CHECK (false)')
  try { await expect(personal.ensurePersonalWorkspace(principal)).rejects.toMatchObject({ name:'PgTransactionError' }) }
  finally { await stores.administrator.query("ALTER POLICY workspace_bootstrap ON workspace WITH CHECK (current_setting('app.tenant_id',true)='00000000-0000-0000-0000-000000000000')") }
})
test.each(['','   ','x'.repeat(81),'line\nbreak','line\u2028break'])('SQL rejects invalid stored display name %#', async displayName => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  await expect(stores.administrator.query('UPDATE workspace SET display_name=$1 WHERE id=$2',[displayName,created!.id])).rejects.toMatchObject({code:'23514'})
})
test.each([' '.repeat(100000)+'x','x'+' '.repeat(100000)])('SQL rejects overlong padded stored display name %#', async displayName => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  await expect(stores.administrator.query('UPDATE workspace SET display_name=$1 WHERE id=$2',[displayName,created!.id])).rejects.toMatchObject({code:'23514'})
})
test.each(['x'.repeat(80),' '.repeat(79)+'x','x'+' '.repeat(79)])('SQL accepts exact raw display-name bound %#', async displayName => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  const result = await stores.administrator.query('UPDATE workspace SET display_name=$1 WHERE id=$2 RETURNING length(display_name) AS length',[displayName,created!.id])
  expect(result.rows).toEqual([{length:80}])
})
test('real runtime RLS and confined bootstrap reject missing, zero, malformed and foreign scope; pool reuse clears tenant', async () => {
  const { principal } = await ceremony(), created = await personal.ensurePersonalWorkspace(principal)
  const client = new Client({ connectionString: stores.runtimeUrl }); await client.connect()
  try {
    for (const tenant of [undefined, '', 'bad-uuid', randomUUID(), '00000000-0000-0000-0000-000000000000']) {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.correlation_id',$1,true)", [randomUUID()])
      if (tenant !== undefined) await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant])
      expect((await client.query('SELECT id FROM workspace')).rows).toEqual([])
      const resolved = (await client.query('SELECT app_private.resolve_personal_workspace($1,$2,false) AS id', [principal.userId, principal.sessionId])).rows[0].id
      expect(resolved).toBe(tenant === '00000000-0000-0000-0000-000000000000' ? created!.id : null)
      await client.query('ROLLBACK')
    }
    for (const terminal of ['COMMIT','ROLLBACK']) {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [created!.id])
      expect((await client.query('SELECT id FROM workspace')).rows).toEqual([{ id: created!.id }])
      await client.query(terminal)
      await client.query('BEGIN'); expect((await client.query('SELECT id FROM workspace')).rows).toEqual([]); await client.query('ROLLBACK')
    }
    await expect(client.query('SET ROLE workspace_bootstrap')).rejects.toMatchObject({ code: '42501' })
  } finally { await client.end() }
})
