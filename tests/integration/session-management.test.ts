import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { bounded } from '../helpers/web-process'
import type { SessionManagementInvocation } from '../../src/modules/auth/session-management-native.server'

const observed = vi.hoisted(() => ({ token: '', fault: '', nativeCalls: 0, sessionReads: 0, sessionFlags: 0, tailReached: false,
  hold: false, failHeld: false, heldPid: 0, entered: () => {}, gate: Promise.resolve(),
  captureCapability: false, retained: undefined as SessionManagementInvocation | undefined, retainedRequest: undefined as Request | undefined,
  foreignToken: '', copiedRequestRefused: false, auditDelayCompleted: 0 }))
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('better-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth')>()
  return { ...actual, betterAuth(options: Parameters<typeof actual.betterAuth>[0]) {
    return actual.betterAuth({ ...options, databaseHooks: { ...options.databaseHooks, session: {
      delete: { before: async () => observed.fault === 'delete-veto' ? false : undefined,
        after: async () => { if (observed.fault === 'delete-after') { await Promise.resolve(); throw new Error('Owned session after-hook refusal') } } },
    }, verification: { delete: { before: async (_data, ctx) => {
      if (observed.fault === 'cleanup-veto') return false
      if (observed.fault === 'cleanup-phantom' && ctx) {
        await ctx.context.internalAdapter.createVerificationValue({ identifier: _data.identifier, value: _data.value, expiresAt: _data.expiresAt })
      }
    } } } } })
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { APIError, createAuthMiddleware } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
      if (args[8]?.(ctx.request) && ctx.path === '/get-session') {
        observed.sessionReads++
        if (ctx.query?.disableCookieCache === true && ctx.query?.disableRefresh === true) observed.sessionFlags++
      }
      return before({ ...ctx, returnHeaders: false })
    }) }], after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/application/session-management', handler: createAuthMiddleware(async ctx => {
      observed.nativeCalls++; observed.tailReached = true
      if (observed.captureCapability) {
        const authority = args[8]?.(ctx.request)
        if (!authority || !ctx.request) throw new Error('Owned capability missing')
        observed.retained = authority; observed.retainedRequest = ctx.request
        const copied = new Request(ctx.request)
        const symbol = Object.getOwnPropertySymbols(ctx.request).find(symbol => Object.getOwnPropertyDescriptor(ctx.request!, symbol)?.value === authority)
        if (!symbol) throw new Error('Owned descriptor missing')
        Object.defineProperty(copied, symbol, Object.getOwnPropertyDescriptor(ctx.request, symbol)!)
        try { authority.assert('execute', copied) } catch { observed.copiedRequestRefused = true }
      }
      if (observed.hold) {
        observed.hold = false
        const [connection] = await args[0].currentDb().select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(select 1) as fixture_backend`)
        observed.heldPid = connection.pid; observed.entered(); await observed.gate
        if (observed.failHeld) throw new Error('Owned overlapping first attempt refusal')
      }
      if (observed.fault === 'native-tail') { await Promise.resolve(); throw new Error('Owned native tail refusal') }
      if (observed.fault === 'native-api-error') throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Owned API refusal' })
      if (observed.fault === 'resolved-response') ctx.context.returned = new Response('Owned error', { status: 500 })
      if (observed.fault === 'wrong-result') ctx.context.returned = { completed: false }
      if (observed.fault === 'bulk-alias') await ctx.context.internalAdapter.deleteUserSessions('unrelated-user')
      if (observed.fault === 'foreign-token') await ctx.context.internalAdapter.deleteSession(observed.foreignToken)
      if (observed.fault === 'refresh-alias') await ctx.context.internalAdapter.refreshUserSessions({ id: 'unrelated', name: 'Fixture', email: 'fixture@example.test', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    }) }] } }
  } }
})

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let owner: ReturnType<typeof createTransactions>, app: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
let config: Parameters<typeof createApplicationAuth>[1]
let ip = 1
const qualification: Record<string, unknown> = {}
const overlaps: { firstPid: number; secondPid: number; rollbackFirst: boolean; first: string; second: string; facts: number }[] = []
const cookies = (headers: Headers) => headers.getSetCookie().filter(value => !/;\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
function request(cookie = '') {
  const value = Object.assign(new Request(origin + '/session-management', { method: 'POST', headers: { cookie, origin,
    'x-real-ip': `198.18.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return value
}
async function enroll() {
  const email = `session-${randomUUID()}@example.test`
  await app.requestMagicLink(request(), { email, locale: 'en' })
  const proof = { token: observed.token, intendedEmail: email }
  const options = await magicConsumeResponse(request(), proof, app, limiter)
  expect(options.status).toBe(200)
  const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
  const enrolled = await magicEnrollmentResponse(request(cookies(options.headers)), { ...proof, response: credential.response }, app, limiter)
  expect(enrolled.status).toBe(200)
  const cookie = cookies(enrolled.headers), principal = await app.requirePrincipal(request(cookie))
  const workspace = await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal)
  if (!workspace) throw new Error('Owned fixture Workspace missing')
  const login = await app.beginPasskeySignIn(request())
  const second = await app.finishPasskeySignIn(request(cookies(login.headers)), { response: credential.authenticationResponse(login.options) })
  const targetCookie = cookies(second.headers), target = await app.requirePrincipal(request(targetCookie))
  return { cookie, credential, principal, workspace, targetCookie, target }
}
async function scope(userId: string) {
  const rows = await stores.administrator.query(`SELECT * FROM (
    SELECT 'user' kind,to_jsonb(u) value FROM "user" u WHERE id=$1 UNION ALL
    SELECT 'session',to_jsonb(s) FROM session s WHERE user_id=$1 UNION ALL
    SELECT 'key',to_jsonb(k) FROM passkey k WHERE user_id=$1 UNION ALL
    SELECT 'workspace',to_jsonb(w) FROM workspace w WHERE owner_user_id=$1 UNION ALL
    SELECT 'proof',to_jsonb(v) FROM verification v WHERE identifier LIKE 'application-session-v1:' || encode(convert_to($1,'UTF8'),'hex') || ':%' UNION ALL
    SELECT 'fact',to_jsonb(f) FROM auth_session_revocation f WHERE actor_user_id=$1
  ) entries ORDER BY kind,value::text`, [userId])
  return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex')
}
async function original(id: string) {
  const rows = (await stores.administrator.query('SELECT * FROM session WHERE id=$1', [id])).rows
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
async function protectedStatus(cookie: string) { return app.requirePrincipal(request(cookie)).then(() => 200, error => error instanceof Response ? error.status : 500) }

beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrateSessionManagementPrefix()
  const id = randomUUID(), sid = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [id, 'Migration fixture', `migration-${id}@example.test`])
  await stores.administrator.query(`INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,last_activity_at,recovery_generation)
    VALUES($1,$2,$3,clock_timestamp()+interval '7 days','ACTIVE','passkey',clock_timestamp(),clock_timestamp(),0)`, [sid, randomBytes(32).toString('hex'), id])
  const before = await original(sid), journal = (await stores.administrator.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows
  await stores.migrate(); await stores.migrate()
  expect(await original(sid)).toEqual(before)
  const after = (await stores.administrator.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows
  expect(after.slice(0, 11)).toEqual(journal); expect(after.length).toBe(12)
  qualification.migration = { prefix: 11, final: 12, nonemptySessionPreserved: true, priorJournalPreserved: true, rerun: true }
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
    GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
    GRANT INSERT ON public.auth_session_revocation TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
    GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
    GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime; GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
  pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
  pool.on('connect', client => { client.on('notice', notice => { if (notice.message === 'fixture-audit-delay-complete') observed.auditDelayCompleted++ }) })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'session-management-native', TRUSTED_PROXY_IPS: '127.0.0.1' })); await limiter.connect()
  config = { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
    magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }
  app = createApplicationAuth(owner, config, limiter)
})
afterAll(async () => {
  observed.fault = ''
  const failures: string[] = []
  for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()], ['stores', () => stores?.cleanup()]] as const) {
    try { await close() } catch { failures.push(name) }
  }
  if (stores) {
    const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-10a-evidence')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`), JSON.stringify({ stores: stores.evidence, failures, qualification,
      nativeCalls: observed.nativeCalls, sessionReads: observed.sessionReads, sessionFlags: observed.sessionFlags, overlaps }, null, 2) + '\n', { flag: 'wx' })
  }
  expect(failures).toEqual([])
})

test('fresh signed UV in a valid older-than-24h session during hold revokes exactly the other native session without touching original authority', async () => {
  const f = await enroll()
  expect(await protectedStatus(f.targetCookie)).toBe(200)
  await stores.administrator.query("UPDATE session SET created_at=clock_timestamp()-interval '2 days',authenticated_at=clock_timestamp()-interval '2 days' WHERE id=$1", [f.principal.sessionId])
  await stores.administrator.query("UPDATE \"user\" SET hold_until=clock_timestamp()+interval '1 day' WHERE id=$1", [f.principal.userId])
  const before = await original(f.principal.sessionId)
  const begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const result = await app.finishSessionRevocation(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
  expect(result).toEqual({ revoked: true, sessionId: f.target.sessionId })
  expect(await original(f.principal.sessionId)).toEqual(before)
  expect(await protectedStatus(f.targetCookie)).toBe(401)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM auth_session_revocation WHERE actor_user_id=$1 AND target_session_id=$2', [f.principal.userId, f.target.sessionId])).rows[0].n).toBe(1)
  expect(await protectedStatus(f.cookie)).toBe(200)
  expect(observed.sessionReads).toBe(observed.sessionFlags)
  qualification.positive = { originalUnchangedBeforeOrdinaryActivity: true, revokedCookieStatus: 401, originalPrivateStatus: 200, facts: 1, holdAllowed: true }
})

test.each(['delete-veto', 'delete-after', 'native-tail', 'native-api-error', 'resolved-response', 'wrong-result', 'bulk-alias'])('%s restores target, proof, key and audit exactly; later authorized retry succeeds', async fault => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }, before = await scope(f.principal.userId)
  observed.fault = fault; observed.tailReached = false
  try { await expect(app.finishSessionRevocation(request(f.cookie), input)).rejects.toBeDefined() } finally { observed.fault = '' }
  expect(await scope(f.principal.userId)).toEqual(before)
  if (!['delete-veto', 'delete-after'].includes(fault)) expect(observed.tailReached).toBe(true)
  expect(await app.finishSessionRevocation(request(f.cookie), input)).toEqual({ revoked: true, sessionId: f.target.sessionId })
})

test('audit SQL failure and a trigger-vetoed INSERT both roll back deletion and consumed proof without SELECT grant', async () => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }, before = await scope(f.principal.userId)
  await stores.administrator.query('REVOKE INSERT ON auth_session_revocation FROM runtime')
  try { await expect(app.finishSessionRevocation(request(f.cookie), input)).rejects.toBeDefined() }
  finally { await stores.administrator.query('GRANT INSERT ON auth_session_revocation TO runtime') }
  expect(await scope(f.principal.userId)).toEqual(before)
  await stores.administrator.query(`CREATE FUNCTION public.fixture_skip_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER fixture_skip_revocation BEFORE INSERT ON auth_session_revocation FOR EACH ROW EXECUTE FUNCTION public.fixture_skip_revocation()`)
  try { await expect(app.finishSessionRevocation(request(f.cookie), input)).rejects.toBeDefined() }
  finally { await stores.administrator.query('DROP TRIGGER fixture_skip_revocation ON auth_session_revocation; DROP FUNCTION public.fixture_skip_revocation()') }
  expect(await scope(f.principal.userId)).toEqual(before)
  expect(await app.finishSessionRevocation(request(f.cookie), input)).toEqual({ revoked: true, sessionId: f.target.sessionId })
})

test('runtime audit role has INSERT only and tenant scope cannot insert a fact', async () => {
  for (const command of ['SELECT * FROM auth_session_revocation', 'UPDATE auth_session_revocation SET actor_user_id=actor_user_id', 'DELETE FROM auth_session_revocation']) {
    expect(await pool.query(command).then(() => 'accepted', (error: { code?: string }) => error.code)).toBe('42501')
  }
  expect(await pool.query('INSERT INTO auth_session_revocation(id,actor_user_id,authorizing_session_id,target_session_id,workspace_id,correlation_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',
    [randomUUID(), 'fixture', 'authorizing', 'target', randomUUID(), randomUUID()]).then(() => 'accepted', (error: { code?: string }) => error.code)).toBe('42501')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tenantId = randomUUID()
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
    expect(await client.query('INSERT INTO auth_session_revocation(id,actor_user_id,authorizing_session_id,target_session_id,workspace_id,correlation_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',
      [randomUUID(), 'fixture', 'authorizing', 'target', tenantId, randomUUID()]).then(() => 'accepted', (error: { code?: string }) => error.code)).toBe('42501')
  } finally { try { await client.query('ROLLBACK') } finally { client.release() } }
  qualification.auditPrivileges = { insertOnly: true, absentScopeDenied: true, nonzeroTenantScopeDenied: true }
})

function holdNative(rollbackFirst = false) {
  let release = () => {}, enter = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve })
  observed.gate = new Promise<void>(resolve => { release = resolve })
  observed.entered = enter; observed.hold = true; observed.failHeld = rollbackFirst
  return { entered, release }
}

test.each([false, true])('N2 independent overlapping backends produce one fact, including first-attempt rollback=%s', async rollbackFirst => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }
  const originalBefore = await original(f.principal.sessionId)
  const firstPool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 }), secondPool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  const make = (connection: Pool) => createApplicationAuth(createTransactions(connection, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), config, limiter)
  const firstApp = make(firstPool), secondApp = make(secondPool)
  const firstPid = (await firstPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const secondPid = (await secondPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  expect(firstPid).not.toBe(secondPid)
  const gate = holdNative(rollbackFirst)
  let one: Promise<string> | undefined, two: Promise<string> | undefined
  try {
    one = firstApp.finishSessionRevocation(request(f.cookie), input).then(() => 'confirmed', () => 'refused')
    await bounded(gate.entered, 8000)
    expect(observed.heldPid).toBe(firstPid)
    two = secondApp.finishSessionRevocation(request(f.cookie), input).then(() => 'confirmed', () => 'refused')
    await expect.poll(async () => (await stores.administrator.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [secondPid])).rows[0].n,
      { timeout: 800, interval: 20 }).toBe(1)
    gate.release()
    const first = await one, second = await two
    expect([first, second]).toEqual(rollbackFirst ? ['refused', 'confirmed'] : ['confirmed', 'refused'])
    const facts = (await stores.administrator.query('SELECT count(*)::int n FROM auth_session_revocation WHERE actor_user_id=$1', [f.principal.userId])).rows[0].n
    expect(facts).toBe(1); expect(await original(f.principal.sessionId)).toBe(originalBefore)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(2)
    overlaps.push({ firstPid, secondPid, rollbackFirst, first, second, facts })
  } finally {
    gate.release(); observed.hold = false
    await Promise.allSettled([one, two]); observed.failHeld = false
    await Promise.all([firstApp.close(), secondApp.close()]); await Promise.all([firstPool.end(), secondPool.end()])
  }
})

test('N2 target, original-session and foreign-User substitutions preserve the exact proof and every session', async () => {
  const f = await enroll(), foreign = await enroll()
  const beforeBegin = await scope(f.principal.userId), foreignBefore = await scope(foreign.principal.userId)
  await expect(app.beginSessionRevocation(request(f.cookie), { sessionId: f.principal.sessionId })).rejects.toBeDefined()
  await expect(app.beginSessionRevocation(request(f.cookie), { sessionId: foreign.target.sessionId })).rejects.toBeDefined()
  expect(await scope(f.principal.userId)).toBe(beforeBegin); expect(await scope(foreign.principal.userId)).toBe(foreignBefore)
  const begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }, before = await scope(f.principal.userId)
  for (const cookie of [f.targetCookie, foreign.cookie]) {
    await expect(app.finishSessionRevocation(request(cookie), input)).rejects.toBeDefined()
    expect(await scope(f.principal.userId)).toBe(before); expect(await scope(foreign.principal.userId)).toBe(foreignBefore)
  }
  await expect(app.finishSessionRevocation(request(f.cookie), { ...input, sessionId: foreign.target.sessionId })).rejects.toBeDefined()
  expect(await scope(f.principal.userId)).toBe(before)
  expect(await app.finishSessionRevocation(request(f.cookie), input)).toEqual({ revoked: true, sessionId: f.target.sessionId })
})

test.each(['restricted', 'recovering', 'generation', 'workspace', 'key'])('N2 %s authority loss refuses without consuming the proof or changing the target', async mutation => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }
  const key = (await stores.administrator.query('SELECT public_key FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0]
  if (mutation === 'restricted') await stores.administrator.query("UPDATE session SET auth_state='RECOVERY_RESTRICTED' WHERE id=$1", [f.principal.sessionId])
  if (mutation === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [f.principal.userId])
  if (mutation === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [f.principal.userId])
  if (mutation === 'workspace') await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE owner_user_id=$1", [f.principal.userId])
  if (mutation === 'key') await stores.administrator.query("UPDATE passkey SET public_key='AQ==' WHERE user_id=$1", [f.principal.userId])
  const before = await scope(f.principal.userId)
  try { await expect(app.finishSessionRevocation(request(f.cookie), input)).rejects.toBeDefined(); expect(await scope(f.principal.userId)).toBe(before) }
  finally {
    if (mutation === 'restricted') await stores.administrator.query("UPDATE session SET auth_state='ACTIVE' WHERE id=$1", [f.principal.sessionId])
    if (mutation === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=false WHERE id=$1', [f.principal.userId])
    if (mutation === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation-1 WHERE id=$1', [f.principal.userId])
    if (mutation === 'workspace') await stores.administrator.query("UPDATE workspace SET lifecycle='active' WHERE owner_user_id=$1", [f.principal.userId])
    if (mutation === 'key') await stores.administrator.query('UPDATE passkey SET public_key=$2 WHERE user_id=$1', [f.principal.userId, key.public_key])
  }
  expect(await app.finishSessionRevocation(request(f.cookie), input)).toEqual({ revoked: true, sessionId: f.target.sessionId })
})

async function shortenProof(userId: string, challengeId: string, milliseconds: number) {
  const expiresAt = new Date(Date.now() + milliseconds)
  await stores.administrator.query(`UPDATE verification SET expires_at=$2, value=jsonb_set(value::jsonb,'{expiresAt}',to_jsonb($3::text))::text
    WHERE identifier='application-session-v1:' || encode(convert_to($1,'UTF8'),'hex') || ':' || $4`, [userId, expiresAt, expiresAt.toISOString(), challengeId])
  return expiresAt
}
test('N2 deadline expires during an actual User lock wait without consuming proof or advancing counter', async () => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const expiresAt = await shortenProof(f.principal.userId, begin.challengeId, 800)
  const before = await scope(f.principal.userId), input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }
  await stores.administrator.query('BEGIN')
  await stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [f.principal.userId])
  const work = app.finishSessionRevocation(request(f.cookie), input).then(() => undefined, error => error)
  try {
    await expect.poll(async () => (await stores.administrator.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock'")).rows[0].n,
      { timeout: 500, interval: 10 }).toBe(1)
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)))
  } finally { await stores.administrator.query('ROLLBACK') }
  const error = await work
  expect(app.sessionManagementErrorResponse(error)?.status).toBe(400)
  expect(await scope(f.principal.userId)).toBe(before)
})
test('N2 deadline at awaited native tail rolls back consumed proof, advanced counter and deletion', async () => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  await shortenProof(f.principal.userId, begin.challengeId, 900)
  const before = await scope(f.principal.userId), gate = holdNative()
  const work = app.finishSessionRevocation(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }).then(() => undefined, error => error)
  try { await bounded(gate.entered, 8000); await new Promise(resolve => setTimeout(resolve, 1000)); gate.release() }
  finally { gate.release(); observed.hold = false }
  expect(app.sessionManagementErrorResponse(await work)?.status).toBe(400)
  expect(await scope(f.principal.userId)).toBe(before)
})
test('N2 native expired-original cleanup is rolled back with no published cookie or success', async () => {
  const f = await enroll()
  await stores.administrator.query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.principal.sessionId])
  const before = await scope(f.principal.userId)
  const error = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId }).then(() => undefined, error => error)
  expect(app.sessionManagementErrorResponse(error)?.status).toBe(401)
  expect(app.sessionManagementErrorResponse(error)?.headers.getSetCookie()).toEqual([])
  expect(await scope(f.principal.userId)).toBe(before)
})
test('N2 actual canonical Redis denial and outage precede proof creation or protected changes', async () => {
  const f = await enroll(), client = '192.0.2.212'
  function sameClient() { const r = request(f.cookie); r.headers.set('x-real-ip', client); return r }
  for (let i = 0; i < 5; i++) await app.beginSessionRevocation(sameClient(), { sessionId: f.target.sessionId })
  const before = await scope(f.principal.userId)
  const error = await app.beginSessionRevocation(sameClient(), { userId: 'malformed' }).then(() => undefined, error => error)
  expect(limiter.errorResponse(error)?.status).toBe(429); expect(await scope(f.principal.userId)).toBe(before)
  await stores.restartRedis(async () => {
    const failed = await app.beginSessionRevocation(request(f.cookie), { userId: 'malformed' }).then(() => undefined, error => error)
    expect(limiter.errorResponse(failed)?.status).toBe(503); expect(await scope(f.principal.userId)).toBe(before)
  })
})

test('N3 actual LIST paginates equal-createdAt sessions and reconciles an exact target beyond page1, then ineligible and absent', async () => {
  const f = await enroll(), foreign = await enroll()
  let counter = 1
  async function addSession() {
    const begun = await app.beginPasskeySignIn(request())
    return app.finishPasskeySignIn(request(cookies(begun.headers)), { response: f.credential.authenticationResponse(begun.options, { counter: ++counter }) })
  }
  for (let i = 0; i < 26; i++) await addSession()
  const equalCreatedAt = new Date(Date.now() - 172800000)
  await stores.administrator.query('UPDATE session SET created_at=$2 WHERE user_id=$1', [f.principal.userId, equalCreatedAt])
  await stores.administrator.query('UPDATE session SET authenticated_at=$2 WHERE id=$1', [f.principal.sessionId, equalCreatedAt])
  await stores.administrator.query("UPDATE \"user\" SET hold_until=clock_timestamp()+interval '1 day' WHERE id=$1", [f.principal.userId])
  const originalBefore = await original(f.principal.sessionId)
  const ordered = (await stores.administrator.query('SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC,id DESC', [f.principal.userId])).rows.map(row => row.id as string)
  const target = ordered.slice(25).find(id => id !== f.principal.sessionId)!
  expect(target).toBeDefined()
  async function list(input: { cursor?: string; reconcileSessionId?: string } = {}) {
    const begin = await app.beginSessionList(request(f.cookie), input)
    return app.finishSessionList(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: ++counter }) })
  }
  const page1 = await list({ reconcileSessionId: target })
  expect(page1.sessions.map(row => row.id)).toEqual(ordered.slice(0, 25))
  expect(page1.nextCursor).toBe(ordered[24]); expect(page1.targetState).toBe('active')
  const page2 = await list({ cursor: page1.nextCursor!, reconcileSessionId: target })
  expect(page2.sessions.map(row => row.id)).toEqual(ordered.slice(25)); expect(page2.nextCursor).toBeNull()
  for (const row of [...page1.sessions, ...page2.sessions]) expect(Object.keys(row).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'lastActivityAt'])
  expect([...page1.sessions, ...page2.sessions].filter(row => row.current).map(row => row.id)).toEqual([f.principal.sessionId])
  expect(await original(f.principal.sessionId)).toBe(originalBefore)
  const state = (await stores.administrator.query('SELECT expires_at,authenticated_at,last_activity_at FROM session WHERE id=$1', [f.principal.sessionId])).rows[0]
  const currentRow = [...page1.sessions, ...page2.sessions].find(row => row.current)!
  expect(currentRow.expiresAt).toBe(new Date(Math.min(state.expires_at.getTime(), state.authenticated_at.getTime() + 604800000, state.last_activity_at.getTime() + 43200000)).toISOString())
  const revoke = await app.beginSessionRevocation(request(f.cookie), { sessionId: target })
  observed.fault = 'native-tail'
  try { await expect(app.finishSessionRevocation(request(f.cookie), { challengeId: revoke.challengeId, response: f.credential.authenticationResponse(revoke.options, { counter: counter + 1 }) })).rejects.toBeDefined() }
  finally { observed.fault = '' }
  const stillActive = await list({ reconcileSessionId: target })
  expect(stillActive.targetState).toBe('active'); expect(stillActive.sessions.some(row => row.id === target)).toBe(false)
  await stores.administrator.query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [target])
  expect((await list({ reconcileSessionId: target })).targetState).toBe('ineligible')
  expect((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE id=$1', [target])).rows[0].n).toBe(1)
  const removal = await app.beginSessionRevocation(request(f.cookie), { sessionId: target })
  await app.finishSessionRevocation(request(f.cookie), { challengeId: removal.challengeId, response: f.credential.authenticationResponse(removal.options, { counter: ++counter }) })
  expect((await list({ reconcileSessionId: target })).targetState).toBe('absent')
  expect((await list({ reconcileSessionId: foreign.target.sessionId })).targetState).toBe('absent')
  await addSession()
  const refreshed = await list()
  expect(ordered.includes(refreshed.sessions[0].id)).toBe(false)
  const staleCursor = refreshed.sessions.find(row => !row.current)!.id
  const pending = await app.beginSessionList(request(f.cookie), { cursor: staleCursor })
  await stores.administrator.query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [staleCursor])
  const before = await scope(f.principal.userId)
  const error = await app.finishSessionList(request(f.cookie), { challengeId: pending.challengeId, response: f.credential.authenticationResponse(pending.options, { counter: counter + 1 }) }).then(() => undefined, error => error)
  expect(app.sessionManagementErrorResponse(error)?.status).toBe(409); expect(await scope(f.principal.userId)).toBe(before)
  qualification.list = { realNativeSessions: 28, equalCreatedAt: true, cursorRow: 25, fixedSetComplete: true, newHeadOnRefresh: true,
    exactBeyondPage1Active: true, ineligibleExisting: true, absentAfterCommittedDeletion: true, foreignIndistinguishable: true, holdAllowed: true, noTouch: true }
}, 60000)

test('N3 cross-purpose, duplicate and altered verification attempts preserve the original valid completion', async () => {
  const f = await enroll(), begin = await app.beginSessionList(request(f.cookie), {})
  const input = { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }, before = await scope(f.principal.userId)
  await expect(app.finishSessionRevocation(request(f.cookie), input)).rejects.toBeDefined()
  expect(await scope(f.principal.userId)).toBe(before)
  const identifier = 'application-session-v1:' + Buffer.from(f.principal.userId).toString('hex') + ':' + begin.challengeId
  const duplicateId = randomUUID()
  await stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) SELECT $2,identifier,value,expires_at FROM verification WHERE identifier=$1', [identifier, duplicateId])
  const duplicateBefore = await scope(f.principal.userId)
  await expect(app.finishSessionList(request(f.cookie), input)).rejects.toBeDefined()
  expect(await scope(f.principal.userId)).toBe(duplicateBefore)
  await stores.administrator.query('DELETE FROM verification WHERE id=$1', [duplicateId])
  const prior = (await stores.administrator.query('SELECT value FROM verification WHERE identifier=$1', [identifier])).rows[0].value
  await stores.administrator.query("UPDATE verification SET value=jsonb_set(value::jsonb,'{workspaceId}',to_jsonb($2::text))::text WHERE identifier=$1", [identifier, randomUUID()])
  const alteredBefore = await scope(f.principal.userId)
  await expect(app.finishSessionList(request(f.cookie), input)).rejects.toBeDefined()
  expect(await scope(f.principal.userId)).toBe(alteredBefore)
  await stores.administrator.query('UPDATE verification SET value=$2 WHERE identifier=$1', [identifier, prior])
  expect((await app.finishSessionList(request(f.cookie), input)).sessions.length).toBe(2)
})

test('N3 cursor expiry during awaited native tail requires restart and rolls back proof/counter while original authority remains valid', async () => {
  const f = await enroll(), begin = await app.beginSessionList(request(f.cookie), { cursor: f.target.sessionId })
  expect(Date.parse(begin.expiresAt) - Date.now()).toBeGreaterThan(2000)
  await stores.administrator.query('UPDATE session SET expires_at=$2 WHERE id=$1', [f.target.sessionId, new Date(Date.now() + 900)])
  const before = await scope(f.principal.userId), originalBefore = await original(f.principal.sessionId), gate = holdNative()
  const work = app.finishSessionList(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
    .then(() => 200, error => app.sessionManagementErrorResponse(error)?.status ?? 500)
  try { await bounded(gate.entered, 8000); await new Promise(resolve => setTimeout(resolve, 1000)); gate.release() }
  finally { gate.release(); observed.hold = false }
  const status = await work, unchanged = await scope(f.principal.userId) === before
  expect(await original(f.principal.sessionId)).toBe(originalBefore)
  expect(Date.parse(begin.expiresAt)).toBeGreaterThan(Date.now())
  qualification.cursorTailExpiry = { status, unchanged, originalUnchanged: true, originalProofDeadlineStillLive: true }
  expect({ status, unchanged }).toEqual({ status: 409, unchanged: true })
})

async function abandoned(f: Awaited<ReturnType<typeof enroll>>, challengeId: string, expiresAt: Date, overrides: Record<string, unknown> = {}) {
  const identifier = 'application-session-v1:' + Buffer.from(f.principal.userId).toString('hex') + ':' + challengeId
  const value = JSON.stringify({ version: 1, userId: f.principal.userId, sessionId: f.principal.sessionId, workspaceId: f.workspace.id,
    recoveryGeneration: 0, action: 'LIST', cursor: null, reconcileSessionId: null, challenge: 'abandoned-test-challenge', expiresAt: expiresAt.toISOString(), ...overrides })
  await stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)', [randomUUID(), identifier, value, expiresAt])
  return identifier
}
test('N3 cleanup skips101duplicate/live-mixed/malformed groups and bounds actual singleton deletion to100 physical rows', async () => {
  const f = await enroll(), now = Date.now()
  const singleton = await abandoned(f, randomUUID(), new Date(now - 500000))
  const duplicate = await abandoned(f, randomUUID(), new Date(now - 300000))
  await stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) SELECT gen_random_uuid()::text,identifier,value,expires_at FROM verification CROSS JOIN generate_series(1,100) WHERE identifier=$1', [duplicate])
  const mixedId = randomUUID(), mixed = await abandoned(f, mixedId, new Date(now - 450000))
  await abandoned(f, mixedId, new Date(now + 100000))
  const wrongUser = await abandoned(f, randomUUID(), new Date(now - 450000), { userId: 'foreign-user' })
  const wrongPurpose = await abandoned(f, randomUUID(), new Date(now - 450000), { action: 'LINK' })
  const unsafe = [duplicate, mixed, wrongUser, wrongPurpose]
  const snapshot = async () => createHash('sha256').update(JSON.stringify((await stores.administrator.query('SELECT * FROM verification WHERE identifier=ANY($1) ORDER BY id', [unsafe])).rows)).digest('hex')
  const unsafeBefore = await snapshot()
  const beforeCount = (await stores.administrator.query('SELECT count(*)::int n FROM verification')).rows[0].n
  await app.beginSessionList(request(f.cookie), {})
  expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [singleton])).rows[0].n).toBe(0)
  expect(await snapshot()).toBe(unsafeBefore)
  const afterCount = (await stores.administrator.query('SELECT count(*)::int n FROM verification')).rows[0].n
  expect(beforeCount + 1 - afterCount).toBe(1)
  const singles: string[] = []
  for (let n = 0; n < 105; n++) singles.push(await abandoned(f, randomUUID(), new Date(now - 600000)))
  await app.beginSessionList(request(f.cookie), {})
  expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=ANY($1)', [singles])).rows[0].n).toBe(5)
  expect(await snapshot()).toBe(unsafeBefore)
  await stores.administrator.query(`INSERT INTO verification(id,identifier,value,expires_at)
    SELECT gen_random_uuid()::text,'application-session-v1:' || encode(convert_to('other-user-' || n,'UTF8'),'hex') || ':' || gen_random_uuid()::text,'{}',clock_timestamp()-interval '1 day' FROM generate_series(1,2000) n`)
  const prefix = 'application-session-v1:' + Buffer.from(f.principal.userId).toString('hex') + ':%'
  const explained = (await stores.administrator.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT identifier FROM verification WHERE identifier LIKE $1 AND expires_at<=$2 ORDER BY expires_at,id LIMIT 100 FOR UPDATE', [prefix, new Date()])).rows[0]['QUERY PLAN'][0]
  const nodes: { type: string; rows: number; loops: number; sharedHitBlocks: number }[] = []
  function collect(node: Record<string, any>) {
    nodes.push({ type: node['Node Type'], rows: node['Actual Rows'], loops: node['Actual Loops'], sharedHitBlocks: node['Shared Hit Blocks'] })
    for (const child of node.Plans ?? []) collect(child)
  }
  collect(explained.Plan)
  qualification.cleanup = { unsafeGroupsUnchanged: true, duplicateRows: 101, mixedLiveExpired: true, boundedSingletonDeletions: 100,
    mixedUserRows: 2000, executionMs: explained['Execution Time'], planningMs: explained['Planning Time'], nodes }
})

test.each(['cleanup-veto', 'cleanup-phantom', 'native-tail'])('N3 %s leaves cleanup candidates/proofs and original authority unchanged', async fault => {
  const f = await enroll()
  await abandoned(f, randomUUID(), new Date(Date.now() - 1000))
  const before = await scope(f.principal.userId)
  observed.fault = fault
  try { await expect(app.beginSessionList(request(f.cookie), {})).rejects.toBeDefined() } finally { observed.fault = '' }
  expect(await scope(f.principal.userId)).toBe(before)
})

test('N4 audit insertion can finish after proof expiry but final owner check rolls back fact, deletion and proof', async () => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  await shortenProof(f.principal.userId, begin.challengeId, 500)
  const before = await scope(f.principal.userId)
  observed.auditDelayCompleted = 0
  await stores.administrator.query(`CREATE FUNCTION public.fixture_delay_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.7); RAISE NOTICE 'fixture-audit-delay-complete'; RETURN NEW; END $$;
    CREATE TRIGGER fixture_delay_revocation BEFORE INSERT ON auth_session_revocation FOR EACH ROW EXECUTE FUNCTION public.fixture_delay_revocation()`)
  let error: unknown
  try { error = await app.finishSessionRevocation(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }).then(() => undefined, error => error) }
  finally { await stores.administrator.query('DROP TRIGGER fixture_delay_revocation ON auth_session_revocation; DROP FUNCTION public.fixture_delay_revocation()') }
  expect(app.sessionManagementErrorResponse(error)?.status).toBe(400)
  expect(observed.auditDelayCompleted).toBe(1)
  expect(await scope(f.principal.userId)).toBe(before)
  qualification.auditTailExpiry = { delayCompleted: 1, status: 400, unchanged: true }
})

test('N4 native capability rejects a copied Request and retained reuse after its physical lease closes', async () => {
  const f = await enroll(), begin = await app.beginSessionList(request(f.cookie), {})
  observed.captureCapability = true; observed.copiedRequestRefused = false
  try { await app.finishSessionList(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }) }
  finally { observed.captureCapability = false }
  expect(observed.copiedRequestRefused).toBe(true)
  const before = await scope(f.principal.userId)
  expect(observed.retained).toBeDefined()
  expect(() => observed.retained!.assert('execute', observed.retainedRequest)).toThrow()
  expect(await scope(f.principal.userId)).toBe(before)
  observed.retained = undefined; observed.retainedRequest = undefined
})

test.each(['foreign-token', 'refresh-alias'])('N4 %s alias cannot mutate another User from the native tail', async fault => {
  const f = await enroll(), foreign = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  const before = await scope(f.principal.userId), foreignBefore = await scope(foreign.principal.userId)
  observed.foreignToken = (await stores.administrator.query('SELECT token FROM session WHERE id=$1', [foreign.target.sessionId])).rows[0].token
  observed.fault = fault
  try { await expect(app.finishSessionRevocation(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })).rejects.toBeDefined() }
  finally { observed.fault = ''; observed.foreignToken = '' }
  expect(await scope(f.principal.userId)).toBe(before); expect(await scope(foreign.principal.userId)).toBe(foreignBefore)
})

test('N4 a target already signed out cannot produce a revocation success fact or consume its proof', async () => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  await app.logout(request(f.targetCookie))
  const before = await scope(f.principal.userId)
  await expect(app.finishSessionRevocation(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })).rejects.toBeDefined()
  expect(await scope(f.principal.userId)).toBe(before)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM auth_session_revocation WHERE actor_user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
})

test('N4 revocation audit survives fixture User and Workspace removal without widening runtime read grants', async () => {
  const f = await enroll(), begin = await app.beginSessionRevocation(request(f.cookie), { sessionId: f.target.sessionId })
  await app.finishSessionRevocation(request(f.cookie), { challengeId: begin.challengeId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
  const audit = async () => createHash('sha256').update(JSON.stringify((await stores.administrator.query('SELECT * FROM auth_session_revocation WHERE actor_user_id=$1 ORDER BY id', [f.principal.userId])).rows)).digest('hex')
  const before = await audit()
  await stores.administrator.query('DELETE FROM workspace WHERE owner_user_id=$1', [f.principal.userId])
  await stores.administrator.query('DELETE FROM "user" WHERE id=$1', [f.principal.userId])
  expect(await audit()).toBe(before)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM auth_session_revocation WHERE actor_user_id=$1', [f.principal.userId])).rows[0].n).toBe(1)
  qualification.auditSurvival = { userAndWorkspaceRemovedByFixture: true, factRetained: true, runtimeReadGrantAdded: false }
})

test('N4 current migration applies and reruns on a genuinely empty second owned store', async () => {
  const fresh = await startDisposableStores()
  try {
    expect((await fresh.administrator.query("SELECT to_regclass('public.session') IS NULL AS absent")).rows[0].absent).toBe(true)
    await fresh.migrate(); await fresh.migrate()
    expect((await fresh.administrator.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n).toBe(12)
    expect((await fresh.administrator.query('SELECT count(*)::int n FROM auth_session_revocation')).rows[0].n).toBe(0)
    qualification.freshEmptyMigration = { migrations: 12, facts: 0, rerun: true }
  } finally {
    try { await fresh.cleanup() } finally { qualification.freshEmptyStore = fresh.evidence }
  }
}, 180000)
