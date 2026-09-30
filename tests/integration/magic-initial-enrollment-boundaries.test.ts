import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { betterAuth, type AuthContext, type BetterAuthOptions } from 'better-auth'
import { createAuthAdapter } from '../../src/modules/auth/adapter.server'
import { authSchemaOptions } from '../../src/modules/auth/schema-options.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig, AuthAttemptExceeded, RedisUnavailable, RedisInvalid } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { authorizeEmailRequest, materializeDelivery } from '../../src/modules/auth/auth-email-store.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import type { InitialEnrollmentInvocation } from '../../src/modules/auth/initial-enrollment.server'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { registrationCeremony } from '../helpers/registration-ceremony'

const observed = vi.hoisted(() => ({ token: '', uv: [] as boolean[], fault: '', prepared: 0,
  afterCookie: undefined as (() => Promise<void>) | undefined,
  authority: undefined as InitialEnrollmentInvocation | undefined,
  creator: undefined as AuthContext['internalAdapter']['createSession'] | undefined,
}))
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('@better-auth/passkey', async importOriginal => {
  const actual = await importOriginal<typeof import('@better-auth/passkey')>()
  return { ...actual, passkey(options: Parameters<typeof actual.passkey>[0]) {
    const after = options?.registration?.afterVerification
    return actual.passkey({ ...options, registration: { ...options?.registration, afterVerification: async args => {
      observed.uv.push(args.verification.registrationInfo?.userVerified === true)
      return after?.(args)
    } } })
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware, APIError } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: {
      before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
        const result = await before({ ...ctx, returnHeaders: false })
        if (ctx.path !== '/passkey/verify-registration') return result
        observed.authority = args[3]?.(ctx.request)
        const original = result.context.context.internalAdapter.createSession
        observed.creator = original
        if (observed.fault === 'wrong-operation') observed.authority!.assert('options', ctx.request)
        if (observed.fault === 'wrong-request') observed.authority!.assert('complete', new Request(ctx.request!.url))
        if (observed.fault === 'creator-shape') {
          const createSession: typeof original = async userId => original(userId, undefined, undefined, undefined, { deferSecondaryStorageWrites: false })
          return { ...result, context: { ...result.context, context: { ...result.context.context,
            internalAdapter: { ...result.context.context.internalAdapter, createSession } } } }
        }
        if (observed.fault === 'cookie') return { ...result, context: { ...result.context, context: { ...result.context.context,
          setNewSession: () => { throw new Error('Owned native cookie preparation failure') } } } }
        return result
      }) }],
      after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/passkey/verify-registration', handler: createAuthMiddleware(async ctx => {
        if (ctx.context.responseHeaders?.getSetCookie().some(value => value.startsWith('__Secure-better-auth.session_token='))) {
          observed.prepared++; await observed.afterCookie?.()
        }
        if (observed.fault === 'after-hook') throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Owned native after-hook failure' }, { 'set-cookie': 'owned_error_cookie=unpublished' })
      }) }],
    } }
  } }
})

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let owner: ReturnType<typeof createTransactions>, app: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
const origin = 'https://app.example.test'
const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
const config = { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }
const invocation = () => ({ deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
let ip = 1
function request(path = '/auth/magic/enroll', cookie = '', address = `198.51.100.${ip++}`, body?: unknown) {
  const incoming = Object.assign(new Request(origin + path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin, cookie, 'x-real-ip': address, 'content-type': 'application/json' } }),
    { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return incoming
}
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.passkey TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
    GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
    GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
    GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
    GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 4, application_name: 'initial-enrollment-boundaries' })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'initial-boundaries', TRUSTED_PROXY_IPS: '127.0.0.1' })); await limiter.connect()
  app = createApplicationAuth(owner, config, limiter)
})
afterEach(() => { observed.token = ''; observed.fault = ''; observed.afterCookie = undefined; vi.restoreAllMocks() })
afterAll(async () => {
  const failures: string[] = []
  for (const [name, close] of [['auth', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()]] as const) {
    try { await close() } catch { failures.push(name) }
  }
  if (stores) {
    try { await stores.cleanup() } catch { failures.push('stores') }
    finally { const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-8b-evidence'); await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `boundaries-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n') }
  }
  if (failures.length) throw new Error('Initial enrollment cleanup failed: ' + failures.join(','))
})
async function mint(lifetimeSeconds = 600) {
  const email = randomUUID() + '@example.test'
  const command = await owner.withAuthPromise(invocation(), async lease => {
    const command = await authorizeEmailRequest(lease, { email, locale: 'en', purpose: 'magic-link', expectedGeneration: 0, lifetimeSeconds })
    await materializeDelivery(lease, command.id, envelope, profile); return command
  })
  return { command, input: { token: observed.token, intendedEmail: email } }
}
async function begin(proof: Awaited<ReturnType<typeof mint>>, cookie = '') {
  const incoming = request('/auth/magic/consume', cookie, undefined, proof.input)
  const result = await magicConsumeResponse(incoming, await incoming.json(), app, limiter)
  expect(result.status).toBe(200)
  const body = await result.json(); expect(body.enrollmentRequired === true && body.authenticated === undefined).toBe(true)
  return { options: body.options, cookie: cookies(result) }
}
async function complete(proof: Awaited<ReturnType<typeof mint>>, started: Awaited<ReturnType<typeof begin>>, response = registrationCeremony(started.options, origin), address?: string) {
  const incoming = request('/auth/magic/enroll', started.cookie, address, { ...proof.input, response })
  return magicEnrollmentResponse(incoming, await incoming.json(), app, limiter)
}
async function noIdentity(proof: Awaited<ReturnType<typeof mint>>) {
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [proof.input.intendedEmail])).rows[0].n).toBe(0)
  expect((await stores.administrator.query('SELECT state FROM auth_email_request WHERE id=$1', [proof.command.requestId])).rows[0].state).toBe('active')
  expect((await stores.administrator.query('SELECT verifier_hash IS NOT NULL AS usable FROM email_delivery WHERE command_id=$1', [proof.command.id])).rows[0].usable).toBe(true)
}
// 8C error classification only; actual browser signup has its own compiled test.
test.each([
  ['malformed-input', 401], ['malformed-response', 500], ['wrong-challenge', 500], ['wrong-origin', 500],
  ['uv-false', 401], ['operational-failure', 500], ['rate-limited', 429], ['limiter-unavailable', 503],
] as const)('8c exact initial-enrollment status %s', async (mode, expected) => {
  const proof = await mint(), started = await begin(proof)
  let response: unknown = registrationCeremony(started.options, origin, mode !== 'uv-false')
  if (mode === 'malformed-response') response = null
  if (mode === 'wrong-challenge') response = registrationCeremony({ ...started.options, challenge: randomBytes(32).toString('base64url') }, origin)
  if (mode === 'wrong-origin') response = registrationCeremony(started.options, 'https://wrong.example.test')
  if (mode === 'operational-failure') observed.fault = 'after-hook'
  if (mode === 'rate-limited') vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValueOnce(new AuthAttemptExceeded(60))
  if (mode === 'limiter-unavailable') vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValueOnce(new RedisUnavailable())
  const input = mode === 'malformed-input' ? { intendedEmail: proof.input.intendedEmail, response } : { ...proof.input, response }
  const incoming = request('/auth/magic/enroll', started.cookie, undefined, input)
  const result = await magicEnrollmentResponse(incoming, await incoming.json(), app, limiter)
  expect(result.status).toBe(expected)
  expect(result.headers.getSetCookie().length).toBe(0)
  expect(['Authentication rejected', 'Internal Server Error', 'Too Many Requests', 'Service Unavailable'].includes(await result.text())).toBe(true)
  await noIdentity(proof)
  expect((await stores.administrator.query('SELECT (SELECT count(*) FROM session)::int AS sessions,(SELECT count(*) FROM passkey)::int AS keys')).rows[0]).toEqual({ sessions: 0, keys: 0 })
})

test.each(['absent-cookie', 'wrong-cookie', 'wrong-challenge', 'wrong-origin', 'wrong-rpid', 'wrong-signature', 'uv-false', 'wrong-token', 'wrong-intent',
  'context-command', 'context-generation', 'context-user', 'wrong-ceremony', 'request-generation', 'challenge-expired'] as const)('initial ceremony refuses %s without identity or proof retirement', async mode => {
  const proof = await mint(), started = await begin(proof)
  let response = registrationCeremony(started.options, origin, mode !== 'uv-false')
  const uvCount = observed.uv.length
  if (mode === 'absent-cookie') started.cookie = ''
  if (mode === 'wrong-cookie') started.cookie = '__Secure-better-auth.better-auth-passkey=invalid'
  if (mode === 'wrong-challenge') response = registrationCeremony({ ...started.options, challenge: randomBytes(32).toString('base64url') }, origin)
  if (mode === 'wrong-origin') response = registrationCeremony(started.options, 'https://wrong.example.test')
  if (mode === 'wrong-rpid') response = registrationCeremony({ ...started.options, rp: { id: 'wrong.example.test' } }, origin)
  if (mode === 'wrong-signature') {
    const bytes = Buffer.from(response.response.attestationObject, 'base64url'); bytes[bytes.length - 1] ^= 1
    response.response.attestationObject = bytes.toString('base64url')
  }
  if (mode === 'wrong-token') proof.input.token = randomBytes(32).toString('base64url')
  if (mode === 'wrong-intent') proof.input.intendedEmail = 'other@example.test'
  if (mode === 'request-generation') await stores.administrator.query('UPDATE auth_email_request SET generation=generation+1 WHERE id=$1', [proof.command.requestId])
  if (mode === 'wrong-ceremony') await stores.administrator.query(`UPDATE verification SET value=jsonb_set(value::jsonb,'{type}','"authentication"')::text
    WHERE value::jsonb->>'context'=$1`, [JSON.stringify({ commandId: proof.command.id, generation: 1 })])
  if (mode.startsWith('context-')) {
    const field = mode === 'context-command' ? 'commandId' : 'generation'
    if (mode === 'context-user') await stores.administrator.query(`UPDATE verification SET value=jsonb_set(value::jsonb,'{userData,id}','"wrong"')::text WHERE value::jsonb->>'context'=$1`, [JSON.stringify({ commandId: proof.command.id, generation: 1 })])
    else await stores.administrator.query(`UPDATE verification SET value=jsonb_set(value::jsonb,'{context}',to_jsonb($2::text))::text WHERE value::jsonb->>'context'=$1`,
      [JSON.stringify({ commandId: proof.command.id, generation: 1 }), JSON.stringify({ commandId: proof.command.id, generation: 1, [field]: field === 'commandId' ? randomUUID() : 2 })])
  }
  if (mode === 'challenge-expired') await stores.administrator.query(`UPDATE verification SET expires_at=clock_timestamp()-interval '1 second' WHERE value::jsonb->>'context'=$1`, [JSON.stringify({ commandId: proof.command.id, generation: 1 })])
  const result = await complete(proof, started, response)
  expect(result.status >= 400).toBe(true); expect(result.headers.getSetCookie().length).toBe(0)
  if (mode === 'uv-false') expect(observed.uv.length === uvCount + 1 && observed.uv.at(-1) === false).toBe(true)
  proof.input.intendedEmail = proof.command.recipient
  await noIdentity(proof)
})
test('stored references alone never substitute for the original token at final completion', async () => {
  const proof = await mint(), started = await begin(proof)
  const stored = (await stores.administrator.query(`SELECT value FROM verification WHERE value::jsonb->>'context'=$1`,
    [JSON.stringify({ commandId: proof.command.id, generation: 1 })])).rows[0].value
  const value = JSON.parse(stored)
  expect(value.context === JSON.stringify({ commandId: proof.command.id, generation: 1 }) && !stored.includes(proof.input.token)).toBe(true)
  const response = registrationCeremony(started.options, origin)
  const missing = await magicEnrollmentResponse(request('/auth/magic/enroll', started.cookie), { intendedEmail: proof.input.intendedEmail,
    commandId: proof.command.id, generation: 1, response }, app, limiter)
  expect(missing.status).toBe(401); expect(missing.headers.getSetCookie().length).toBe(0); await noIdentity(proof)
  expect((await complete(proof, started, response)).status).toBe(200)
})
test('native challenge expires no later than the original magic proof and does not renew it', async () => {
  const proof = await mint(1), started = await begin(proof)
  const row = (await stores.administrator.query(`SELECT expires_at<=$2 AS bounded FROM verification WHERE value::jsonb->>'context'=$1`,
    [JSON.stringify({ commandId: proof.command.id, generation: 1 }), proof.command.expiresAt])).rows[0]
  expect(row.bounded).toBe(true)
  await delay(1050)
  const result = await complete(proof, started)
  expect(result.status >= 400).toBe(true); expect(result.headers.getSetCookie().length).toBe(0); await noIdentity(proof)
})
test.each(['cookie', 'after-hook', 'wrong-request', 'wrong-operation', 'creator-shape'])('native %s fault rolls back both authorities before retry', async fault => {
  const proof = await mint(), started = await begin(proof), response = registrationCeremony(started.options, origin)
  observed.fault = fault
  const rejected = await complete(proof, started, response)
  expect(rejected.status >= 400).toBe(true); expect(rejected.headers.getSetCookie().length).toBe(0); await noIdentity(proof)
  observed.fault = ''
  expect((await complete(proof, started, response)).status).toBe(200)
})
test('an ambient native session refuses both initial phases before challenge effects', async () => {
  const prior = await mint(), priorStart = await begin(prior), admitted = await complete(prior, priorStart), cookie = cookies(admitted)
  expect(admitted.status).toBe(200)
  const proof = await mint(), started = await begin(proof)
  const count = (await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n
  const initial = await magicConsumeResponse(request('/auth/magic/consume', cookie), proof.input, app, limiter)
  const final = await complete(proof, { ...started, cookie })
  expect(initial.status).toBe(409); expect(final.status).toBe(409)
  expect(initial.headers.getSetCookie().length + final.headers.getSetCookie().length).toBe(0)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n).toBe(count)
  await noIdentity(proof)
})
test.each([['denied', 429], ['unavailable', 503], ['invalid', 500]] as const)('final named limiter %s refuses malformed and valid inputs before effects', async (mode, status) => {
  const proof = await mint(), started = await begin(proof)
  const fault = mode === 'denied' ? new AuthAttemptExceeded(60) : mode === 'unavailable' ? new RedisUnavailable() : new RedisInvalid()
  const spy = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(fault)
  expect((await complete(proof, started)).status).toBe(status)
  expect((await magicEnrollmentResponse(request(), undefined, app, limiter)).status).toBe(status)
  expect(spy.mock.calls.map(call => call[0])).toEqual(['completeMagicEnrollment', 'completeMagicEnrollment']); await noIdentity(proof)
})
test('five malformed final entries are charged then the sixth is refused without checkout effects', async () => {
  const address = '203.0.113.84', before = (await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n
  for (let index = 0; index < 5; index++) expect((await magicEnrollmentResponse(request(undefined, '', address), {}, app, limiter)).status).toBe(401)
  expect((await magicEnrollmentResponse(request(undefined, '', address), {}, app, limiter)).status).toBe(429)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n).toBe(before)
})
test('each successful external enrollment phase is charged once without native HTTP limiter delegation', async () => {
  const proof = await mint()
  const entries = vi.spyOn(limiter, 'consumeAuthAttempt'), nativeHttp = vi.spyOn(limiter.customStorage, 'consume')
  const started = await begin(proof), result = await complete(proof, started)
  expect(result.status).toBe(200)
  expect(entries.mock.calls.map(call => call[0])).toEqual(['consumeMagicLink', 'completeMagicEnrollment'])
  expect(nativeHttp.mock.calls.length).toBe(0)
})

test('a later native first User claims the canonical mailbox without retargeting the original proof', async () => {
  const proof = await mint(), started = await begin(proof)
  // Native createOAuthUser is the existing Google first-User path; no OAuth
  // network/account login is simulated or claimed by this storage qualification.
  const native = betterAuth({ ...authSchemaOptions, baseURL: origin, secret: 'fixture-native-creation-secret-at-least-thirty-two-characters', logger: { disabled: true },
    database: (options: BetterAuthOptions) => createAuthAdapter(owner, options) })
  const context = await native.$context
  const created = await owner.runAuthInvocation(invocation(), () => context.internalAdapter.createOAuthUser(
    { email: ' \uFEFF' + proof.input.intendedEmail.toUpperCase() + '\t ', name: 'Native creator', emailVerified: true },
    { providerId: 'google', accountId: randomUUID() }))
  expect(created.user.email === proof.command.recipient).toBe(true)
  const result = await complete(proof, started)
  expect(result.status).toBe(401); expect(result.headers.getSetCookie().length).toBe(0)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM passkey WHERE user_id=$1', [created.user.id])).rows[0].n).toBe(0)
  expect((await stores.administrator.query('SELECT user_id IS NULL AS unbound FROM auth_email_command WHERE id=$1', [proof.command.id])).rows[0].unbound).toBe(true)
})

test.each(['second-enrollment', 'native-oauth-creation'] as const)('two physical backends contend on canonical User creation against %s', async competitor => {
  const proof = await mint(), firstStart = await begin(proof), secondStart = await begin(proof)
  let release = () => {}, reached = () => {}, firstPid: number | undefined
  const barrier = new Promise<void>(resolve => { reached = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  let firstSettled = false, secondSettled = false, calls = 0
  observed.afterCookie = async () => {
    if (++calls !== 1) return
    const [backend] = await owner.currentDb().select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(select 1) as enrollment_backend`)
    firstPid = backend.pid; reached(); await hold
  }
  const first = complete(proof, firstStart)
  void first.then(() => { firstSettled = true }, () => { firstSettled = true })
  let second: Promise<boolean> | undefined
  const receipt = { competitor, directPostgres: true, distinctBackendUserInsertLock: false, bothUnpublishedAtBarrier: false, winner: false, loser: false }
  try {
    await Promise.race([barrier, first.then(() => { throw new Error('Enrollment completed before native cookie barrier') })])
    if (competitor === 'second-enrollment') second = complete(proof, secondStart).then(response => response.status >= 400 && response.headers.getSetCookie().length === 0)
    else {
      const native = betterAuth({ ...authSchemaOptions, baseURL: origin, secret: 'fixture-native-creation-secret-at-least-thirty-two-characters', logger: { disabled: true }, database: (options: BetterAuthOptions) => createAuthAdapter(owner, options) })
      const context = await native.$context
      second = owner.runAuthInvocation(invocation(), () => context.internalAdapter.createOAuthUser(
        { email: ' ' + proof.input.intendedEmail.toUpperCase() + '\t', name: 'Competing native creator', emailVerified: true },
        { providerId: 'google', accountId: randomUUID() })).then(() => false, () => true)
    }
    void second.then(() => { secondSettled = true }, () => { secondSettled = true })
    const expires = performance.now() + 700
    while (!receipt.distinctBackendUserInsertLock && !secondSettled && performance.now() < expires) {
      receipt.distinctBackendUserInsertLock = (await stores.administrator.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity waiter JOIN pg_stat_activity blocker ON blocker.pid=$1
        WHERE waiter.application_name='initial-enrollment-boundaries' AND waiter.pid<>blocker.pid
          AND blocker.xact_start IS NOT NULL AND waiter.state='active' AND waiter.wait_event_type='Lock'
          AND blocker.pid=ANY(pg_blocking_pids(waiter.pid)) AND lower(waiter.query) LIKE '%insert into "user"%'
      ) AS blocked`, [firstPid])).rows[0].blocked === true
      if (!receipt.distinctBackendUserInsertLock) await delay(10)
    }
    expect(receipt.distinctBackendUserInsertLock).toBe(true)
    receipt.bothUnpublishedAtBarrier = !firstSettled && !secondSettled; expect(receipt.bothUnpublishedAtBarrier).toBe(true)
    release()
    const result = await first; receipt.winner = result.status === 200 && result.headers.getSetCookie().length > 0; receipt.loser = await second
    expect(receipt.winner && receipt.loser).toBe(true)
    const count = (await stores.administrator.query(`SELECT count(*)::int AS n FROM "user" u JOIN passkey p ON p.user_id=u.id
      JOIN session s ON s.user_id=u.id WHERE u.email=$1`, [proof.input.intendedEmail])).rows[0].n
    expect(count).toBe(1)
    expect((await complete(proof, secondStart)).status).toBe(401)
  } finally {
    release(); observed.afterCookie = undefined
    await Promise.allSettled(second ? [first, second] : [first])
    stores.evidence['initialRace-' + competitor] = receipt
  }
})
test.each(['token', 'challenge'] as const)('terminal issuance rechecks %s expiry after native cookie preparation', async clock => {
  const proof = await mint(clock === 'token' ? 1 : 600), started = await begin(proof)
  if (clock === 'challenge') await stores.administrator.query(`UPDATE verification SET expires_at=clock_timestamp()+interval '1 second'
    WHERE value::jsonb->>'context'=$1`, [JSON.stringify({ commandId: proof.command.id, generation: 1 })])
  const before = observed.prepared
  observed.afterCookie = () => delay(1100)
  const response = await complete(proof, started)
  expect(observed.prepared).toBe(before + 1)
  expect(response.status).toBe(401); expect(response.headers.getSetCookie().length).toBe(0); await noIdentity(proof)
})
test('expiry after blocking Request lock rolls back provisional native User and challenge consume', async () => {
  const proof = await mint(1), started = await begin(proof)
  let pending: Promise<Response> | undefined
  await stores.administrator.query('BEGIN')
  try {
    await stores.administrator.query('SELECT id FROM auth_email_request WHERE id=$1 FOR UPDATE', [proof.command.requestId])
    await delay(650)
    pending = complete(proof, started)
    await delay(450)
    await stores.administrator.query('COMMIT')
    const response = await pending
    expect(response.status >= 400).toBe(true); expect(response.headers.getSetCookie().length).toBe(0); await noIdentity(proof)
  } finally { await stores.administrator.query('ROLLBACK'); await pending }
})
test('retained bootstrap creator and authority cannot be reused after invocation', async () => {
  const proof = await mint(), started = await begin(proof)
  expect((await complete(proof, started)).status).toBe(200)
  expect(!!observed.creator && !!observed.authority).toBe(true)
  expect(await observed.creator!('forged', undefined, undefined, undefined, { deferSecondaryStorageWrites: true }).then(() => false, () => true)).toBe(true)
  expect(() => observed.authority!.assert('complete')).toThrow()
  expect(Object.hasOwn(app, 'api') || Object.hasOwn(app, '$context')).toBe(false)
})
test('a second physical lease of the same owner cannot use the active enrollment cell', async () => {
  const proof = await mint(), started = await begin(proof)
  let reached = () => {}, release = () => {}, originalDb: ReturnType<typeof owner.currentDb> | undefined
  const barrier = new Promise<void>(resolve => { reached = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  observed.afterCookie = async () => { originalDb = owner.currentDb(); reached(); await hold }
  const pending = complete(proof, started)
  try {
    await Promise.race([barrier, pending.then(() => { throw new Error('Enrollment completed before native cookie barrier') })])
    await owner.withAuthPromise(invocation(), async lease => {
      expect(lease.db !== originalDb).toBe(true)
      expect(() => observed.authority!.assert('complete')).toThrow()
    })
  } finally { release(); observed.afterCookie = undefined; expect((await pending).status).toBe(200) }
})
test('foreign owner cannot use the active enrollment cell', async () => {
  const proof = await mint(), started = await begin(proof), foreign = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  observed.afterCookie = () => foreign.withAuthPromise(invocation(), async () => { observed.authority!.assert('complete') })
  const result = await complete(proof, started)
  expect(result.status).toBe(500); expect(result.headers.getSetCookie().length).toBe(0); await noIdentity(proof)
})
test('post-confirmed-commit invocation failure publishes nothing and does not recreate either proof', async () => {
  const proof = await mint(), started = await begin(proof), original = owner.runAuthInvocation
  vi.spyOn(owner, 'runAuthInvocation').mockImplementation(async (options, call) => {
    await original(options, call); throw new Error('Owned failure after commit')
  })
  const result = await complete(proof, started)
  expect(result.status).toBe(500); expect(result.headers.getSetCookie().length).toBe(0)
  const stored = (await stores.administrator.query(`SELECT (SELECT count(*)::int FROM session s JOIN "user" u ON s.user_id=u.id WHERE u.email=$1) AS sessions,
    state='consumed' AS consumed FROM auth_email_request WHERE id=$2`, [proof.input.intendedEmail, proof.command.requestId])).rows[0]
  expect(stored.sessions === 1 && stored.consumed).toBe(true)
})
