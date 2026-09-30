import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import type { AuthContext } from 'better-auth'
import type { MagicInvocation } from '../../src/modules/auth/magic.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createAuthRateLimiter, readRateLimitConfig, AuthAttemptExceeded, RedisInvalid, RedisUnavailable } from '../../src/modules/auth/rate-limit.server'
import { authorizeEmailRequest, materializeDelivery, readAuthorizedEmailPayload } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse } from '../../src/modules/auth/http-boundary.server'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

const observed = vi.hoisted(() => ({ token: '', cookies: 0, fault: '',
  afterCookie: undefined as (() => Promise<void>) | undefined,
  creator: undefined as AuthContext['internalAdapter']['createSession'] | undefined,
  authority: undefined as MagicInvocation | undefined,
}))
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('better-auth/cookies', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth/cookies')>()
  return { ...actual, async setSessionCookie(...args: Parameters<typeof actual.setSessionCookie>) {
    if (observed.fault === 'cookie') throw new Error('Owned cookie failure')
    await actual.setSessionCookie(...args); observed.cookies++
    await observed.afterCookie?.()
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware, APIError } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: {
      before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
        // The outer native dispatcher requested a header envelope. This nested
        // test observer needs the underlying hook value, not a second envelope.
        const result = await before({ ...ctx, returnHeaders: false })
        if (ctx.path !== '/application/magic/consume') return result
        observed.authority = args[2]?.(ctx.request)
        observed.creator = result.context.context.internalAdapter.createSession
        if (observed.fault === 'replaced-request' && ctx.request) {
          const replacement = new Request(ctx.request.url, { method: 'POST', headers: ctx.request.headers })
          for (const key of Object.getOwnPropertySymbols(ctx.request)) {
            if (key.description === 'application magic invocation') Object.defineProperty(replacement, key, Object.getOwnPropertyDescriptor(ctx.request, key)!)
          }
          return { ...result, context: { ...result.context, request: replacement } }
        }
        if (observed.fault === 'missing-request') return { ...result, context: { ...result.context, request: new Request('https://app.example.test/auth/magic/consume', { method: 'POST' }) } }
        if (observed.fault === 'creator-override' || observed.fault === 'duplicate-creator') {
          const original = result.context.context.internalAdapter.createSession
          const createSession: typeof original = async userId => {
            if (observed.fault === 'creator-override') return original(userId, false)
            await original(userId); return original(userId)
          }
          return { context: { ...result.context, context: { ...result.context.context, internalAdapter: { ...result.context.context.internalAdapter, createSession } } } }
        }
        return result
      }) }],
      after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/application/magic/consume', handler: createAuthMiddleware(async () => {
        if (observed.fault === 'after-hook') throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Owned after-hook failure' }, { 'set-cookie': 'owned_error_cookie=unpublished' })
      }) }],
    } }
  } }
})

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let pool: Pool
let owner: ReturnType<typeof createTransactions>
let limiter: ReturnType<typeof createAuthRateLimiter>
let app: ReturnType<typeof createApplicationAuth>
const origin = 'https://app.example.test'
const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
const config = { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }
const options = () => ({ deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
let ip = 1
function request(cookie = '', address = `198.51.100.${ip++}`, body?: string) {
  const value = Object.assign(new Request(origin + '/auth/magic/consume', { method: 'POST', body, headers: { origin, cookie, 'x-real-ip': address, 'content-type': 'application/json' } }),
    { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return value
}
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
    GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
    GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
    GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
    GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
  pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'magic-boundaries', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' })); await limiter.connect()
  app = createApplicationAuth(owner, config, limiter)
})
afterEach(() => { vi.restoreAllMocks(); observed.fault = ''; observed.afterCookie = undefined; observed.token = '' })
afterAll(async () => {
  const failures: string[] = []
  for (const [name, close] of [['auth', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()]] as const) {
    try { await close() } catch { failures.push(name) }
  }
  if (stores) {
    try { await stores.cleanup() } catch { failures.push('stores') }
    finally {
      const directory = resolve('.output/test-evidence/magic-core'); await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, `boundaries-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n')
    }
  }
  if (failures.length) throw new Error('Magic boundary cleanup failed: ' + failures.join(','))
})
async function mint(bound = true, lifetimeSeconds = 600, emailVerified = true) {
  const userId = randomUUID(), email = randomUUID() + '@example.test'
  if (bound) await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified,recovery_generation) VALUES($1,$2,$3,$4,3)', [userId, 'Fixture', email, emailVerified])
  const minted = await owner.withAuthPromise(options(), async lease => {
    const command = await authorizeEmailRequest(lease, { email, purpose: 'magic-link', locale: 'en', expectedGeneration: 0,
      lifetimeSeconds, userId: bound ? userId : undefined, recoveryGeneration: bound ? 3 : undefined })
    const delivery = await materializeDelivery(lease, command.id, envelope, profile)
    if (!delivery) throw new Error('Fixture producer failed')
    return { command, delivery }
  })
  return { ...minted, userId, email, input: { token: observed.token, intendedEmail: email } }
}
async function consume(input: { token: string; intendedEmail: string }, application = app, cookie = '', address?: string) {
  const incoming = request(cookie, address, JSON.stringify(input)), body = await incoming.json()
  expect(incoming.bodyUsed).toBe(true)
  return magicConsumeResponse(incoming, body, application, limiter)
}
async function unchanged(proof: Awaited<ReturnType<typeof mint>>) {
  const { rows } = await stores.administrator.query(`SELECT r.state='active' AND d.state='active' AND d.verifier_hash IS NOT NULL AS active,
    (SELECT count(*)::int FROM session WHERE user_id=$2) AS sessions FROM auth_email_request r
    JOIN auth_email_command c ON c.request_id=r.id JOIN email_delivery d ON d.command_id=c.id WHERE c.id=$1`, [proof.command.id, proof.userId])
  expect(rows[0].active).toBe(true); expect(rows[0].sessions).toBe(0)
}
test('web materialization is idempotent under the documented exact column grants', async () => {
  const proof = await mint()
  const repeated = await owner.withAuthPromise(options(), lease => materializeDelivery(lease, proof.command.id, envelope, profile))
  expect(repeated?.id === proof.delivery.id && repeated?.outboxId === proof.delivery.outboxId).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM email_delivery WHERE command_id=$1', [proof.command.id])).rows[0].n).toBe(1)
  // Read/decrypt the real persisted projection against the canonical schema:
  // command linkage, UUIDs, key/nonce/tag/ciphertext and metadata must agree.
  const plaintext = await owner.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, proof.delivery.outboxId, envelope))
  expect(plaintext !== null).toBe(true)
  try {
    const snapshot = JSON.parse(plaintext!.toString()), body = JSON.parse(snapshot.requestJson)
    expect(snapshot.format === 'auth-plunk-v1' && snapshot.idempotencyKey === 'auth-email-delivery:' + proof.delivery.outboxId
      && body.to === proof.email && body.body.includes('#token=' + proof.input.token)).toBe(true)
  } finally { plaintext?.fill(0) }
  const defaults = (await stores.administrator.query(`SELECT d.state='active' AND d.provider_state='unattempted' AND d.provider_fence=0
    AND d.replay_window_seconds IS NULL AND d.snapshot_format='auth-plunk-v1' AND o.admission_state='pending' AND o.admission_fence=0
    AND o.run_id IS NULL AS valid FROM email_delivery d JOIN auth_email_outbox o ON o.delivery_id=d.id WHERE d.id=$1`, [proof.delivery.id])).rows[0]
  expect(defaults.valid).toBe(true)
})
// Historical noncanonical rows are now refused by the8B migration preflight;
// initial-email-migration.test.ts owns that changed boundary. Unbound commands
// now start enrollment and are covered by the8B native consumer tests.
test.each(['missing', 'malformed', 'intent', 'user-generation', 'recovering', 'request-generation', 'expired'] as const)('native proof refuses %s without publication or session', async mode => {
  const proof = await mint(true, mode === 'expired' ? 1 : 600)
  let input = proof.input
  if (mode === 'missing') input = { ...input, token: randomBytes(32).toString('base64url') }
  if (mode === 'malformed') input = { ...input, token: input.token + '=' }
  if (mode === 'intent') input = { ...input, intendedEmail: 'different@example.test' }
  if (mode === 'user-generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=4 WHERE id=$1', [proof.userId])
  if (mode === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [proof.userId])
  if (mode === 'request-generation') await stores.administrator.query('UPDATE auth_email_request SET generation=generation+1 WHERE id=$1', [proof.command.requestId])
  if (mode === 'expired') await delay(1050)
  const before = observed.cookies, response = await consume(input)
  expect(response.status).toBe(401); expect(response.headers.getSetCookie().length).toBe(0)
  expect(await response.text() === 'Authentication rejected').toBe(true); expect(observed.cookies).toBe(before)
  await unchanged(proof)
})
test('concurrent and replayed consumption yield exactly one native session', async () => {
  const proof = await mint(), applicationName = 'magic-consume-race-' + randomUUID()
  // The existing PgBouncer fixture intentionally serializes one backend. This
  // proof-race discriminant alone needs two simultaneous direct PG backends.
  const directPool = new Pool({ connectionString: stores.directRuntimeUrl, max: 2, application_name: applicationName })
  const directOwner = createTransactions(directPool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const directApp = createApplicationAuth(directOwner, config, limiter)
  let reached = () => {}, release = () => {}, firstPid: number | undefined
  const firstCookieReached = new Promise<void>(resolve => { reached = resolve })
  const holdFirst = new Promise<void>(resolve => { release = resolve })
  let cookieCalls = 0, firstSettled = false, secondSettled = false
  const evidence = { directPostgres: true, distinctBackendProofLockObserved: false, bothUnpublishedAtBarrier: false,
    firstStatus: 0, secondStatus: 0, sessionPublications: 0, nativeCookiePreparations: 0, persistedSessions: 0 }
  stores.evidence.magicConsumeConcurrency = evidence
  observed.afterCookie = async () => {
    if (++cookieCalls !== 1) return
    const [backend] = await directOwner.currentDb().select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(select 1) as magic_race_backend`)
    if (!backend || !Number.isSafeInteger(backend.pid)) throw new Error('Owned native backend observation unavailable')
    firstPid = backend.pid; reached(); await holdFirst
  }
  const first = consume(proof.input, directApp)
  void first.then(() => { firstSettled = true }, () => { firstSettled = true })
  let second: Promise<Response> | undefined
  try {
    await Promise.race([firstCookieReached, first.then(() => { throw new Error('First consume finished before its native cookie barrier') })])
    second = consume(proof.input, directApp)
    void second.then(() => { secondSettled = true }, () => { secondSettled = true })
    const deadline = performance.now() + 700
    while (!evidence.distinctBackendProofLockObserved && !secondSettled && performance.now() < deadline) {
      // Return only a Boolean: no query text, parameters, token, email, cookie
      // or backend identity enters assertion failures or the durable receipt.
      const { rows } = await stores.administrator.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity waiter JOIN pg_stat_activity blocker ON blocker.pid=$2
        WHERE waiter.application_name=$1 AND waiter.pid<>blocker.pid AND blocker.xact_start IS NOT NULL
          AND waiter.state='active' AND waiter.wait_event_type='Lock'
          AND blocker.pid=ANY(pg_blocking_pids(waiter.pid))
          AND lower(waiter.query) LIKE '%from "user"%' AND lower(waiter.query) LIKE '%for update%'
      ) AS blocked`, [applicationName, firstPid])
      evidence.distinctBackendProofLockObserved = rows[0]?.blocked === true
      if (!evidence.distinctBackendProofLockObserved && !secondSettled) await delay(10)
    }
    expect(evidence.distinctBackendProofLockObserved).toBe(true)
    evidence.bothUnpublishedAtBarrier = !firstSettled && !secondSettled
    expect(evidence.bothUnpublishedAtBarrier).toBe(true)
    release()
    const results = await Promise.all([first, second])
    evidence.firstStatus = results[0].status; evidence.secondStatus = results[1].status
    evidence.sessionPublications = results.filter(value => value.headers.getSetCookie().length > 0).length
    evidence.nativeCookiePreparations = cookieCalls
    evidence.persistedSessions = (await stores.administrator.query('SELECT count(*)::int AS n FROM session WHERE user_id=$1', [proof.userId])).rows[0].n
    expect([evidence.firstStatus, evidence.secondStatus]).toEqual([200, 401])
    expect(evidence.sessionPublications).toBe(1); expect(evidence.nativeCookiePreparations).toBe(1)
    expect(evidence.persistedSessions).toBe(1)
    expect((await consume(proof.input, directApp)).status).toBe(401)
  } finally {
    release(); observed.afterCookie = undefined
    await Promise.allSettled(second ? [first, second] : [first])
    const failures: string[] = []
    for (const [name, close] of [['direct-auth', () => directApp.close()], ['direct-pool', () => directPool.end()]] as const) {
      try { await close() } catch { failures.push(name) }
    }
    if (failures.length) throw new Error('Magic concurrent fixture cleanup failed: ' + failures.join(','))
  }
})
test('a different native ambient session is preserved and cannot redirect proof ownership', async () => {
  const prior = await mint(), response = await consume(prior.input)
  expect(response.status).toBe(200)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const target = await mint(), refused = await consume(target.input, app, cookie)
  expect(refused.status).toBe(409); expect(refused.headers.getSetCookie().length).toBe(0); await unchanged(target)
  expect((await app.readPrincipal(request(cookie)))?.userId === prior.userId).toBe(true)
})
test.each(['cookie', 'after-hook', 'replaced-request', 'missing-request', 'creator-override', 'duplicate-creator'])('native %s failure preserves proof and publishes no headers', async fault => {
  const proof = await mint(); observed.fault = fault
  const response = await consume(proof.input)
  expect(response.status >= 400).toBe(true); expect(response.headers.getSetCookie().length).toBe(0)
  await unchanged(proof)
  observed.fault = ''; expect((await consume(proof.input)).status).toBe(200)
})
test('expiry after native cookie preparation rolls back proof and session', async () => {
  const proof = await mint(true, 1), before = observed.cookies
  observed.afterCookie = async () => { await delay(1100) }
  const response = await consume(proof.input)
  expect(observed.cookies).toBe(before + 1); expect(response.status).toBe(401)
  expect(response.headers.getSetCookie().length).toBe(0); await unchanged(proof)
})
test('closed factory during native cookie preparation rolls back and publishes nothing', async () => {
  const proof = await mint(), other = createApplicationAuth(owner, config, limiter)
  observed.afterCookie = () => other.close()
  try {
    const response = await consume(proof.input, other)
    expect(response.status).toBe(500); expect(response.headers.getSetCookie().length).toBe(0); await unchanged(proof)
  } finally { await other.close() }
})
test('retained native creator and Request authority are revoked after completion', async () => {
  const proof = await mint(); expect((await consume(proof.input)).status).toBe(200)
  expect(typeof observed.creator === 'function' && !!observed.authority).toBe(true)
  const failed = await observed.creator!(proof.userId).then(() => false, () => true)
  expect(failed).toBe(true); expect(() => observed.authority!.assert()).toThrow()
  expect(Object.hasOwn(app, 'api') || Object.hasOwn(app, '$context')).toBe(false)
})
test.each([['denied', 429], ['unavailable', 503], ['invalid', 500]] as const)('named limiter %s refuses both app entries before effects', async (mode, status) => {
  const proof = await mint()
  const failure = mode === 'denied' ? new AuthAttemptExceeded(60) : mode === 'unavailable' ? new RedisUnavailable() : new RedisInvalid()
  const calls = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(failure)
  const consumeResult = await consume(proof.input)
  expect(consumeResult.status).toBe(status); expect(consumeResult.headers.getSetCookie().length).toBe(0); await unchanged(proof)
  const before = (await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command')).rows[0].n
  const rejected = await app.requestMagicLink(request(), { email: proof.email, locale: 'en' }).then(() => false, error => limiter.errorResponse(error)?.status === status)
  expect(rejected).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command')).rows[0].n).toBe(before)
  expect(calls.mock.calls.map(call => call[0])).toEqual(['consumeMagicLink', 'requestMagicLink'])
})
test('real request entries give identical acknowledgements and last-generation authority without creating users', async () => {
  const proof = await mint(), missingEmail = randomUUID() + '@example.test'
  const users = (await stores.administrator.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n
  const calls = vi.spyOn(limiter, 'consumeAuthAttempt')
  const bound = await app.requestMagicLink(request(), { email: proof.email, locale: 'fr' }), latest = observed.token
  const absent = await app.requestMagicLink(request(), { email: missingEmail, locale: 'en' })
  expect(JSON.stringify(bound) === '{"accepted":true}' && JSON.stringify(absent) === '{"accepted":true}').toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n).toBe(users)
  expect((await consume(proof.input)).status).toBe(401)
  expect((await consume({ token: latest, intendedEmail: proof.email })).status).toBe(200)
  expect(calls.mock.calls.map(call => call[0])).toEqual(['requestMagicLink', 'requestMagicLink', 'consumeMagicLink', 'consumeMagicLink'])
})
test('native verified update and session fields remain private and create no OAuth account', async () => {
  const proof = await mint(true, 600, false), response = await consume(proof.input)
  expect(response.status).toBe(200); expect(await response.text() === '{"authenticated":true}').toBe(true)
  const row = (await stores.administrator.query(`SELECT u.email_verified,s.auth_state,s.auth_method,s.provider_identity IS NULL AS no_provider,
    s.recovery_generation,(SELECT count(*)::int FROM account WHERE user_id=u.id) AS accounts
    FROM "user" u JOIN session s ON s.user_id=u.id WHERE u.id=$1`, [proof.userId])).rows[0]
  expect(row.email_verified && row.auth_state === 'ACTIVE' && row.auth_method === 'magic-link' && row.no_provider && row.recovery_generation === 3 && row.accounts === 0).toBe(true)
})
test('post-confirmed-commit invocation failure burns proof but publishes no cookie or success', async () => {
  const proof = await mint(), original = owner.runAuthInvocation
  vi.spyOn(owner, 'runAuthInvocation').mockImplementation(async (options, call) => {
    await original(options, call)
    throw new Error('Owned failure after confirmed commit')
  })
  const before = observed.cookies, response = await consume(proof.input)
  expect(response.status).toBe(500); expect(response.headers.getSetCookie().length).toBe(0); expect(observed.cookies).toBe(before + 1)
  const row = (await stores.administrator.query(`SELECT r.state='consumed' AND d.verifier_hash IS NULL AS retired,
    (SELECT count(*)::int FROM session WHERE user_id=$2) AS sessions FROM auth_email_request r JOIN auth_email_command c ON c.request_id=r.id
    JOIN email_delivery d ON d.command_id=c.id WHERE c.id=$1`, [proof.command.id, proof.userId])).rows[0]
  expect(row.retired).toBe(true); expect(row.sessions).toBe(1)
})
test('a foreign owner cannot resume the active native magic invocation', async () => {
  const proof = await mint(), foreign = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  observed.afterCookie = () => foreign.withAuthPromise(owner.invocationOptions(), async () => { observed.authority!.assert() })
  const before = observed.cookies, response = await consume(proof.input)
  expect(observed.cookies).toBe(before + 1); expect(response.status).toBe(500)
  expect(response.headers.getSetCookie().length).toBe(0); await unchanged(proof)
})
test('a second root of the same owner enters and rejects the active magic cell on a different lease', async () => {
  const proof = await mint()
  // The normal fixture PgBouncer intentionally admits one backend. Only this
  // simultaneous-two-lease test uses its existing direct runtime endpoint.
  const directPool = new Pool({ connectionString: stores.directRuntimeUrl, max: 2 })
  const sameOwner = createTransactions(directPool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const directApp = createApplicationAuth(sameOwner, config, limiter)
  let reached = () => {}, release = () => {}
  const cookieReached = new Promise<void>(resolve => { reached = resolve })
  const holdCookie = new Promise<void>(resolve => { release = resolve })
  let firstDb: ReturnType<typeof owner.currentDb> | undefined
  observed.afterCookie = async () => { firstDb = sameOwner.currentDb(); reached(); await holdCookie }
  const pending = consume(proof.input, directApp)
  let response: Response
  try {
    await Promise.race([cookieReached, pending.then(() => { throw new Error('Native consume finished before the cookie barrier') })])
    const authority = observed.authority
    expect(!!authority && !!firstDb).toBe(true)
    // This continuation is rooted in the external test context, while the
    // original invocation remains suspended in its first physical lease.
    await sameOwner.withAuthPromise(options(), async lease => {
      expect(lease.db !== firstDb && sameOwner.currentDb() === lease.db).toBe(true)
      let entered = false, refused = false
      try { entered = true; authority!.assert() } catch { refused = true }
      expect(entered && refused).toBe(true)
    })
  } finally {
    release(); observed.afterCookie = undefined
    try { response = await pending } finally { await directApp.close(); await directPool.end() }
  }
  expect(response.status).toBe(200)
  expect(response.headers.getSetCookie().some(value => value.includes('session_token='))).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session WHERE user_id=$1', [proof.userId])).rows[0].n).toBe(1)
})
test('expiry while waiting for the bound User lock is checked with the post-lock database clock', async () => {
  const proof = await mint(true, 1)
  await stores.administrator.query('BEGIN')
  try {
    await stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [proof.userId])
    await delay(650)
    const pending = consume(proof.input)
    await delay(450)
    await stores.administrator.query('COMMIT')
    const response = await pending
    expect(response.status).toBe(401); expect(response.headers.getSetCookie().length).toBe(0); await unchanged(proof)
  } finally { await stores.administrator.query('ROLLBACK') }
})
test('received proof remains usable when provider outcome is unknown, preserving provider history', async () => {
  const proof = await mint()
  // The fixture administrator emulates the existing worker-owned outcome.
  await stores.administrator.query('BEGIN; SET LOCAL ROLE auth_mail_definer')
  try {
    await stores.administrator.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
    await stores.administrator.query("UPDATE email_delivery SET provider_state='effect_unknown',provider_fence=1,first_attempt_at=clock_timestamp() WHERE id=$1", [proof.delivery.id])
    await stores.administrator.query('COMMIT')
  } catch { await stores.administrator.query('ROLLBACK'); throw new Error('Owned provider-state fixture rejected') }
  expect((await consume(proof.input)).status).toBe(200)
  const row = (await stores.administrator.query('SELECT provider_state,provider_fence,first_attempt_at IS NOT NULL AS attempted FROM email_delivery WHERE id=$1', [proof.delivery.id])).rows[0]
  expect(row.provider_state === 'effect_unknown' && row.provider_fence === 1 && row.attempted).toBe(true)
})
test('real named request and consume limiters allow five attempts then refuse the sixth without effects', async () => {
  const proof = await mint(), requestIp = '203.0.113.111', consumeIp = '203.0.113.112'
  for (let index = 0; index < 5; index++) {
    expect((await app.requestMagicLink(request('', requestIp), { email: proof.email, locale: 'en' })).accepted).toBe(true)
    expect((await consume({ ...proof.input, token: randomBytes(32).toString('base64url') }, app, '', consumeIp)).status).toBe(401)
  }
  const before = (await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command')).rows[0].n
  const deniedRequest = await app.requestMagicLink(request('', requestIp), { email: proof.email, locale: 'en' }).then(() => false, error => limiter.errorResponse(error)?.status === 429)
  expect(deniedRequest).toBe(true)
  expect((await consume(proof.input, app, '', consumeIp)).status).toBe(429)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command')).rows[0].n).toBe(before)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session WHERE user_id=$1', [proof.userId])).rows[0].n).toBe(0)
})
test('untrusted ingress and posted authority fields cannot bypass limiter or proof validation', async () => {
  const proof = await mint(), incoming = request()
  Reflect.deleteProperty(incoming, 'runtime')
  expect((await magicConsumeResponse(incoming, proof.input, app, limiter)).status).toBe(500)
  const extra = { ...proof.input, userId: proof.userId, recoveryGeneration: 3, purpose: 'magic-link' }
  expect((await consume(extra)).status).toBe(401)
  await unchanged(proof)
})
