import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { Schema } from 'effect'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { googleAccountCallbackResponse, magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { bounded } from '../helpers/web-process'

const observed = vi.hoisted(() => ({ token: '', fault: '', reads: 0, flags: 0, mutationCalls: 0, entered: () => {}, gate: Promise.resolve(), hold: false,
  oauthTailPath: '', oauthTailReached: false, oauthTail: async () => {}, aliasUserId: '', aliasSubject: '', aliasReached: false,
  nativePid: 0, forbidProvider: false, wrongUserId: '', captureSession: false, useStaleSession: false, staleSession: undefined as unknown }))
vi.mock('../../src/modules/auth/google-transport.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/google-transport.server')>()
  return { ...actual, createGoogleTransport() {
    if (observed.forbidProvider) throw new Error('Provider construction forbidden in local unlink fixture')
    return actual.createGoogleTransport()
  } }
})
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('better-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth')>()
  return { ...actual, betterAuth(options: Parameters<typeof actual.betterAuth>[0]) {
    return actual.betterAuth({ ...options, databaseHooks: { ...options.databaseHooks, account: {
      create: { before: async data => {
        if (observed.fault === 'create-veto') return false
        if (observed.fault === 'token-field') return { data: { ...data, accessToken: 'task9d-synthetic-secret-canary' } }
        if (observed.fault === 'wrong-binding') return { data: { ...data, userId: observed.wrongUserId } }
        return { data }
      }, after: async () => { if (observed.fault === 'create-after') { await Promise.resolve(); throw new Error('Owned Account after-hook refusal') } } },
      delete: { before: async () => observed.fault === 'delete-veto' ? false : undefined,
        after: async () => { if (observed.fault === 'delete-after') { await Promise.resolve(); throw new Error('Owned Account after-hook refusal') } } },
    } } })
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
      if (args[7]?.(ctx.request) && ctx.path === '/get-session') {
        observed.reads++
        if (ctx.query?.disableCookieCache === true && ctx.query?.disableRefresh === true) observed.flags++
        if (observed.useStaleSession) Object.assign(ctx.context, { session: observed.staleSession })
      }
      if (args[7]?.(ctx.request) && ctx.path === '/application/account/google/mutate') observed.mutationCalls++
      return before({ ...ctx, returnHeaders: false })
    }) }], after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/get-session' || ctx.path === '/application/account/google/mutate' || ctx.path === '/application/account/google/authorize' || ctx.path === '/application/account/google/complete', handler: createAuthMiddleware(async ctx => {
      if (ctx.path === '/get-session') { if (observed.captureSession) observed.staleSession = ctx.context.returned; return }
      if (ctx.path === observed.oauthTailPath) { observed.oauthTailReached = true; await observed.oauthTail() }
      if (ctx.path !== '/application/account/google/mutate') return
      if (observed.fault === 'alias-link') {
        observed.aliasReached = true
        await ctx.context.internalAdapter.linkAccount({ userId: observed.aliasUserId, providerId: 'google', accountId: observed.aliasSubject })
      }
      if (observed.fault === 'wrong-native-result') ctx.context.returned = { id: 'not-the-persisted-account' }
      if (observed.hold) {
        observed.hold = false
        const [connection] = await args[0].currentDb().select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(select 1) as fixture_backend`)
        observed.nativePid = connection.pid; observed.entered(); await observed.gate
      }
      if (observed.fault === 'native-tail') throw new Error('Owned complete native tail refusal')
    }) }] } }
  } }
})

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
let stores: Awaited<ReturnType<typeof startDisposableStores>>, peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>, pool: Pool
let owner: ReturnType<typeof createTransactions>, app: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
let config: Parameters<typeof createApplicationAuth>[1], ip = 1
const migrationObservations: Record<string, unknown> = {}, overlapObservations: Record<string, unknown>[] = []
const purposePreservationObservations: Record<string, unknown>[] = []
const cookies = (headers: Headers) => headers.getSetCookie().filter(value => !/;\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
function request(cookie = '', path = '/google-account', method = 'POST', signal?: AbortSignal) {
  const value = Object.assign(new Request(origin + path, { method, signal, headers: { cookie, ...(method === 'POST' ? { origin } : {}),
    'x-real-ip': `198.18.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return value
}
function holdMutation() {
  let release = () => {}, enter = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve })
  observed.gate = new Promise<void>(resolve => { release = resolve }); observed.entered = enter; observed.hold = true
  return { entered, release }
}
async function blockedBackend() {
  let pid = 0
  await expect.poll(async () => {
    const result = await stores.administrator.query("SELECT pid FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock' AND pid<>$1", [observed.nativePid])
    pid = result.rows[0]?.pid ?? 0; return pid !== 0
  }, { timeout: 800, interval: 25 }).toBe(true)
  return pid
}
async function snapshot(userId: string) {
  const rows = await stores.administrator.query(`SELECT * FROM (
    SELECT 'user' kind,to_jsonb(u) value FROM "user" u WHERE id=$1 UNION ALL
    SELECT 'session',to_jsonb(s) FROM session s WHERE user_id=$1
  ) entries ORDER BY kind,value::text`, [userId])
  return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex')
}
async function enroll(email = `google-account-${randomUUID()}@example.test`) {
  await app.requestMagicLink(request(), { email, locale: 'en' })
  const proof = { token: observed.token, intendedEmail: email }
  const options = await magicConsumeResponse(request(), proof, app, limiter)
  expect(options.status).toBe(200)
  const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
  const enrolled = await magicEnrollmentResponse(request(cookies(options.headers)), { ...proof, response: credential.response }, app, limiter)
  expect(enrolled.status).toBe(200)
  const cookie = cookies(enrolled.headers), principal = await app.requirePrincipal(request(cookie))
  const workspace = await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal)
  return { cookie, credential, principal, workspace, email }
}
async function authorize(f: Awaited<ReturnType<typeof enroll>>, counter = 1) {
  const begin = await app.beginGoogleAccountLink(request(f.cookie), 'en')
  const result = await app.authorizeGoogleAccountLink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter }) })
  return { begin, ...result }
}
async function complete(f: Awaited<ReturnType<typeof enroll>>, authorized: Awaited<ReturnType<typeof authorize>>, subject = randomUUID(), email = `provider-${randomUUID()}@example.test`, consumer = app) {
  const url = new URL(authorized.url), code = peer.register(authorized.url, subject, { email })
  const response = await googleAccountCallbackResponse(request(f.cookie + '; ' + cookies(authorized.headers),
    '/api/auth/account/google/callback?state=' + url.searchParams.get('state') + '&code=' + code, 'GET'), consumer, limiter)
  return { response, subject, email }
}
beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrateGoogleAccountPrefix()
  const preservedId = randomUUID(), preservedSubject = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [preservedId, 'Migration fixture', `migration-${preservedId}@example.test`])
  await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [randomUUID(), preservedId, 'google', preservedSubject])
  const prefix = (await stores.administrator.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n
  const prefixRows = (await stores.administrator.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows
  const before = await snapshot(preservedId)
  const accountBefore = createHash('sha256').update(JSON.stringify((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [preservedId])).rows)).digest('hex')
  await stores.migrate(); await stores.migrate()
  const final = (await stores.administrator.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n
  const preserved = (await snapshot(preservedId)) === before
  const bound = (await stores.administrator.query('SELECT account_id FROM account WHERE user_id=$1', [preservedId])).rows[0].account_id === preservedSubject
  const accountPreserved = createHash('sha256').update(JSON.stringify((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [preservedId])).rows)).digest('hex') === accountBefore
  const journalPreserved = JSON.stringify((await stores.administrator.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 10')).rows) === JSON.stringify(prefixRows)
  Object.assign(migrationObservations, { prefix, final, preserved, bound, accountPreserved, journalPreserved, rerun: true })
  expect({ prefix, final, preserved, bound, accountPreserved, journalPreserved }).toEqual({ prefix: 10, final: 11, preserved: true, bound: true, accountPreserved: true, journalPreserved: true })
  const privilegeProbe = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  try {
    const code = await privilegeProbe.query('SELECT id FROM google_account_intent LIMIT 1').then(() => 'accepted', (error: { code?: string }) => error.code)
    expect(code).toBe('42501'); migrationObservations.beforeGrantDenied = true
  } finally { await privilegeProbe.end() }
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.google_account_intent,public.first_google_passkey_intent TO runtime;
    GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
    GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
    GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime; GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
  peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
  pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'google-account-native', TRUSTED_PROXY_IPS: '127.0.0.1' })); await limiter.connect()
  config = { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!,
    magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }
  app = createApplicationAuth(owner, config, limiter)
})
afterAll(async () => {
  observed.fault = ''; observed.hold = false; observed.oauthTailPath = ''; observed.oauthTail = async () => {}
  const failures: string[] = []
  for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()], ['peer', () => peer?.close()], ['stores', () => stores?.cleanup()]] as const) {
    try { await close() } catch { failures.push(name) }
  }
  if (stores) {
    const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9d-evidence')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`), JSON.stringify({ stores: stores.evidence, peer: peer?.evidence(), failures,
      sessionReads: observed.reads, sessionFlags: observed.flags, mutationCalls: observed.mutationCalls, migrationObservations, overlapObservations, purposePreservationObservations }, null, 2) + '\n', { flag: 'wx' })
  }
  expect(failures).toEqual([])
})

test('outer OAuth Authorize tail cannot publish an expired original authority', async () => {
  const f = await enroll(), begin = await app.beginGoogleAccountLink(request(f.cookie), 'en')
  await stores.administrator.query(`UPDATE google_account_intent SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, [begin.intentId])
  observed.oauthTailPath = '/application/account/google/authorize'; observed.oauthTailReached = false
  observed.oauthTail = async () => { await new Promise(resolve => setTimeout(resolve, 1200)) }
  let published = false
  try {
    await app.authorizeGoogleAccountLink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options) })
      .then(() => { published = true }, () => {})
  } finally { observed.oauthTailPath = ''; observed.oauthTail = async () => {} }
  expect(observed.oauthTailReached).toBe(true)
  expect(published).toBe(false)
  expect((await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [begin.intentId])).rows[0].phase).toBe('AUTHORIZED')
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(1)
})

test('participating native tail cannot link an unrelated User through an Account alias', async () => {
  const f = await enroll(), other = await enroll(), a = await authorize(f)
  const ownBefore = await snapshot(f.principal.userId), otherBefore = await snapshot(other.principal.userId)
  observed.aliasUserId = other.principal.userId; observed.aliasSubject = randomUUID(); observed.aliasReached = false; observed.fault = 'alias-link'
  try { await complete(f, a) } finally { observed.fault = ''; observed.aliasUserId = ''; observed.aliasSubject = '' }
  expect(observed.aliasReached).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [other.principal.userId])).rows[0].n).toBe(0)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('invalidated')
  expect(await snapshot(f.principal.userId)).toBe(ownBefore)
  expect(await snapshot(other.principal.userId)).toBe(otherBefore)
})

test('outer OAuth callback tail rechecks original session without erasing its already committed receipt', async () => {
  const f = await enroll(), a = await authorize(f)
  observed.oauthTailPath = '/application/account/google/complete'; observed.oauthTailReached = false
  observed.oauthTail = async () => { await stores.administrator.query(`UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.principal.sessionId]) }
  let result: Awaited<ReturnType<typeof complete>>
  try { result = await complete(f, a) } finally { observed.oauthTailPath = ''; observed.oauthTail = async () => {} }
  expect(observed.oauthTailReached).toBe(true)
  expect(result.response.status).toBe(401)
  expect(result.response.headers.getSetCookie()).toEqual([])
  expect((await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [a.intentId])).rows[0].phase).toBe('CONSUMED')
  expect((await stores.administrator.query('SELECT id FROM session WHERE id=$1', [f.principal.sessionId])).rowCount).toBe(1)
})

test('existing UV links a different-email subject with explicit chooser, preserves session, then ordinary Google and surviving passkey logins reach the same User', async () => {
  const f = await enroll()
  await stores.administrator.query(`UPDATE session SET created_at=clock_timestamp()-interval '2 days',authenticated_at=clock_timestamp()-interval '2 days',last_activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, [f.principal.sessionId])
  const before = await snapshot(f.principal.userId), a = await authorize(f), url = new URL(a.url)
  expect(url.searchParams.get('prompt')).toBe('select_account')
  expect(url.searchParams.has('login_hint')).toBe(false)
  expect(url.searchParams.get('redirect_uri')).toBe(origin + '/api/auth/account/google/callback')
  expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'openid', 'profile'])
  expect(['state', 'nonce', 'code_challenge'].every(key => !!url.searchParams.get(key))).toBe(true)
  const linked = await complete(f, a)
  expect(linked.response.status).toBe(303)
  expect(linked.response.headers.getSetCookie().some(value => value.includes('session_token'))).toBe(false)
  expect(await snapshot(f.principal.userId)).toBe(before)
  const receipt = await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })
  expect(receipt.state).toBe('linked')
  const row = (await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [f.principal.userId])).rows[0]
  expect({ user: row.user_id, subject: row.account_id, tokens: [row.access_token, row.refresh_token, row.id_token, row.scope, row.password] }).toEqual({ user: f.principal.userId, subject: linked.subject, tokens: [null, null, null, null, null] })
  await app.logout(request(f.cookie))
  const start = await app.beginGoogleSignIn(request()), code = peer.register(start.url, linked.subject, { email: linked.email, name: 'Must not replace profile' })
  const login = await app.callback(request(cookies(start.headers), '/api/auth/callback/google?state=' + new URL(start.url).searchParams.get('state') + '&code=' + code, 'GET'))
  expect(login.status).toBe(302)
  const currentCookie = cookies(login.headers), current = await app.requirePrincipal(request(currentCookie))
  expect({ id: current.userId, email: current.email, name: current.name }).toEqual({ id: f.principal.userId, email: f.principal.email, name: f.principal.name })
  expect(await createPersonalWorkspaces(owner).ensurePersonalWorkspace(current)).toEqual(f.workspace)
  const local = createApplicationAuth(owner, { ...config, google: null }, limiter), posts = peer.evidence().posts
  try {
    const unchanged = await snapshot(f.principal.userId)
    const begin = await local.beginGoogleAccountUnlink(request(currentCookie), { accountId: row.id })
    const result = await local.finishGoogleAccountUnlink(request(currentCookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
    expect(result.state).toBe('unlinked'); expect(peer.evidence().posts).toBe(posts)
    expect(await snapshot(f.principal.userId)).toBe(unchanged)
    expect((await stores.administrator.query('SELECT id FROM account WHERE id=$1', [row.id])).rowCount).toBe(0)
    await app.logout(request(currentCookie))
    const options = await app.beginPasskeySignIn(request())
    const passkeyLogin = await app.finishPasskeySignIn(request(cookies(options.headers)), { response: f.credential.authenticationResponse(options.options, { counter: 3 }) })
    expect((await app.requirePrincipal(request(cookies(passkeyLogin.headers)))).userId).toBe(f.principal.userId)
  } finally { await local.close() }
  expect(observed.reads).toBe(observed.flags)
})

test('provider email matching a second User never selects or modifies that User; exact occupied subject refuses', async () => {
  const f = await enroll(), other = await enroll(), otherBefore = await snapshot(other.principal.userId)
  const a = await authorize(f), linked = await complete(f, a, randomUUID(), other.email)
  expect(linked.response.status).toBe(303)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
  expect(await snapshot(other.principal.userId)).toBe(otherBefore)
  const b = await authorize(other), rejected = await complete(other, b, linked.subject, other.email)
  expect(rejected.response.status).toBe(303)
  expect((await app.readGoogleAccountIntent(request(other.cookie), { intentId: b.intentId })).state).toBe('invalidated')
  expect((await stores.administrator.query('SELECT user_id FROM account WHERE account_id=$1', [linked.subject])).rows).toEqual([{ user_id: f.principal.userId }])
})

test.each(['create-veto', 'token-field', 'create-after', 'native-tail'])('LINK final rollback on %s retains the earlier counter/claim but no Account/consumption', async fault => {
  const f = await enroll(), before = await snapshot(f.principal.userId), a = await authorize(f)
  observed.fault = fault
  try { await complete(f, a) } finally { observed.fault = '' }
  expect(await snapshot(f.principal.userId)).toBe(before)
  expect((await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rowCount).toBe(0)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(1)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('invalidated')
})

test.each(['delete-veto', 'delete-after', 'native-tail'])('UNLINK %s rolls back deletion, counter and receipt together', async fault => {
  const f = await enroll(), a = await authorize(f); await complete(f, a)
  const row = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows[0]
  const begin = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: row.id }), before = await snapshot(f.principal.userId)
  observed.fault = fault
  try { await expect(app.finishGoogleAccountUnlink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })).rejects.toBeDefined() }
  finally { observed.fault = '' }
  expect(await snapshot(f.principal.userId)).toBe(before)
  expect((await stores.administrator.query('SELECT id FROM account WHERE id=$1', [row.id])).rowCount).toBe(1)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(1)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: begin.intentId })).state).toBe('pending')
})

test('historical receipts survive subsequent unlink, proof expiry, key removal and Begin cleanup; cancel returns committed success', async () => {
  const f = await enroll(), a = await authorize(f); await complete(f, a)
  const row = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows[0]
  const begin = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: row.id })
  await app.finishGoogleAccountUnlink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
  await stores.administrator.query(`UPDATE google_account_intent SET created_at=created_at-interval '10 minutes',expires_at=expires_at-interval '10 minutes' WHERE id=ANY($1::uuid[])`, [[a.intentId, begin.intentId]])
  await app.beginGoogleAccountLink(request(f.cookie))
  await stores.administrator.query('DELETE FROM passkey WHERE user_id=$1', [f.principal.userId])
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
  expect((await app.cancelGoogleAccountIntent(request(f.cookie), { intentId: begin.intentId })).state).toBe('unlinked')
  const cleared = await stores.administrator.query(`SELECT authentication_challenge,authorizing_key_id,authorizing_credential_id,authorizing_public_key,oauth_state FROM google_account_intent WHERE id=ANY($1::uuid[])`, [[a.intentId, begin.intentId]])
  expect(cleared.rows.every(row => Object.values(row).every(value => value === null))).toBe(true)
})

test.each(['native-expired', 'idle-expired', 'absolute-expired', 'recovery', 'generation', 'hold', 'key-replaced'])('callback refuses %s before exchange and publishes no session headers', async scenario => {
  const f = await enroll(), a = await authorize(f)
  if (scenario === 'native-expired') await stores.administrator.query(`UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.principal.sessionId])
  if (scenario === 'idle-expired') await stores.administrator.query(`UPDATE session SET last_activity_at=clock_timestamp()-interval '12 hours' WHERE id=$1`, [f.principal.sessionId])
  if (scenario === 'absolute-expired') await stores.administrator.query(`UPDATE session SET authenticated_at=clock_timestamp()-interval '7 days' WHERE id=$1`, [f.principal.sessionId])
  if (scenario === 'recovery') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [f.principal.userId])
  if (scenario === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [f.principal.userId])
  if (scenario === 'hold') await stores.administrator.query(`UPDATE "user" SET hold_until=clock_timestamp()+interval '1 hour' WHERE id=$1`, [f.principal.userId])
  if (scenario === 'key-replaced') await stores.administrator.query(`UPDATE passkey SET public_key='replaced' WHERE user_id=$1`, [f.principal.userId])
  const before = await snapshot(f.principal.userId), posts = peer.evidence().posts, result = await complete(f, a)
  expect([400, 401]).toContain(result.response.status)
  expect(result.response.headers.getSetCookie()).toEqual([])
  expect(await snapshot(f.principal.userId)).toBe(before)
  expect(peer.evidence().posts).toBe(posts)
  expect((await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [a.intentId])).rows[0].phase).toBe('AUTHORIZED')
})

test('another valid session of the same User cannot claim the original Google intent; native assertion counter changes alone remain valid', async () => {
  const f = await enroll(), a = await authorize(f)
  const begin = await app.beginPasskeySignIn(request())
  const login = await app.finishPasskeySignIn(request(cookies(begin.headers)), { response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
  const another = cookies(login.headers), posts = peer.evidence().posts
  const refused = await complete({ ...f, cookie: another }, a)
  expect(refused.response.status).toBe(400); expect(peer.evidence().posts).toBe(posts)
  const valid = await complete(f, a)
  expect(valid.response.status).toBe(303)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
})

test('duplicate callback never exchanges twice after durable claim', async () => {
  const f = await enroll(), a = await authorize(f), url = new URL(a.url), code = peer.register(a.url, randomUUID())
  const path = '/api/auth/account/google/callback?state=' + url.searchParams.get('state') + '&code=' + code
  const cookie = f.cookie + '; ' + cookies(a.headers), posts = peer.evidence().posts
  const outcomes = await Promise.all([googleAccountCallbackResponse(request(cookie, path, 'GET'), app, limiter), googleAccountCallbackResponse(request(cookie, path, 'GET'), app, limiter)])
  expect(outcomes.map(value => value.status).filter(value => value === 303)).toHaveLength(1)
  expect(peer.evidence().posts - posts).toBe(1)
  expect((await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rowCount).toBe(1)
})

test('expiry during awaited complete native mutation tail rolls back Account while keeping earlier authorization counter', async () => {
  const f = await enroll(), a = await authorize(f)
  await stores.administrator.query(`UPDATE google_account_intent SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [a.intentId])
  let release = () => {}, enter = () => {}
  const entered = new Promise<void>(resolve => { enter = resolve })
  observed.gate = new Promise<void>(resolve => { release = resolve }); observed.entered = enter; observed.hold = true
  const work = complete(f, a)
  try { await bounded(entered, 8000); await new Promise(resolve => setTimeout(resolve, 2100)); release(); await work }
  finally { release(); observed.hold = false }
  expect((await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rowCount).toBe(0)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(1)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('invalidated')
})

test.each(['wrong-binding', 'wrong-native-result'])('native final %s cannot yield a confirmed Account receipt', async fault => {
  const f = await enroll(), other = await enroll(), a = await authorize(f)
  observed.wrongUserId = other.principal.userId; observed.fault = fault
  try { await complete(f, a) } finally { observed.fault = ''; observed.wrongUserId = '' }
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=ANY($1::text[])', [[f.principal.userId, other.principal.userId]])).rows[0].n).toBe(0)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('invalidated')
})

test.each(['account-write', 'consume-link', 'consume-unlink'])('SQL failure at %s rolls back final mutation and consumption', async fault => {
  const f = await enroll(), a = await authorize(f)
  let unlink: Awaited<ReturnType<typeof app.beginGoogleAccountUnlink>> | undefined
  if (fault === 'consume-unlink') {
    await complete(f, a)
    const [row] = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows
    unlink = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: row.id })
  }
  const table = fault === 'account-write' ? 'account' : 'google_account_intent'
  await stores.administrator.query(`CREATE FUNCTION public.fixture_google_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned write refusal'; END $$`)
  await stores.administrator.query(`CREATE TRIGGER fixture_google_write_failure BEFORE ${fault === 'account-write' ? 'INSERT' : "UPDATE OF phase"} ON public.${table} FOR EACH ROW ${fault === 'account-write' ? '' : "WHEN (NEW.phase = 'CONSUMED')"} EXECUTE FUNCTION public.fixture_google_write_failure()`)
  try {
    if (unlink) await expect(app.finishGoogleAccountUnlink(request(f.cookie), { intentId: unlink.intentId, response: f.credential.authenticationResponse(unlink.options, { counter: 2 }) })).rejects.toBeDefined()
    else await complete(f, a)
  } finally {
    await stores.administrator.query(`DROP TRIGGER fixture_google_write_failure ON public.${table}`)
    await stores.administrator.query('DROP FUNCTION public.fixture_google_write_failure()')
  }
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(unlink ? 1 : 0)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(1)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: unlink?.intentId ?? a.intentId })).state).toBe(unlink ? 'pending' : 'invalidated')
})

test('committed callback with lost response reconciles without exchange or mutation resend and survives later relink', async () => {
  const f = await enroll(), a = await authorize(f)
  observed.oauthTailPath = '/application/account/google/complete'
  observed.oauthTail = async () => { throw new Error('Owned lost callback response after commit') }
  let linked: Awaited<ReturnType<typeof complete>>
  try { linked = await complete(f, a) } finally { observed.oauthTailPath = ''; observed.oauthTail = async () => {} }
  expect(linked.response.status).toBe(500)
  const posts = peer.evidence().posts, mutations = observed.mutationCalls
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
  expect((await app.cancelGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
  expect({ posts: peer.evidence().posts, mutations: observed.mutationCalls }).toEqual({ posts, mutations })
  const current = await app.readAccount(request(f.cookie))
  expect(current.googleAccount.state).toBe('linked')
  if (current.googleAccount.state !== 'linked') throw new Error('Linked DTO unavailable')
  const unlink = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: current.googleAccount.accountId })
  await app.finishGoogleAccountUnlink(request(f.cookie), { intentId: unlink.intentId, response: f.credential.authenticationResponse(unlink.options, { counter: 2 }) })
  expect((await app.readAccount(request(f.cookie))).googleAccount).toEqual({ state: 'unlinked', canLink: true })
  const b = await authorize(f, 3); await complete(f, b)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: unlink.intentId })).state).toBe('unlinked')
  const after = await app.readAccount(request(f.cookie))
  expect(after.googleAccount.state === 'linked' && after.googleAccount.accountId !== current.googleAccount.accountId).toBe(true)
})

test('same-email second User does not redirect ordinary Google login; removed binding never authenticates original User', async () => {
  const f = await enroll(), other = await enroll(), a = await authorize(f), subject = randomUUID()
  await complete(f, a, subject, other.email)
  const beforeOther = await snapshot(other.principal.userId)
  const start = await app.beginGoogleSignIn(request()), code = peer.register(start.url, subject, { email: other.email })
  const login = await app.callback(request(cookies(start.headers), '/api/auth/callback/google?state=' + new URL(start.url).searchParams.get('state') + '&code=' + code, 'GET'))
  expect((await app.requirePrincipal(request(cookies(login.headers)))).userId).toBe(f.principal.userId)
  expect(await snapshot(other.principal.userId)).toBe(beforeOther)
  const [row] = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows
  const begin = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: row.id })
  await app.finishGoogleAccountUnlink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
  const again = await app.beginGoogleSignIn(request()), nextCode = peer.register(again.url, subject, { email: other.email })
  const result = await app.callback(request(cookies(again.headers), '/api/auth/callback/google?state=' + new URL(again.url).searchParams.get('state') + '&code=' + nextCode, 'GET'))
  const principal = await app.readPrincipal(request(cookies(result.headers)))
  expect(principal?.userId === f.principal.userId).toBe(false)
  expect(await snapshot(other.principal.userId)).toBe(beforeOther)
})

test('config-null local unlink constructs no provider client and targets the opaque row id, not its subject', async () => {
  const f = await enroll(), a = await authorize(f), linked = await complete(f, a)
  const [row] = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows
  observed.forbidProvider = true
  let local: ReturnType<typeof createApplicationAuth> | undefined
  try {
    local = createApplicationAuth(owner, { ...config, google: null }, limiter)
    await expect(local.beginGoogleAccountUnlink(request(f.cookie), { accountId: linked.subject })).rejects.toBeDefined()
    const begin = await local.beginGoogleAccountUnlink(request(f.cookie), { accountId: row.id })
    const result = await local.finishGoogleAccountUnlink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) })
    expect(result.state).toBe('unlinked')
  } finally { await local?.close(); observed.forbidProvider = false }
})

test('swapped native state purposes and mismatched codes do not grant linking or repeat a claimed exchange', async () => {
  const f = await enroll(), a = await authorize(f), b = await authorize(f, 2)
  const ua = new URL(a.url), ub = new URL(b.url), codeB = peer.register(b.url, randomUUID())
  const swapped = await googleAccountCallbackResponse(request(f.cookie + '; ' + cookies(a.headers), '/api/auth/account/google/callback?state=' + ua.searchParams.get('state') + '&code=' + codeB, 'GET'), app, limiter)
  expect(swapped.status).toBe(303)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('invalidated')
  const posts = peer.evidence().posts
  await complete(f, a)
  expect(peer.evidence().posts).toBe(posts)
  const wrongPurpose = await app.callback(request(f.cookie + '; ' + cookies(b.headers), '/api/auth/callback/google?state=' + ub.searchParams.get('state') + '&code=' + codeB, 'GET'))
  expect(wrongPurpose.status === 302 && !wrongPurpose.headers.getSetCookie().some(cookie => cookie.includes('session_token')) || wrongPurpose.status >= 400).toBe(true)
  expect(peer.evidence().posts).toBe(posts)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
  // Use a newly issued code: the earlier mismatched-code attempt deliberately
  // consumed codeB at the peer and cannot prove preservation of valid authority.
  const fresh = await authorize(f, 3), freshState = new URL(fresh.url).searchParams.get('state'), subject = randomUUID()
  const freshCode = peer.register(fresh.url, subject)
  const originalCookies = f.cookie + '; ' + cookies(fresh.headers)
  const verificationBefore = (await stores.administrator.query('SELECT id,value FROM verification WHERE identifier=$1', [freshState])).rows
  expect(verificationBefore.length).toBe(1)
  const fingerprint = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  const verificationHash = fingerprint(verificationBefore), originalSnapshot = await snapshot(f.principal.userId), exchangesBefore = peer.evidence().posts
  const refused = await app.callback(request(originalCookies, '/api/auth/callback/google?state=' + freshState + '&code=' + freshCode, 'GET'))
  const verificationAfter = (await stores.administrator.query('SELECT id,value FROM verification WHERE identifier=$1', [freshState])).rows
  const observation = {
    verificationUnchanged: verificationAfter.length === 1 && fingerprint(verificationAfter) === verificationHash,
    stateCookiePublished: refused.headers.getSetCookie().some(cookie => /^(?:__Secure-)?better-auth\.(?:state|oauth_state)=/.test(cookie)),
    sessionCookiePublished: refused.headers.getSetCookie().some(cookie => cookie.includes('session_token=')),
    providerExchangeDelta: peer.evidence().posts - exchangesBefore,
    intentStillAuthorized: (await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [fresh.intentId])).rows[0].phase === 'AUTHORIZED',
    originalSessionAndUserUnchanged: await snapshot(f.principal.userId) === originalSnapshot,
  }
  purposePreservationObservations.push(observation)
  expect(observation).toEqual({ verificationUnchanged: true, stateCookiePublished: false, sessionCookiePublished: false,
    providerExchangeDelta: 0, intentStillAuthorized: true, originalSessionAndUserUnchanged: true })
  const intended = await googleAccountCallbackResponse(request(originalCookies, '/api/auth/account/google/callback?state=' + freshState + '&code=' + freshCode, 'GET'), app, limiter)
  expect(intended.status).toBe(303)
  expect(peer.evidence().posts - exchangesBefore).toBe(1)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: fresh.intentId })).state).toBe('linked')
  expect((await stores.administrator.query("SELECT count(*)::int n FROM account WHERE user_id=$1 AND provider_id='google' AND account_id=$2", [f.principal.userId, subject])).rows[0].n).toBe(1)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [freshState])).rows[0].n).toBe(0)
  expect(await snapshot(f.principal.userId)).toBe(originalSnapshot)
  purposePreservationObservations.push({ correctCallbackSameStateAndCode: true, linkedReceipt: true, exactBindingCount: 1, providerExchangeDelta: 1, verificationConsumedByIntendedCallback: true })
})

test.each(['revoked', 'workspace'])('original %s change prevents callback mutation', async scenario => {
  const f = await enroll(), a = await authorize(f), posts = peer.evidence().posts
  if (scenario === 'revoked') await stores.administrator.query('DELETE FROM session WHERE id=$1', [f.principal.sessionId])
  else await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE owner_user_id=$1", [f.principal.userId])
  const result = await complete(f, a)
  expect([400, 401]).toContain(result.response.status)
  expect(result.response.headers.getSetCookie()).toEqual([])
  expect(peer.evidence().posts).toBe(posts)
})

test.each(['same-user', 'same-subject'])('independently overlapping backends serialize %s linking without moving a binding', async scenario => {
  const f = await enroll(), g = scenario === 'same-user' ? f : await enroll(), a = await authorize(f), b = await authorize(g, scenario === 'same-user' ? 2 : 1)
  const direct = new Pool({ connectionString: stores.directRuntimeUrl, max: 2 }), secondOwner = createTransactions(direct, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const second = createApplicationAuth(secondOwner, config, limiter), gate = holdMutation(), firstSubject = randomUUID()
  let firstWork: ReturnType<typeof complete> | undefined, secondWork: ReturnType<typeof complete> | undefined
  try {
    firstWork = complete(f, a, firstSubject)
    await bounded(gate.entered, 8000)
    secondWork = complete(g, b, scenario === 'same-subject' ? firstSubject : randomUUID(), undefined, second)
    const secondPid = await blockedBackend()
    overlapObservations.push({ scenario, firstPid: observed.nativePid, secondPid, blocked: true })
    expect(secondPid !== observed.nativePid).toBe(true)
    gate.release(); await Promise.all([firstWork, secondWork])
    const rows = (await stores.administrator.query('SELECT user_id,account_id FROM account WHERE user_id=ANY($1::text[])', [[f.principal.userId, g.principal.userId]])).rows
    expect(rows).toEqual([{ user_id: f.principal.userId, account_id: firstSubject }])
    const consumed = (await stores.administrator.query("SELECT count(*)::int n FROM google_account_intent WHERE id=ANY($1::uuid[]) AND phase='CONSUMED'", [[a.intentId, b.intentId]])).rows[0].n
    expect(consumed).toBe(1)
  } finally { gate.release(); observed.hold = false; await Promise.allSettled([firstWork, secondWork]); await second.close(); await direct.end() }
})

test('Cancel waits for overlapping native finalization and returns the committed result', async () => {
  const f = await enroll(), a = await authorize(f), direct = new Pool({ connectionString: stores.directRuntimeUrl, max: 2 })
  const second = createApplicationAuth(createTransactions(direct, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), config, limiter), gate = holdMutation()
  let work: ReturnType<typeof complete> | undefined, cancel: ReturnType<typeof second.cancelGoogleAccountIntent> | undefined
  try {
    work = complete(f, a); await bounded(gate.entered, 8000)
    cancel = second.cancelGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })
    const secondPid = await blockedBackend(); overlapObservations.push({ scenario: 'cancel-after-finalization', firstPid: observed.nativePid, secondPid, blocked: true })
    gate.release(); await work; expect((await cancel).state).toBe('linked')
  } finally { gate.release(); observed.hold = false; await Promise.allSettled([work, cancel]); await second.close(); await direct.end() }
})

test('Cancel during provider I/O invalidates a claimed exchange and a repeated callback cannot retry it', async () => {
  const f = await enroll(), a = await authorize(f)
  peer.holdHandoff()
  let work: ReturnType<typeof complete> | undefined
  try {
    work = complete(f, a)
    await expect.poll(() => peer.evidence().pendingHandoffs, { timeout: 3000 }).toBeGreaterThan(0)
    const phase = (await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [a.intentId])).rows[0].phase
    expect(phase).toBe('EXCHANGING')
    expect((await stores.administrator.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND xact_start IS NOT NULL")).rows[0].n).toBe(0)
    expect((await app.cancelGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('invalidated')
    peer.releaseHandoff(); await work
    const posts = peer.evidence().posts
    await complete(f, a)
    expect(peer.evidence().posts).toBe(posts)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
  } finally { peer.releaseHandoff(); await Promise.allSettled([work]) }
})

test.each(['deadline', 'key-removal'])('real User lock wait observes %s before callback claim', async scenario => {
  const f = await enroll(), a = await authorize(f), posts = peer.evidence().posts
  observed.nativePid = 0
  if (scenario === 'deadline') await stores.administrator.query(`UPDATE google_account_intent SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`, [a.intentId])
  await stores.administrator.query('BEGIN')
  await stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [f.principal.userId])
  let work: ReturnType<typeof complete> | undefined
  try {
    work = complete(f, a)
    const waiting = await blockedBackend()
    overlapObservations.push({ scenario, waitingPid: waiting, blocked: true, remover: 'owned database actor using User lock' })
    if (scenario === 'deadline') await new Promise(resolve => setTimeout(resolve, 550))
    else await stores.administrator.query('DELETE FROM passkey WHERE user_id=$1', [f.principal.userId])
    await stores.administrator.query('COMMIT')
    expect((await work).response.status).toBe(400)
    expect(peer.evidence().posts).toBe(posts)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
  } finally { await stores.administrator.query('ROLLBACK'); await Promise.allSettled([work]) }
})

test('consumed callback receipt remains readable after a participating tail removes the old key', async () => {
  const f = await enroll(), a = await authorize(f)
  observed.oauthTailPath = '/application/account/google/complete'
  observed.oauthTail = async () => { await stores.administrator.query('DELETE FROM passkey WHERE user_id=$1', [f.principal.userId]) }
  try { expect((await complete(f, a)).response.status).toBe(303) }
  finally { observed.oauthTailPath = ''; observed.oauthTail = async () => {} }
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
})

test('migration privileges and RLS isolate real intent rows from non-auth scope', async () => {
  const f = await enroll(), begin = await app.beginGoogleAccountLink(request(f.cookie)), direct = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  const connection = await direct.connect()
  try {
    await connection.query('BEGIN')
    await connection.query("SELECT set_config('app.tenant_id',$1,true)", [randomUUID()])
    expect((await connection.query('SELECT count(*)::int n FROM google_account_intent WHERE id=$1', [begin.intentId])).rows[0].n).toBe(0)
    const inserted = await connection.query(`INSERT INTO google_account_intent(id,user_id,session_id,workspace_id,recovery_generation,action,locale,created_at,expires_at,phase,authentication_challenge)
      VALUES($1,$2,$3,$4,0,'LINK','en',clock_timestamp(),clock_timestamp()+interval '1 minute','CHALLENGE','fixture')`, [randomUUID(), f.principal.userId, f.principal.sessionId, f.workspace!.id])
      .then(() => 'accepted', (error: { code?: string }) => error.code)
    expect(inserted).toBe('42501')
    await connection.query('ROLLBACK')
    const properties = (await stores.administrator.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.google_account_intent'::regclass")).rows[0]
    expect(properties.relrowsecurity).toBe(true)
    Object.assign(migrationObservations, { tenantReadHidden: true, tenantInsertDenied: true, rls: true })
  } finally { await connection.query('ROLLBACK'); connection.release(); await direct.end() }
})

test('Begin cleanup removes at most the oldest100 same-User rows and preserves current receipts and another User', async () => {
  const f = await enroll(), other = await enroll(), a = await authorize(f); await complete(f, a)
  const [binding] = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows
  const unlink = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: binding.id })
  await app.finishGoogleAccountUnlink(request(f.cookie), { intentId: unlink.intentId, response: f.credential.authenticationResponse(unlink.options, { counter: 2 }) })
  for (const [entry, amount] of [[f, 105], [other, 2]] as const) {
    await stores.administrator.query(`INSERT INTO google_account_intent(id,user_id,session_id,workspace_id,recovery_generation,action,locale,created_at,expires_at,phase,authentication_challenge)
      SELECT gen_random_uuid(),$1,$2,$3,0,'LINK','en',clock_timestamp()-interval '2 days'+n*interval '1 second',clock_timestamp()-interval '2 days'+n*interval '1 second'+interval '1 minute','CHALLENGE','fixture'
      FROM generate_series(1,$4::int) n`, [entry.principal.userId, entry.principal.sessionId, entry.workspace!.id, amount])
  }
  const oldest = (await stores.administrator.query("SELECT id FROM google_account_intent WHERE user_id=$1 AND created_at<clock_timestamp()-interval '1 day' ORDER BY created_at,id LIMIT 100", [f.principal.userId])).rows.map(row => row.id)
  await app.beginGoogleAccountLink(request(f.cookie))
  expect((await stores.administrator.query("SELECT count(*)::int n FROM google_account_intent WHERE user_id=$1 AND created_at<clock_timestamp()-interval '1 day'", [f.principal.userId])).rows[0].n).toBe(5)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM google_account_intent WHERE id=ANY($1::uuid[])', [oldest])).rows[0].n).toBe(0)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM google_account_intent WHERE user_id=$1', [other.principal.userId])).rows[0].n).toBe(2)
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('linked')
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: unlink.intentId })).state).toBe('unlinked')
})

test('multiple existing Google rows expose only unavailable and permit no selectable unlink repair', async () => {
  const f = await enroll(), a = await authorize(f); await complete(f, a)
  const extra = randomUUID()
  await stores.administrator.query("INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,'google',$3)", [extra, f.principal.userId, randomUUID()])
  expect((await app.readAccount(request(f.cookie))).googleAccount).toEqual({ state: 'unavailable' })
  await expect(app.beginGoogleAccountUnlink(request(f.cookie), { accountId: extra })).rejects.toBeDefined()
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(2)
})

test('first-key OAuth purpose cannot enter Google linking and leaves its original verification unconsumed', async () => {
  const subject = randomUUID(), start = await app.beginGoogleSignIn(request()), code = peer.register(start.url, subject)
  const login = await app.callback(request(cookies(start.headers), '/api/auth/callback/google?state=' + new URL(start.url).searchParams.get('state') + '&code=' + code, 'GET'))
  const cookie = cookies(login.headers), principal = await app.requirePrincipal(request(cookie))
  await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal)
  const first = await app.beginFirstGooglePasskey(request(cookie)), url = new URL(first.url), posts = peer.evidence().posts
  const firstCode = peer.register(first.url, subject, { claims: { auth_time: Math.floor(Date.now() / 1000) - 10 } })
  const response = await googleAccountCallbackResponse(request(cookie + '; ' + cookies(first.headers), '/api/auth/account/google/callback?state=' + url.searchParams.get('state') + '&code=' + firstCode, 'GET'), app, limiter)
  expect(response.status).toBe(400); expect(peer.evidence().posts).toBe(posts)
  expect((await stores.administrator.query('SELECT phase FROM first_google_passkey_intent WHERE id=$1', [first.intentId])).rows[0].phase).toBe('PENDING_GOOGLE')
  expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [url.searchParams.get('state')])).rows[0].n).toBe(1)
})

test('stale native ambient context cannot replace the current request-bound session', async () => {
  const f = await enroll(), other = await enroll()
  observed.captureSession = true
  let begin: Awaited<ReturnType<typeof app.beginGoogleAccountLink>>
  try { begin = await app.beginGoogleAccountLink(request(f.cookie)) } finally { observed.captureSession = false }
  const captured = Schema.decodeUnknownSync(Schema.Struct({ user: Schema.Struct({ id: Schema.String }), session: Schema.Struct({ id: Schema.String }) }))(observed.staleSession)
  expect(captured.session.id).toBe(f.principal.sessionId)
  observed.useStaleSession = true
  try {
    await expect(app.authorizeGoogleAccountLink(request(other.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options) })).rejects.toBeDefined()
  } finally { observed.useStaleSession = false; observed.staleSession = undefined }
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(0)
})

test('actual intent constraints reject invalid phase, target, terminal proof, missing receipt outcome and extended deadline', async () => {
  const f = await enroll(), begin = await app.beginGoogleAccountLink(request(f.cookie))
  const attempts = ["phase='unknown'", "action='UNLINK'", "phase='INVALIDATED',reason='cancelled'",
    "phase='CONSUMED',authentication_challenge=NULL,native_account_id='fixture',provider_subject='fixture'", "expires_at=created_at+interval '6 minutes'"]
  for (const update of attempts) {
    const code = await stores.administrator.query('UPDATE google_account_intent SET ' + update + ' WHERE id=$1', [begin.intentId])
      .then(() => 'accepted', (error: { code?: string }) => error.code)
    expect(code).toBe('23514')
  }
  migrationObservations.invalidStatesRefused = attempts.length
  expect((await app.readGoogleAccountIntent(request(f.cookie), { intentId: begin.intentId })).state).toBe('pending')
})

test('interrupted claimed callback has no repeated exchange from a fresh auth factory', async () => {
  const f = await enroll(), a = await authorize(f), url = new URL(a.url), code = peer.register(a.url, randomUUID())
  const path = '/api/auth/account/google/callback?state=' + url.searchParams.get('state') + '&code=' + code, cookie = f.cookie + '; ' + cookies(a.headers)
  const controller = new AbortController()
  peer.holdHandoff()
  const work = googleAccountCallbackResponse(request(cookie, path, 'GET', controller.signal), app, limiter)
  try {
    await expect.poll(() => peer.evidence().pendingHandoffs, { timeout: 3000 }).toBeGreaterThan(0)
    expect((await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [a.intentId])).rows[0].phase).toBe('EXCHANGING')
    controller.abort(); peer.releaseHandoff(); await work
  } finally { controller.abort(); peer.releaseHandoff(); await Promise.allSettled([work]) }
  const posts = peer.evidence().posts, fresh = createApplicationAuth(owner, config, limiter)
  try {
    await googleAccountCallbackResponse(request(cookie, path, 'GET'), fresh, limiter)
    expect(peer.evidence().posts).toBe(posts)
    expect((await fresh.readGoogleAccountIntent(request(f.cookie), { intentId: a.intentId })).state).toBe('exchanging')
  } finally { await fresh.close() }
})

test('UNLINK deadline reached during awaited native tail rolls back its key counter and Account deletion', async () => {
  const f = await enroll(), a = await authorize(f); await complete(f, a)
  const [row] = (await stores.administrator.query('SELECT id FROM account WHERE user_id=$1', [f.principal.userId])).rows
  const begin = await app.beginGoogleAccountUnlink(request(f.cookie), { accountId: row.id })
  await stores.administrator.query("UPDATE google_account_intent SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [begin.intentId])
  const gate = holdMutation()
  const work = app.finishGoogleAccountUnlink(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options, { counter: 2 }) }).then(() => 'confirmed', () => 'refused')
  try { await bounded(gate.entered, 8000); await new Promise(resolve => setTimeout(resolve, 2100)); gate.release(); expect(await work).toBe('refused') }
  finally { gate.release(); observed.hold = false; await work }
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].counter).toBe(1)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM account WHERE id=$1', [row.id])).rows[0].n).toBe(1)
  expect((await stores.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1', [begin.intentId])).rows[0].phase).toBe('CHALLENGE')
})

test('actual Redis denial precedes the sixth Begin and Redis outage precedes protected work', async () => {
  const f = await enroll(), client = '192.0.2.211'
  function sameClient() { const r = request(f.cookie); r.headers.set('x-real-ip', client); return r }
  for (let i = 0; i < 5; i++) await app.beginGoogleAccountLink(sameClient())
  const error = await app.beginGoogleAccountLink(sameClient()).then(() => undefined, error => error)
  expect(limiter.errorResponse(error)?.status).toBe(429)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM google_account_intent WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(5)
  await stores.restartRedis(async () => {
    const failed = await app.beginGoogleAccountLink(request(f.cookie)).then(() => undefined, error => error)
    expect(limiter.errorResponse(failed)?.status).toBe(503)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM google_account_intent WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(5)
  })
})
