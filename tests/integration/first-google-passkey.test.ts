import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startGoogleProtocolPeer, type GoogleFixtureOptions } from '../helpers/google-protocol-peer.mjs'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { eq } from 'drizzle-orm'
import { firstGooglePasskeyIntent, passkey } from '../../src/modules/auth/schema.server'
import { APIError } from 'better-auth/api'

const held = vi.hoisted(() => ({ path: '', used: false, entered: Promise.resolve(), enter: () => {}, gate: Promise.resolve(), release: () => {}, afterFailure: false, provider: false,
  afterHold: false, intentId: '', nativeSuccess: false, nativeInserted: false, nativeConsumed: false,
  cancelLock: false, dropAmbient: false, ambientVerified: false, interruptProvider: false, abortListenerReached: false,
  observeChallenge: false, verifiedHookReached: false, challengeRequest: undefined as Request | undefined }))
vi.mock('@better-auth/passkey', async importOriginal => {
  const actual = await importOriginal<typeof import('@better-auth/passkey')>()
  return { ...actual, passkey(options: Parameters<typeof actual.passkey>[0]) {
    const after = options?.registration?.afterVerification
    return actual.passkey({ ...options, registration: { ...options?.registration, async afterVerification(args) {
      if (held.observeChallenge && args.ctx.request === held.challengeRequest && args.context === 'first-google-passkey:' + held.intentId) held.verifiedHookReached = true
      if (held.dropAmbient && args.context?.startsWith('first-google-passkey:')) {
        held.ambientVerified = args.verification.verified === true && args.verification.registrationInfo?.userVerified === true
        // Negative late mutation after the real native cryptographic result and prior ambient check.
        return after?.({ ...args, ctx: { ...args.ctx, context: { ...args.ctx.context, session: null } } })
      }
      return after?.(args)
    } } })
  } }
})
vi.mock('../../src/modules/auth/first-google-passkey.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/first-google-passkey.server')>()
  return { ...actual, async lockFirstGoogleState(...args: Parameters<typeof actual.lockFirstGoogleState>) {
    const state = await actual.lockFirstGoogleState(...args)
    if (held.cancelLock && args[2] === held.intentId && args[3] === 'receipt' && !held.used) { held.used = true; held.enter(); await held.gate }
    return state
  } }
})
vi.mock('../../src/modules/auth/google-protocol.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/google-protocol.server')>()
  return { ...actual, createGoogleProtocol(...args: Parameters<typeof actual.createGoogleProtocol>) {
    const protocol = actual.createGoogleProtocol(...args)
    return { ...protocol, lifetime() {
      const lifetime = protocol.lifetime()
      return { ...lifetime, decorate(provider: Parameters<typeof lifetime.decorate>[0]) {
        const native = lifetime.decorate(provider)
        return { ...native, async getUserInfo(...input: Parameters<typeof native.getUserInfo>) {
          const result = await native.getUserInfo(...input)
          if (held.interruptProvider && !held.used) {
            held.used = true; held.enter()
            const signal = args[0].invocationOptions().signal
            if (!signal || signal.aborted) throw new Error('Owned callback interruption signal unavailable')
            await new Promise<never>((_done, reject) => {
              const aborted = () => { held.abortListenerReached = true; signal.removeEventListener('abort', aborted); reject(new Error('Owned callback interrupted after claim')) }
              signal.addEventListener('abort', aborted, { once: true })
            })
          }
          if (held.provider && !held.used) { held.used = true; held.enter(); await held.gate }
          return result
        } }
      } }
    } }
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware, APIError } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
      const result = await before({ ...ctx, returnHeaders: false })
      if (args[6]?.(ctx.request) && ctx.path === held.path && !held.used) { held.used = true; held.enter(); await held.gate }
      return result
    }) }], after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/passkey/verify-registration', handler: createAuthMiddleware(async ctx => {
      if (held.afterHold && args[6]?.(ctx.request) && !held.used) {
        const value = ctx.context.returned
        if (typeof value !== 'object' || value === null || value instanceof APIError || !('id' in value) || typeof value.id !== 'string'
          || !('userId' in value) || typeof value.userId !== 'string' || !('credentialID' in value) || typeof value.credentialID !== 'string') throw new Error('Native success witness unavailable')
        const keys = await args[0].currentDb().select({ id: passkey.id }).from(passkey).where(eq(passkey.id, value.id))
        const intents = await args[0].currentDb().select({ phase: firstGooglePasskeyIntent.phase }).from(firstGooglePasskeyIntent).where(eq(firstGooglePasskeyIntent.id, held.intentId))
        held.nativeSuccess = true; held.nativeInserted = keys.length === 1; held.nativeConsumed = intents.length === 1 && intents[0].phase === 'CONSUMED'
        held.used = true; held.enter(); await held.gate
      }
      if (held.afterFailure) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Owned native after-hook rejection' })
    }) }] } }
  } }
})

const origin = 'http://localhost:3000'
let stores: Awaited<ReturnType<typeof startDisposableStores>>, peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>
let pool: Pool, owner: ReturnType<typeof createTransactions>, app: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
let ip = 1
let config: Parameters<typeof createApplicationAuth>[1]
const fix1Observations: Record<string, unknown>[] = []
const cookies = (headers: Headers) => headers.getSetCookie().filter(cookie => !/;\s*Max-Age=0(?:;|$)/i.test(cookie)).map(cookie => cookie.split(';')[0]).join('; ')
function request(path = '/first', method = 'POST', cookie = '', signal?: AbortSignal) {
  const value = Object.assign(new Request(origin + path, { method, signal, headers: { cookie, ...(method === 'POST' ? { origin } : {}), 'x-real-ip': `198.18.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return value
}
async function refusal(work: Promise<unknown>) { return work.then(() => 200, error => app.firstGooglePasskeyErrorResponse(error)?.status ?? limiter.errorResponse(error)?.status ?? 500) }
async function unchanged(userId: string) {
  const result = await stores.administrator.query(`SELECT * FROM (
    SELECT 'user' kind,to_jsonb(u) value FROM "user" u WHERE id=$1 UNION ALL
    SELECT 'session',to_jsonb(s) FROM session s WHERE user_id=$1 UNION ALL
    SELECT 'account',to_jsonb(a) FROM account a WHERE user_id=$1
  ) snapshot ORDER BY kind,value::text`, [userId])
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')
}
async function firstPersistence(userId: string) {
  const rows = await stores.administrator.query(`SELECT * FROM (
    SELECT 'session' kind,to_jsonb(s) value FROM session s WHERE user_id=$1 UNION ALL
    SELECT 'key',to_jsonb(p) FROM passkey p WHERE user_id=$1 UNION ALL
    SELECT 'intent',to_jsonb(i) FROM first_google_passkey_intent i WHERE i.user_id=$1 UNION ALL
    SELECT 'verification',to_jsonb(v) FROM verification v JOIN first_google_passkey_intent i ON i.registration_verification_identifier=v.identifier WHERE i.user_id=$1
  ) snapshot ORDER BY kind,value::text`, [userId])
  return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex')
}
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.first_google_passkey_intent TO runtime;
    GRANT SELECT,INSERT ON public.passkey TO runtime;
    GRANT UPDATE(counter) ON public.passkey TO runtime`)
  peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
  pool = new Pool({ connectionString: stores.runtimeUrl, max: 4 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'first-google', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  await limiter.connect()
  config = readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!
  app = createApplicationAuth(owner, config, limiter)
})
afterAll(async () => {
  held.release()
  const failed: string[] = []
  for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()], ['peer', () => peer?.close()]] as const) {
    try { await close() } catch { failed.push(name) }
  }
  if (stores) {
    try { await stores.cleanup() } catch { failed.push('stores') }
    const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9c-evidence')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`), JSON.stringify({ stores: stores.evidence, cleanupFailures: failed, peer: peer?.evidence(), fix1Observations }, null, 2) + '\n', { flag: 'wx' })
  }
  expect(failed).toEqual([])
})
async function linked() {
  const subject = randomUUID(), start = await app.beginGoogleSignIn(request())
  const url = new URL(start.url), code = peer.register(start.url, subject)
  const result = await app.callback(request(`/api/auth/callback/google?state=${url.searchParams.get('state')}&code=${code}`, 'GET', cookies(start.headers)))
  expect(result.status).toBe(302)
  const cookie = cookies(result.headers), principal = await app.requirePrincipal(request('/account', 'GET', cookie))
  await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal)
  return { subject, cookie, principal }
}
async function begun(f: Awaited<ReturnType<typeof linked>>) {
  const result = await app.beginFirstGooglePasskey(request('/first', 'POST', f.cookie), 'en'), url = new URL(result.url)
  const row = (await stores.administrator.query('SELECT id FROM first_google_passkey_intent WHERE id=$1 AND user_id=$2', [result.intentId, f.principal.userId])).rows[0]
  expect(Boolean(row && row.id === result.intentId)).toBe(true)
  expect(url.searchParams.get('redirect_uri')).toBe(origin + '/api/auth/first-passkey/google/callback')
  expect(JSON.parse(url.searchParams.get('claims') ?? '{}')).toEqual({ id_token: { auth_time: { essential: true } } })
  expect(['max_age', 'prompt', 'access_type'].every(key => !url.searchParams.has(key))).toBe(true)
  expect(result.headers.getSetCookie().some(value => value.includes('session_token'))).toBe(false)
  return { result, url, intentId: String(row.id), cookie: f.cookie + '; ' + cookies(result.headers) }
}
async function completed(f: Awaited<ReturnType<typeof linked>>, start: Awaited<ReturnType<typeof begun>>, options: GoogleFixtureOptions = { claims: { auth_time: Math.floor(Date.now() / 1000) - 10 } }, subject = f.subject) {
  expect(start.cookie.split(';').filter(value => value.trim().startsWith('__Secure-better-auth.state=')).length).toBe(1)
  const code = peer.register(start.result.url, subject, options)
  const path = `/api/auth/first-passkey/google/callback?state=${start.url.searchParams.get('state')}&code=${code}`
  const result = await app.completeFirstGooglePasskeyOAuth(request(path, 'GET', start.cookie))
    .catch((): never => { throw new Error('First-key callback refused before safe completion') })
  expect(result.headers.getSetCookie().some(value => value.includes('session_token'))).toBe(false)
  return { result, path, status: await app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId }) }
}
test('controlled Google proof preserves original session during first native UV insertion then logs into same User with the key', async () => {
  const f = await linked(), before = await unchanged(f.principal.userId), start = await begun(f)
  const callback = await completed(f, start)
  expect(callback.status.state).toBe('authorized')
  expect(await unchanged(f.principal.userId) === before).toBe(true)
  const options = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  const credential = registrationCredentialFixture(options.options, origin)
  expect((await app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(options.headers)), { intentId: start.intentId, response: credential.response })).added).toBe(true)
  expect((await app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe('added')
  expect(await unchanged(f.principal.userId) === before).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(1)
  await app.logout(request('/logout', 'POST', f.cookie))
  const login = await app.beginPasskeySignIn(request())
  const signed = credential.authenticationResponse(login.options)
  const signedIn = await app.finishPasskeySignIn(request('/login', 'POST', cookies(login.headers)), { response: signed })
  expect(signedIn.authenticated).toBe(true)
  const returned = await app.requirePrincipal(request('/account', 'GET', cookies(signedIn.headers)))
  expect(returned.userId === f.principal.userId).toBe(true)
  expect(returned.sessionId !== f.principal.sessionId).toBe(true)
})
test.each(['missing', 'string', 'fractional', 'old', 'future', 'future-iat', 'after-iat', 'wrong-subject', 'nonce'])(
  'first Google callback rejects %s without identity or session persistence', async variant => {
    const f = await linked(), start = await begun(f), before = await unchanged(f.principal.userId), now = Math.floor(Date.now() / 1000)
    const auth_time = variant === 'missing' ? undefined : variant === 'string' ? String(now) : variant === 'fractional' ? now - 0.5 : variant === 'old' ? now - 301 : variant === 'future' ? now + 60 : now - 10
    const claims = { auth_time, ...(variant === 'future-iat' ? { iat: now + 60 } : {}), ...(variant === 'after-iat' ? { iat: now - 20 } : {}), ...(variant === 'nonce' ? { nonce: 'wrong' } : {}) }
    const result = await completed(f, start, { claims, email: f.principal.email }, variant === 'wrong-subject' ? randomUUID() : f.subject)
    expect(result.status.state).toBe('invalidated')
    expect(await unchanged(f.principal.userId) === before).toBe(true)
    expect(await refusal(app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId }))).toBe(401)
  })
test('native registration UVfalse and regenerated old challenge refuse; cancellation cannot erase consumed receipt', async () => {
  const f = await linked(), start = await begun(f); await completed(f, start)
  const first = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  const second = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  const old = registrationCredentialFixture(first.options, origin)
  expect(await refusal(app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(first.headers)), { intentId: start.intentId, response: old.response }))).toBe(401)
  const bad = registrationCredentialFixture(second.options, origin, false)
  expect(await refusal(app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(second.headers)), { intentId: start.intentId, response: bad.response }))).toBe(401)
  const good = registrationCredentialFixture(second.options, origin)
  expect((await app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(second.headers)), { intentId: start.intentId, response: good.response })).added).toBe(true)
  expect((await app.cancelFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe('added')
})
test('cancelled and duplicate callbacks cannot exchange again; purpose swaps cannot use primary completion', async () => {
  const f = await linked(), start = await begun(f)
  await app.cancelFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  const posts = peer.evidence().posts, code = peer.register(start.result.url, f.subject, { claims: { auth_time: Math.floor(Date.now() / 1000) } })
  expect(await refusal(app.completeFirstGooglePasskeyOAuth(request(`/api/auth/first-passkey/google/callback?state=${start.url.searchParams.get('state')}&code=${code}`, 'GET', start.cookie)))).toBe(401)
  expect(peer.evidence().posts).toBe(posts)
  const swap = await begun(f), swapCode = peer.register(swap.result.url, f.subject)
  const primary = await app.callback(request(`/api/auth/callback/google?state=${swap.url.searchParams.get('state')}&code=${swapCode}`, 'GET', swap.cookie))
  expect(primary.headers.getSetCookie().some(value => value.includes('session_token'))).toBe(false)
  expect(peer.evidence().posts).toBe(posts)
  const primaryStart = await app.beginGoogleSignIn(request()), url = new URL(primaryStart.url)
  expect(await refusal(app.completeFirstGooglePasskeyOAuth(request(`/api/auth/first-passkey/google/callback?state=${url.searchParams.get('state')}&code=fixture`, 'GET', f.cookie + '; ' + cookies(primaryStart.headers))))).toBe(401)
  expect(peer.evidence().posts).toBe(posts)
})
test('expired original native session deletion rolls back and authorization never replaces it', async () => {
  const f = await linked(), start = await begun(f)
  await stores.administrator.query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.principal.sessionId])
  const before = await unchanged(f.principal.userId)
  expect(await refusal(app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId }))).toBe(401)
  expect(await unchanged(f.principal.userId) === before).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE id=$1', [f.principal.sessionId])).rows[0].n).toBe(1)
})
test('invalidated SQL receipt must retain a nonnull safe reason', async () => {
  const f = await linked(), start = await begun(f)
  let refused = false
  try { await stores.administrator.query("UPDATE first_google_passkey_intent SET phase='INVALIDATED',reason=NULL WHERE id=$1", [start.intentId]) }
  catch (error) { refused = error instanceof Error && 'code' in error && error.code === '23514' }
  expect(refused).toBe(true)
})

test.each(['generation', 'hold', 'recovering', 'workspace', 'account-removed', 'account-replaced', 'session-revoked', 'session-replaced'])(
  'authorized first-key intent rejects changed %s at native options', async mutation => {
    const f = await linked(), start = await begun(f); await completed(f, start)
    let cookie = f.cookie
    if (mutation === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [f.principal.userId])
    if (mutation === 'hold') await stores.administrator.query("UPDATE \"user\" SET hold_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.principal.userId])
    if (mutation === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [f.principal.userId])
    if (mutation === 'workspace') await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE owner_user_id=$1", [f.principal.userId])
    if (mutation === 'account-removed') await stores.administrator.query('DELETE FROM account WHERE user_id=$1', [f.principal.userId])
    if (mutation === 'account-replaced') await stores.administrator.query('UPDATE account SET id=$2 WHERE user_id=$1', [f.principal.userId, randomUUID()])
    if (mutation === 'session-revoked') await stores.administrator.query('DELETE FROM session WHERE id=$1', [f.principal.sessionId])
    if (mutation === 'session-replaced') {
      const primary = await app.beginGoogleSignIn(request()), url = new URL(primary.url), code = peer.register(primary.url, f.subject)
      const result = await app.callback(request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(primary.headers)))
      expect(result.status).toBe(302); cookie = cookies(result.headers)
      expect((await app.requirePrincipal(request('/account', 'GET', cookie))).userId === f.principal.userId).toBe(true)
    }
    expect(await refusal(app.prepareFirstGooglePasskey(request('/first', 'POST', cookie), { intentId: start.intentId }))).toBe(401)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
  })

test('native after-hook failure rolls back insert and consumption; committed Finish raw500 reconciles without resending', async () => {
  const f = await linked(), start = await begun(f); await completed(f, start)
  const options = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  const input = { intentId: start.intentId, response: registrationCredentialFixture(options.options, origin).response }
  held.afterFailure = true
  try { expect(await refusal(app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(options.headers)), input))).toBe(500) }
  finally { held.afterFailure = false }
  expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
  expect((await app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe('authorized')
  // This is a known rollback, so the test intentionally makes a new explicit native attempt.
  const next = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  let finishes = 0
  const raw = await (async () => {
    finishes++
    await app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(next.headers)), { intentId: start.intentId, response: registrationCredentialFixture(next.options, origin).response })
    return new Response('Unconfirmed', { status: 500 })
  })()
  expect(raw.status).toBe(500)
  expect((await app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe('added')
  expect(finishes).toBe(1)
})

test('two sessions on overlapping database backends serialize first-key insertion and invalidate the competing intent', async () => {
  const f = await linked(), one = await begun(f); await completed(f, one)
  const login = await app.beginGoogleSignIn(request()), url = new URL(login.url), code = peer.register(login.url, f.subject)
  const logged = await app.callback(request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(login.headers)))
  expect(logged.status).toBe(302)
  const otherCookie = cookies(logged.headers), otherPrincipal = await app.requirePrincipal(request('/account', 'GET', otherCookie))
  expect(otherPrincipal.userId === f.principal.userId && otherPrincipal.sessionId !== f.principal.sessionId).toBe(true)
  const other = { ...f, cookie: otherCookie, principal: otherPrincipal }
  const two = await begun(other); await completed(other, two)
  const optionsA = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: one.intentId })
  const optionsB = await app.prepareFirstGooglePasskey(request('/first', 'POST', other.cookie), { intentId: two.intentId })
  const poolB = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  const ownerB = createTransactions(poolB, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), appB = createApplicationAuth(ownerB, config, limiter)
  held.path = '/passkey/verify-registration'; held.used = false
  held.entered = new Promise(resolve => { held.enter = resolve }); held.gate = new Promise(resolve => { held.release = resolve })
  const first = refusal(app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(optionsA.headers)), { intentId: one.intentId, response: registrationCredentialFixture(optionsA.options, origin).response }))
  let second: Promise<number> | undefined
  try {
    await expect.poll(() => held.used, { timeout: 2000, interval: 10 }).toBe(true)
    second = refusal(appB.finishFirstGooglePasskey(request('/first', 'POST', other.cookie + '; ' + cookies(optionsB.headers)), { intentId: two.intentId, response: registrationCredentialFixture(optionsB.options, origin).response }))
    await expect.poll(async () => (await stores.administrator.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(w.pid))
      WHERE w.usename='runtime' AND b.usename='runtime' AND w.pid<>b.pid AND w.wait_event_type='Lock') overlap`)).rows[0].overlap, { timeout: 700, interval: 10 }).toBe(true)
    held.release()
    expect(await Promise.all([first, second])).toEqual([200, 401])
    expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(1)
    expect((await app.readFirstGooglePasskey(request('/first', 'POST', other.cookie), { intentId: two.intentId })).reason).toBe('superseded')
  } finally {
    held.release(); held.path = ''; await Promise.allSettled([first, ...(second ? [second] : [])]); await appB.close(); await poolB.end()
  }
})

test.each(['expired', 'session-revoked', 'account-replaced', 'cancelled'])(
  'provider work cannot finalize after %s and the committed claim cannot exchange twice', async mutation => {
    const f = await linked(), start = await begun(f)
    held.provider = true; held.used = false
    held.entered = new Promise(resolve => { held.enter = resolve }); held.gate = new Promise(resolve => { held.release = resolve })
    const code = peer.register(start.result.url, f.subject, { claims: { auth_time: Math.floor(Date.now() / 1000) - 10 } })
    const path = `/api/auth/first-passkey/google/callback?state=${start.url.searchParams.get('state')}&code=${code}`
    const pending = refusal(app.completeFirstGooglePasskeyOAuth(request(path, 'GET', start.cookie)))
    try {
      await expect.poll(() => held.used, { timeout: 2000, interval: 10 }).toBe(true)
      expect((await stores.administrator.query('SELECT phase FROM first_google_passkey_intent WHERE id=$1', [start.intentId])).rows[0].phase).toBe('EXCHANGING')
      // These writes must complete while the provider continuation is held: no auth transaction owns their locks.
      if (mutation === 'expired') await stores.administrator.query("UPDATE first_google_passkey_intent SET created_at=statement_timestamp()-interval '301 seconds',expires_at=statement_timestamp()-interval '1 second' WHERE id=$1", [start.intentId])
      if (mutation === 'session-revoked') await stores.administrator.query('DELETE FROM session WHERE id=$1', [f.principal.sessionId])
      if (mutation === 'account-replaced') await stores.administrator.query('UPDATE account SET id=$2 WHERE user_id=$1', [f.principal.userId, randomUUID()])
      if (mutation === 'cancelled') expect((await app.cancelFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).reason).toBe('cancelled')
      const posts = peer.evidence().posts
      expect(await refusal(app.completeFirstGooglePasskeyOAuth(request(path, 'GET', start.cookie)))).not.toBe(200)
      expect(peer.evidence().posts).toBe(posts)
      held.release(); await pending
      expect((await stores.administrator.query('SELECT count(*)::int n FROM first_google_passkey_intent WHERE id=$1 AND phase IN (\'AUTHORIZED\',\'CONSUMED\')', [start.intentId])).rows[0].n).toBe(0)
      expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
    } finally { held.release(); held.provider = false; await pending }
  })

test('registration finalization rechecks the nonrenewable database deadline after native work', async () => {
  const f = await linked(), start = await begun(f); await completed(f, start)
  await stores.administrator.query("UPDATE first_google_passkey_intent SET created_at=statement_timestamp()-interval '299 seconds',expires_at=statement_timestamp()+interval '1 second' WHERE id=$1", [start.intentId])
  const options = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  held.afterHold = true; held.used = false; held.intentId = start.intentId
  held.nativeSuccess = false; held.nativeInserted = false; held.nativeConsumed = false
  held.entered = new Promise(resolve => { held.enter = resolve }); held.gate = new Promise(resolve => { held.release = resolve })
  const pending = refusal(app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(options.headers)), { intentId: start.intentId, response: registrationCredentialFixture(options.options, origin).response }))
  try {
    await expect.poll(() => held.used, { timeout: 700, interval: 10 }).toBe(true)
    expect({ success: held.nativeSuccess, inserted: held.nativeInserted, consumed: held.nativeConsumed }).toEqual({ success: true, inserted: true, consumed: true })
    await expect.poll(async () => (await stores.administrator.query('SELECT clock_timestamp() >= expires_at expired FROM first_google_passkey_intent WHERE id=$1', [start.intentId])).rows[0].expired,
      { timeout: 2000, interval: 20 }).toBe(true)
    held.release()
    expect(await pending).toBe(401)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
    expect((await app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe('expired')
  } finally { held.release(); held.afterHold = false; await pending }
})

test('fixed receipt retention and deterministic hundred-row cleanup remain User scoped', async () => {
  const f = await linked(), start = await begun(f), foreign = await linked(), other = await begun(foreign)
  const ids = Array.from({ length: 101 }, () => randomUUID())
  await stores.administrator.query(`INSERT INTO first_google_passkey_intent(id,user_id,session_id,workspace_id,recovery_generation,account_id,subject,created_at,expires_at,phase,reason)
    SELECT value::uuid,i.user_id,i.session_id,i.workspace_id,i.recovery_generation,i.account_id,i.subject,
      statement_timestamp()-interval '2 days'+ordinality*interval '1 millisecond',
      statement_timestamp()-interval '2 days'+ordinality*interval '1 millisecond'+interval '5 minutes','INVALIDATED','cancelled'
    FROM first_google_passkey_intent i CROSS JOIN unnest($1::text[]) WITH ORDINALITY AS seed(value,ordinality) WHERE i.id=$2`, [ids, start.intentId])
  await stores.administrator.query("UPDATE first_google_passkey_intent SET created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '2 days'+interval '5 minutes' WHERE id=$1", [other.intentId])
  expect(await refusal(app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: ids[100] }))).toBe(401)
  const fresh = await begun(f)
  const rows = (await stores.administrator.query('SELECT id FROM first_google_passkey_intent WHERE user_id=$1', [f.principal.userId])).rows.map(row => row.id)
  expect({ count: rows.length, oldestRemoved: ids.slice(0, 100).every(id => !rows.includes(id)), lastRetained: rows.includes(ids[100]), live: rows.includes(start.intentId), fresh: rows.includes(fresh.intentId) })
    .toEqual({ count: 3, oldestRemoved: true, lastRetained: true, live: true, fresh: true })
  expect((await stores.administrator.query('SELECT count(*)::int n FROM first_google_passkey_intent WHERE id=$1', [other.intentId])).rows[0].n).toBe(1)
})

test.each(['signed-challenge', 'missing-cookie', 'other-cookie', 'stored-context', 'stored-user', 'bypassed-ambient'] as const)(
  'fix1 current native binding rejects %s without persistence changes', async mutation => {
    const f = await linked(), start = await begun(f); await completed(f, start)
    const options = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
    let cookie = f.cookie + '; ' + cookies(options.headers)
    if (mutation === 'missing-cookie') cookie = f.cookie
    if (mutation === 'other-cookie') {
      const other = await begun(f); await completed(f, other)
      const foreign = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: other.intentId })
      cookie = f.cookie + '; ' + cookies(foreign.headers)
    }
    if (mutation === 'stored-context' || mutation === 'stored-user') {
      const path = mutation === 'stored-context' ? '{context}' : '{userData,id}'
      await stores.administrator.query(`UPDATE verification v SET value=jsonb_set(v.value::jsonb,$2::text[],to_jsonb($3::text))::text
        FROM first_google_passkey_intent i WHERE i.id=$1 AND i.registration_verification_identifier=v.identifier`,
      [start.intentId, path, mutation === 'stored-context' ? 'first-google-passkey:' + randomUUID() : randomUUID()])
    }
    const response = registrationCredentialFixture(mutation === 'signed-challenge' ? { ...options.options, challenge: 'AQIDBA' } : options.options, origin).response
    const before = await firstPersistence(f.principal.userId), identity = await unchanged(f.principal.userId)
    let currentBoundMismatch = false
    if (mutation === 'signed-challenge') {
      const rows = (await stores.administrator.query(`SELECT v.value FROM verification v JOIN first_google_passkey_intent i
        ON i.registration_verification_identifier=v.identifier WHERE i.id=$1 AND i.user_id=$2`, [start.intentId, f.principal.userId])).rows
      const submitted = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'))
      currentBoundMismatch = rows.length === 1 && JSON.parse(rows[0].value).expectedChallenge === options.options.challenge
        && submitted.challenge !== options.options.challenge && submitted.type === 'webauthn.create' && submitted.origin === origin
      expect(currentBoundMismatch).toBe(true)
    }
    const finishRequest = request('/first', 'POST', cookie)
    held.dropAmbient = mutation === 'bypassed-ambient'; held.ambientVerified = false
    held.observeChallenge = mutation === 'signed-challenge'; held.verifiedHookReached = false; held.intentId = start.intentId; held.challengeRequest = finishRequest
    try {
      let exactNativeFailure = false
      const status = await app.finishFirstGooglePasskey(finishRequest, { intentId: start.intentId, response }).then(() => 200, error => {
        exactNativeFailure = error instanceof APIError && error.statusCode === 500 && error.body?.code === 'FAILED_TO_VERIFY_REGISTRATION'
        return app.firstGooglePasskeyErrorResponse(error)?.status ?? limiter.errorResponse(error)?.status ?? 500
      })
      expect(await firstPersistence(f.principal.userId) === before).toBe(true)
      expect(await unchanged(f.principal.userId) === identity).toBe(true)
      expect(status).toBe(mutation === 'signed-challenge' ? 500 : 401)
      if (mutation === 'signed-challenge') expect({ exactNativeFailure, currentBoundMismatch, verifiedHookReached: held.verifiedHookReached })
        .toEqual({ exactNativeFailure: true, currentBoundMismatch: true, verifiedHookReached: false })
      if (mutation === 'bypassed-ambient') expect(held.ambientVerified).toBe(true)
      fix1Observations.push({ case: mutation, status, exactNativeFailure, currentBoundMismatch, verifiedHookReached: held.verifiedHookReached,
        persistenceUnchanged: true, identityUnchanged: true, realVerifiedBeforeAmbientRemoval: held.ambientVerified })
    } finally { held.dropAmbient = false; held.observeChallenge = false; held.challengeRequest = undefined }
  })

test.each(['cancel-first', 'finish-first'] as const)('fix1 actual Cancel Finish overlap %s retains the winning outcome', async order => {
  const f = await linked(), start = await begun(f); await completed(f, start)
  const options = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  const input = { intentId: start.intentId, response: registrationCredentialFixture(options.options, origin).response }
  const poolB = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  const appB = createApplicationAuth(createTransactions(poolB, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), config, limiter)
  const identity = await unchanged(f.principal.userId)
  held.intentId = start.intentId; held.used = false; held.cancelLock = order === 'cancel-first'; held.path = order === 'finish-first' ? '/passkey/verify-registration' : ''
  held.entered = new Promise(resolve => { held.enter = resolve }); held.gate = new Promise(resolve => { held.release = resolve })
  let cancelState = '', cancelReason: string | null = null
  const cancel = (application: typeof app) => refusal(application.cancelFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
    .then(result => { cancelState = result.state; cancelReason = result.reason; return result }))
  const finish = (application: typeof app) => refusal(application.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(options.headers)), input))
  const first = order === 'cancel-first' ? cancel(app) : finish(app)
  let second: Promise<number> | undefined
  try {
    await expect.poll(() => held.used, { timeout: 2000, interval: 10 }).toBe(true)
    second = order === 'cancel-first' ? finish(appB) : cancel(appB)
    await expect.poll(async () => (await stores.administrator.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(w.pid))
      WHERE w.usename='runtime' AND b.usename='runtime' AND w.pid<>b.pid AND w.wait_event_type='Lock') overlap`)).rows[0].overlap, { timeout: 700, interval: 10 }).toBe(true)
    held.release()
    const statuses = await Promise.all([first, second])
    expect(statuses).toEqual(order === 'cancel-first' ? [200, 401] : [200, 200])
    expect({ cancelState, cancelReason }).toEqual(order === 'cancel-first' ? { cancelState: 'invalidated', cancelReason: 'cancelled' } : { cancelState: 'added', cancelReason: null })
    const keyCount = (await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n
    expect(keyCount).toBe(order === 'cancel-first' ? 0 : 1)
    expect((await app.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe(cancelState)
    expect(await unchanged(f.principal.userId) === identity).toBe(true)
    fix1Observations.push({ case: order, observedIndependentBackendBlocking: true, statuses, cancelState, cancelReason, keyCount, identityUnchanged: true })
  } finally {
    held.release(); held.cancelLock = false; held.path = ''
    await Promise.allSettled([first, ...(second ? [second] : [])]); await appB.close(); await poolB.end()
  }
})

test('fix1 interrupted durable EXCHANGING cannot replay in a fresh application instance', async () => {
  const f = await linked(), start = await begun(f), identity = await unchanged(f.principal.userId)
  const poolA = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  const applicationA = createApplicationAuth(createTransactions(poolA, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), config, limiter)
  const controller = new AbortController()
  held.used = false; held.interruptProvider = true; held.abortListenerReached = false; held.entered = new Promise(resolve => { held.enter = resolve })
  const code = peer.register(start.result.url, f.subject, { claims: { auth_time: Math.floor(Date.now() / 1000) - 10 } })
  const path = `/api/auth/first-passkey/google/callback?state=${start.url.searchParams.get('state')}&code=${code}`
  let settled = false
  const pending = refusal(applicationA.completeFirstGooglePasskeyOAuth(request(path, 'GET', start.cookie, controller.signal))).then(status => { settled = true; return status })
  try {
    await expect.poll(() => held.used, { timeout: 2000, interval: 10 }).toBe(true)
    expect((await stores.administrator.query('SELECT phase FROM first_google_passkey_intent WHERE id=$1', [start.intentId])).rows[0].phase).toBe('EXCHANGING')
    expect(settled).toBe(false); expect(controller.signal.aborted).toBe(false)
    controller.abort()
    expect(await pending).not.toBe(200)
    expect(held.abortListenerReached).toBe(true)
  } finally {
    controller.abort(); await pending; held.interruptProvider = false; await applicationA.close(); await poolA.end()
  }
  const poolB = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  const applicationB = createApplicationAuth(createTransactions(poolB, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), config, limiter)
  try {
    const posts = peer.evidence().posts
    expect(await refusal(applicationB.completeFirstGooglePasskeyOAuth(request(path, 'GET', start.cookie)))).not.toBe(200)
    expect(peer.evidence().posts).toBe(posts)
    expect((await applicationB.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).state).toBe('exchanging')
    expect((await applicationB.cancelFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })).reason).toBe('cancelled')
    const next = await applicationB.beginFirstGooglePasskey(request('/first', 'POST', f.cookie))
    expect(next.intentId !== start.intentId).toBe(true)
    expect((await applicationB.readFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: next.intentId })).state).toBe('pending')
    expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(0)
    expect(await unchanged(f.principal.userId) === identity).toBe(true)
    fix1Observations.push({ case: 'interruption-restart', durableClaim: true, pendingUnsettledBeforeAbort: true, abortListenerReached: held.abortListenerReached,
      interruptionDrained: true, freshInstance: true, replayPosts: 0, priorStatus: 'exchanging', abandonment: 'cancelled', newBegin: true, keyCount: 0 })
  } finally { await applicationB.close(); await poolB.end() }
})

test('fix1 lock wait crosses the database deadline before first-key authority is acquired', async () => {
  const f = await linked(), start = await begun(f); await completed(f, start)
  const options = await app.prepareFirstGooglePasskey(request('/first', 'POST', f.cookie), { intentId: start.intentId })
  await stores.administrator.query("UPDATE first_google_passkey_intent SET created_at=statement_timestamp()-interval '299500 milliseconds',expires_at=statement_timestamp()+interval '500 milliseconds' WHERE id=$1", [start.intentId])
  const before = await firstPersistence(f.principal.userId), identity = await unchanged(f.principal.userId)
  await stores.administrator.query('BEGIN')
  let transactionOpen = true, pending: Promise<number> | undefined
  try {
    const blocker = (await stores.administrator.query('SELECT pg_backend_pid() pid')).rows[0].pid
    await stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [f.principal.userId])
    pending = refusal(app.finishFirstGooglePasskey(request('/first', 'POST', f.cookie + '; ' + cookies(options.headers)), { intentId: start.intentId, response: registrationCredentialFixture(options.options, origin).response }))
    await expect.poll(async () => (await stores.administrator.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') blocked", [blocker])).rows[0].blocked,
      { timeout: 700, interval: 10 }).toBe(true)
    await expect.poll(async () => (await stores.administrator.query('SELECT clock_timestamp() >= expires_at expired FROM first_google_passkey_intent WHERE id=$1', [start.intentId])).rows[0].expired,
      { timeout: 700, interval: 10 }).toBe(true)
    await stores.administrator.query('COMMIT'); transactionOpen = false
    const status = await pending; expect(status).toBe(401)
    expect(await firstPersistence(f.principal.userId) === before).toBe(true)
    expect(await unchanged(f.principal.userId) === identity).toBe(true)
    fix1Observations.push({ case: 'lock-wait-expiry', blockingObserved: true, databaseDeadlineCrossedBeforeUnlock: true, status, persistenceUnchanged: true, identityUnchanged: true })
  } finally { if (transactionOpen) await stores.administrator.query('ROLLBACK'); if (pending) await pending }
})
