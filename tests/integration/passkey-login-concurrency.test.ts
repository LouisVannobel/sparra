import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import type { AuthContext } from 'better-auth'
import type { PasskeyLoginInvocation } from '../../src/modules/auth/passkey-login.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { pgRelay } from '../fixtures/db/pg-relay'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'

const observed = vi.hoisted(() => ({
  token: '', mode: '' as '' | 'race' | 'hold' | 'foreign-lease' | 'wrong-operation' | 'wrong-request' | 'creator-shape' | 'cookie' | 'after-hook' | 'duplicate',
  entered: 0, held: false,
  raceBarrier: Promise.resolve(), releaseRace: () => {}, bothEntered: Promise.resolve(), markBothEntered: () => {},
  holdBarrier: Promise.resolve(), releaseHold: () => {}, holdEntered: Promise.resolve(), markHoldEntered: () => {},
  authority: undefined as PasskeyLoginInvocation | undefined,
  creator: undefined as AuthContext['internalAdapter']['createSession'] | undefined,
  createdUserId: '', verifiedHooks: 0,
  authorityBarrier: Promise.resolve(), releaseAuthority: () => {}, authorityEntered: Promise.resolve(), markAuthorityEntered: () => {},
  shortExpiryMs: 0, afterDelayMs: 0, afterHookReached: 0, afterCookieSessions: 0,
}))
vi.mock('@better-auth/passkey', async importOriginal => {
  const actual = await importOriginal<typeof import('@better-auth/passkey')>()
  return { ...actual, passkey(options: Parameters<typeof actual.passkey>[0]) {
    const afterVerification = options?.authentication?.afterVerification
    return actual.passkey({ ...options, authentication: { ...options?.authentication, afterVerification: async args => {
      observed.verifiedHooks++
      return afterVerification?.(args)
    } } })
  } }
})
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { APIError, createAuthMiddleware } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
      const result = await before({ ...ctx, returnHeaders: false })
      if (ctx.path === '/passkey/generate-authenticate-options' && observed.shortExpiryMs > 0) {
        const originalCreateVerification = result.context.context.internalAdapter.createVerificationValue
        const createVerificationValue: typeof originalCreateVerification = data => originalCreateVerification({
          ...data, expiresAt: new Date(Date.now() + observed.shortExpiryMs),
        })
        return { ...result, context: { ...result.context, context: { ...result.context.context,
          internalAdapter: { ...result.context.context.internalAdapter, createVerificationValue } } } }
      }
      if (ctx.path !== '/passkey/verify-authentication') return result
      observed.authority = args[4]?.(ctx.request)
      observed.creator = result.context.context.internalAdapter.createSession
      if (observed.mode === 'foreign-lease') { observed.markAuthorityEntered(); await observed.authorityBarrier }
      if (observed.mode === 'wrong-operation') observed.authority!.assert('options', ctx.request)
      if (observed.mode === 'wrong-request') observed.authority!.assert('complete', new Request(ctx.request!.url))
      const originalConsume = result.context.context.internalAdapter.consumeVerificationValue
      const consumeVerificationValue: typeof originalConsume = async identifier => {
        if (observed.mode === 'race') {
          observed.entered++
          if (observed.entered === 2) observed.markBothEntered()
          await observed.raceBarrier
        } else if (observed.mode === 'hold' && !observed.held) {
          observed.held = true; observed.markHoldEntered(); await observed.holdBarrier
        }
        return originalConsume(identifier)
      }
      const originalCreate = result.context.context.internalAdapter.createSession
      const createSession: typeof originalCreate = observed.mode === 'creator-shape'
        ? async userId => originalCreate(userId, undefined, undefined, undefined, { deferSecondaryStorageWrites: false })
        : async (...values) => { observed.createdUserId = values[0]; return originalCreate(...values) }
      const context = observed.mode === 'cookie' ? { ...result.context.context,
        setNewSession: () => { throw new Error('Owned passkey cookie preparation failure') } } : result.context.context
      return { ...result, context: { ...result.context, context: { ...context,
        internalAdapter: { ...context.internalAdapter, consumeVerificationValue, createSession } } } }
    }) }], after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/passkey/verify-authentication',
      handler: createAuthMiddleware(async ctx => {
        if (observed.afterDelayMs > 0) {
          observed.afterHookReached++
          if (ctx.context.responseHeaders?.getSetCookie().some(value => value.startsWith('__Secure-better-auth.session_token='))) observed.afterCookieSessions++
          await new Promise(resolve => setTimeout(resolve, observed.afterDelayMs))
        }
        if (observed.mode === 'duplicate') await observed.creator?.(observed.createdUserId)
        if (observed.mode === 'after-hook') throw new APIError('INTERNAL_SERVER_ERROR',
          { message: 'Owned passkey after-hook failure' }, { 'set-cookie': 'owned_error_cookie=unpublished' })
      }) }] } }
  } }
})

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
let stores: Awaited<ReturnType<typeof startDisposableStores>>, poolA: Pool, poolB: Pool
let ownerA: ReturnType<typeof createTransactions>, ownerB: ReturnType<typeof createTransactions>
let limiter: ReturnType<typeof createAuthRateLimiter>, appA: ReturnType<typeof createApplicationAuth>, appB: ReturnType<typeof createApplicationAuth>
let config: Parameters<typeof createApplicationAuth>[1], ip = 100
function request(path: string, cookie = '', body?: unknown, method = 'POST', controls: { deadlineMs?: number; signal?: AbortSignal } = {}) {
  const incoming = Object.assign(new Request(origin + path, { method, signal: controls.signal, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin, cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-real-ip': `192.0.2.${ip++}` } }),
  { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + (controls.deadlineMs ?? 10000) }); return incoming
}
const cookies = (headers: Headers) => headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
function capturedCreator(): AuthContext['internalAdapter']['createSession'] | undefined {
  return Reflect.get(observed, 'creator')
}

beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
    GRANT SELECT,INSERT ON public.passkey TO runtime;
    GRANT UPDATE (counter) ON TABLE public.passkey TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
    GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
    GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
    GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
    GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
  poolA = new Pool({ connectionString: stores.directRuntimeUrl, max: 2 })
  poolB = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  ownerA = createTransactions(poolA, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  ownerB = createTransactions(poolB, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'passkey-concurrency', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  await limiter.connect()
  const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
  config = { ...readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }
  appA = createApplicationAuth(ownerA, config, limiter); appB = createApplicationAuth(ownerB, config, limiter)
})

afterAll(async () => {
  const failures: string[] = []
  for (const [name, close] of [['app-a', () => appA?.close()], ['app-b', () => appB?.close()], ['limiter', () => limiter?.close()],
    ['pool-a', () => poolA?.end()], ['pool-b', () => poolB?.end()]] as const) try { await close() } catch { failures.push(name) }
  if (stores) {
    try { await stores.cleanup() } catch { failures.push('stores') }
    finally {
      const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9a-evidence')
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, `concurrency-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n')
    }
  }
  if (failures.length) throw new Error('Passkey concurrency cleanup failed: ' + failures.join(','))
})

async function enroll(app: ReturnType<typeof createApplicationAuth>, email: string) {
  await app.requestMagicLink(request('/auth/magic/request'), { email, locale: 'en' })
  const proof = { token: observed.token, intendedEmail: email }
  const consume = request('/auth/magic/consume', '', proof)
  const optionsResponse = await magicConsumeResponse(consume, await consume.json(), app, limiter)
  expect(optionsResponse.status).toBe(200)
  const options = await optionsResponse.json()
  const credential = registrationCredentialFixture(options.options, origin)
  const complete = request('/auth/magic/enroll', cookies(optionsResponse.headers), { ...proof, response: credential.response })
  const enrolled = await magicEnrollmentResponse(complete, await complete.json(), app, limiter)
  expect(enrolled.status).toBe(200)
  const principal = await app.readPrincipal(request('/account', cookies(enrolled.headers), undefined, 'GET'))
  expect(Boolean(principal)).toBe(true)
  await app.logout(request('/logout', cookies(enrolled.headers)))
  return { credential, userId: principal!.userId }
}

test('native challenge consumption and credential counters remain correct across independent physical backends', async () => {
  const first = await enroll(appA, 'race-a@example.test')
  const second = await enroll(appA, 'race-b@example.test')

  const shared = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  observed.entered = 0
  observed.bothEntered = new Promise<void>(resolve => { observed.markBothEntered = resolve })
  observed.raceBarrier = new Promise<void>(resolve => { observed.releaseRace = resolve })
  observed.mode = 'race'
  let race: Array<ReturnType<typeof appA.finishPasskeySignIn>> = []
  let raced: PromiseSettledResult<Awaited<ReturnType<typeof appA.finishPasskeySignIn>>>[] = []
  let blockingObserved = false, triggerInstalled = false
  try {
    await stores.administrator.query(`CREATE FUNCTION fixture_passkey_consume_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.6); RETURN OLD; END $$;
      CREATE TRIGGER fixture_passkey_consume_overlap BEFORE DELETE ON verification
      FOR EACH ROW EXECUTE FUNCTION fixture_passkey_consume_overlap()`)
    triggerInstalled = true
    race = [
      appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(shared.headers)),
        { response: first.credential.authenticationResponse(shared.options, { counter: 0 }) }),
      appB.finishPasskeySignIn(request('/auth/passkey/finish', cookies(shared.headers)),
        { response: second.credential.authenticationResponse(shared.options, { counter: 0 }) }),
    ]
    await Promise.race([observed.bothEntered, delay(3000).then(() => { throw new Error('Distinct User/key paths did not both reach consume') })])
    observed.releaseRace()
    let settled = false
    void Promise.allSettled(race).then(() => { settled = true })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !blockingObserved && !settled) {
      blockingObserved = (await stores.administrator.query(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity waiter JOIN pg_stat_activity blocker ON blocker.pid=ANY(pg_blocking_pids(waiter.pid))
        WHERE waiter.usename='runtime' AND blocker.usename='runtime' AND waiter.wait_event_type='Lock'
          AND lower(waiter.query) LIKE '%delete from "verification"%'
          AND lower(blocker.query) LIKE '%delete from "verification"%') AS blocking`)).rows[0].blocking === true
      if (!blockingObserved) await delay(20)
    }
    expect(blockingObserved).toBe(true)
    raced = await Promise.allSettled(race)
  } finally {
    observed.releaseRace(); observed.mode = ''
    await Promise.allSettled(race)
    if (triggerInstalled) await stores.administrator.query('DROP TRIGGER IF EXISTS fixture_passkey_consume_overlap ON verification; DROP FUNCTION IF EXISTS fixture_passkey_consume_overlap()')
  }
  expect(raced.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)
  expect((await stores.administrator.query('SELECT counter FROM passkey ORDER BY user_id')).rows).toEqual([{ counter: 0 }, { counter: 0 }])
  const loser = raced[0].status === 'rejected' ? { credential: first.credential } : { credential: second.credential }
  await appB.close(); appB = createApplicationAuth(createTransactions(poolB, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), config, limiter)
  const replayRequest = request('/auth/passkey/finish', cookies(shared.headers))
  const replay = await appB.finishPasskeySignIn(replayRequest, { response: loser.credential.authenticationResponse(shared.options, { counter: 0 }) }).catch(error => error)
  expect(appB.passkeyErrorResponse(replay)?.status).toBe(401)
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)

  await stores.administrator.query('DELETE FROM session; DELETE FROM verification; UPDATE passkey SET counter=0')
  const lower = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  const higher = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  observed.held = false
  observed.holdEntered = new Promise<void>(resolve => { observed.markHoldEntered = resolve })
  observed.holdBarrier = new Promise<void>(resolve => { observed.releaseHold = resolve })
  observed.mode = 'hold'
  const high = appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(higher.headers)),
    { response: first.credential.authenticationResponse(higher.options, { counter: 2 }) })
  let low: ReturnType<typeof appB.finishPasskeySignIn> | undefined
  let highResult: PromiseSettledResult<Awaited<typeof high>> | undefined, lowResult: PromiseSettledResult<Awaited<typeof high>> | undefined
  try {
    await Promise.race([observed.holdEntered, delay(3000).then(() => { throw new Error('Higher counter did not acquire its locked path') })])
    low = appB.finishPasskeySignIn(request('/auth/passkey/finish', cookies(lower.headers)),
      { response: first.credential.authenticationResponse(lower.options, { counter: 1 }) })
    let keyLockObserved = false
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && !keyLockObserved) {
      keyLockObserved = (await stores.administrator.query(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity waiter JOIN pg_stat_activity blocker ON blocker.pid=ANY(pg_blocking_pids(waiter.pid))
        WHERE waiter.usename='runtime' AND blocker.usename='runtime' AND waiter.wait_event_type='Lock'
          AND lower(waiter.query) LIKE '%from "user"%' AND lower(waiter.query) LIKE '%for update%') AS blocked`)).rows[0].blocked === true
      if (!keyLockObserved) await delay(10)
    }
    expect(keyLockObserved).toBe(true)
    observed.releaseHold()
    ;[highResult, lowResult] = await Promise.allSettled([high, low])
  } finally {
    observed.releaseHold(); observed.mode = ''
    await Promise.allSettled([high, ...(low ? [low] : [])])
  }
  expect(Boolean(highResult && lowResult)).toBe(true)
  expect(highResult.status).toBe('fulfilled'); expect(lowResult.status).toBe('rejected')
  if (lowResult.status === 'rejected') expect(appB.passkeyErrorResponse(lowResult.reason)?.status).toBe(401)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [first.userId])).rows).toEqual([{ counter: 2 }])
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)

  await stores.administrator.query('DELETE FROM session; DELETE FROM verification; UPDATE passkey SET counter=0')
  const reverseLow = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  const reverseHigh = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  observed.held = false
  observed.holdEntered = new Promise<void>(resolve => { observed.markHoldEntered = resolve })
  observed.holdBarrier = new Promise<void>(resolve => { observed.releaseHold = resolve })
  observed.mode = 'hold'
  const lowFirst = appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(reverseLow.headers)),
    { response: first.credential.authenticationResponse(reverseLow.options, { counter: 1 }) })
  let highSecond: ReturnType<typeof appB.finishPasskeySignIn> | undefined
  let reverseResults: PromiseSettledResult<Awaited<typeof lowFirst>>[] = []
  try {
    await Promise.race([observed.holdEntered, delay(3000).then(() => { throw new Error('Lower counter did not acquire its locked path') })])
    highSecond = appB.finishPasskeySignIn(request('/auth/passkey/finish', cookies(reverseHigh.headers)),
      { response: first.credential.authenticationResponse(reverseHigh.options, { counter: 2 }) })
    let reverseLockObserved = false
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && !reverseLockObserved) {
      reverseLockObserved = (await stores.administrator.query(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity waiter JOIN pg_stat_activity blocker ON blocker.pid=ANY(pg_blocking_pids(waiter.pid))
        WHERE waiter.usename='runtime' AND blocker.usename='runtime' AND waiter.wait_event_type='Lock'
          AND lower(waiter.query) LIKE '%from "user"%' AND lower(waiter.query) LIKE '%for update%') AS blocked`)).rows[0].blocked === true
      if (!reverseLockObserved) await delay(10)
    }
    expect(reverseLockObserved).toBe(true)
    observed.releaseHold()
    reverseResults = await Promise.allSettled([lowFirst, highSecond])
  } finally {
    observed.releaseHold(); observed.mode = ''
    await Promise.allSettled([lowFirst, ...(highSecond ? [highSecond] : [])])
  }
  expect(reverseResults.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [first.userId])).rows).toEqual([{ counter: 2 }])
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(2)

  await stores.administrator.query('DELETE FROM session; DELETE FROM verification; UPDATE passkey SET counter=0')
  const zeroA = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  const zeroB = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  const acceptedA = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(zeroA.headers)),
    { response: first.credential.authenticationResponse(zeroA.options, { counter: 0 }) })
  const acceptedB = await appB.finishPasskeySignIn(request('/auth/passkey/finish', cookies(zeroB.headers)),
    { response: first.credential.authenticationResponse(zeroB.options, { counter: 0 }) })
  expect(acceptedA.authenticated && acceptedB.authenticated).toBe(true)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [first.userId])).rows).toEqual([{ counter: 0 }])
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(2)
  const used = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(zeroA.headers)),
    { response: first.credential.authenticationResponse(zeroA.options, { counter: 0 }) }).catch(error => error)
  expect(appA.passkeyErrorResponse(used)?.status).toBe(401)
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(2)
}, 180000)

test('native admission faults and confirmed commit failure publish no session and roll back the challenge and counter', async () => {
  observed.mode = ''
  const fault = await enroll(appA, 'fault@example.test')
  async function resetFault() {
    await stores.administrator.query('DELETE FROM session')
    await stores.administrator.query('DELETE FROM verification')
    await stores.administrator.query('UPDATE passkey SET counter=0 WHERE user_id=$1', [fault.userId])
  }
  for (const mode of ['wrong-operation', 'wrong-request', 'creator-shape', 'cookie', 'after-hook', 'duplicate'] as const) {
    await resetFault()
    const beginning = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
    observed.authority = undefined; observed.creator = undefined; observed.createdUserId = ''; observed.mode = mode
    const finish = request('/auth/passkey/finish', cookies(beginning.headers))
    const error = await appA.finishPasskeySignIn(finish,
      { response: fault.credential.authenticationResponse(beginning.options, { counter: 1 }) }).catch(error => error)
    observed.mode = ''
    expect(error instanceof Error).toBe(true)
    const mapped = appA.passkeyErrorResponse(error)
    expect(mapped?.headers.getSetCookie().length ?? 0).toBe(0)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [fault.userId])).rows).toEqual([{ counter: 0 }])
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
    const retained = capturedCreator()
    if (retained) {
      const retainedRefused = await retained(fault.userId).then(() => false, () => true)
      expect(retainedRefused).toBe(true)
    }
  }

  for (const counter of [1, 0]) {
    await resetFault()
    const denied = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
    const hooksBefore = observed.verifiedHooks
    await stores.administrator.query(`CREATE FUNCTION fixture_passkey_counter_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Owned passkey counter rejection' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER fixture_passkey_counter_reject BEFORE UPDATE OF counter ON passkey
      FOR EACH ROW EXECUTE FUNCTION fixture_passkey_counter_reject()`)
    try {
      const deniedRequest = request('/auth/passkey/finish', cookies(denied.headers))
      const deniedError = await appA.finishPasskeySignIn(deniedRequest,
        { response: fault.credential.authenticationResponse(denied.options, { counter }) }).catch(error => error)
      expect(deniedError instanceof Error).toBe(true)
      expect(observed.verifiedHooks).toBe(hooksBefore + 1)
      expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [fault.userId])).rows).toEqual([{ counter: 0 }])
      expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
      expect((await stores.administrator.query('SELECT count(*)::int AS challenges FROM verification')).rows[0].challenges).toBe(1)
    } finally {
      await stores.administrator.query('DROP TRIGGER IF EXISTS fixture_passkey_counter_reject ON passkey; DROP FUNCTION IF EXISTS fixture_passkey_counter_reject()')
    }
    const recovered = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(denied.headers)),
      { response: fault.credential.authenticationResponse(denied.options, { counter }) })
    expect(recovered.authenticated).toBe(true)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [fault.userId])).rows).toEqual([{ counter }])
  }

  await resetFault()
  const sessionFailure = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  await stores.administrator.query(`CREATE FUNCTION fixture_passkey_session_reject() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Owned passkey session rejection' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER fixture_passkey_session_reject BEFORE INSERT ON session
    FOR EACH ROW EXECUTE FUNCTION fixture_passkey_session_reject()`)
  try {
    const sessionError = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(sessionFailure.headers)),
      { response: fault.credential.authenticationResponse(sessionFailure.options, { counter: 1 }) }).catch(error => error)
    expect(sessionError instanceof Error).toBe(true)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [fault.userId])).rows).toEqual([{ counter: 0 }])
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS challenges FROM verification')).rows[0].challenges).toBe(1)
  } finally {
    await stores.administrator.query('DROP TRIGGER IF EXISTS fixture_passkey_session_reject ON session; DROP FUNCTION IF EXISTS fixture_passkey_session_reject()')
  }
  expect((await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(sessionFailure.headers)),
    { response: fault.credential.authenticationResponse(sessionFailure.options, { counter: 1 }) })).authenticated).toBe(true)

  await resetFault()
  const commit = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  await stores.administrator.query(`CREATE FUNCTION fixture_passkey_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Owned passkey commit rejection' USING ERRCODE='23514'; END $$;
    CREATE CONSTRAINT TRIGGER fixture_passkey_commit_reject AFTER INSERT ON session DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fixture_passkey_commit_reject()`)
  try {
    const commitRequest = request('/auth/passkey/finish', cookies(commit.headers))
    const commitError = await appA.finishPasskeySignIn(commitRequest,
      { response: fault.credential.authenticationResponse(commit.options, { counter: 1 }) }).catch(error => error)
    expect(commitError instanceof Error).toBe(true)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [fault.userId])).rows).toEqual([{ counter: 0 }])
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS challenges FROM verification')).rows[0].challenges).toBe(1)
  } finally {
    await stores.administrator.query('DROP TRIGGER IF EXISTS fixture_passkey_commit_reject ON session; DROP FUNCTION IF EXISTS fixture_passkey_commit_reject()')
  }
  const committed = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(commit.headers)),
    { response: fault.credential.authenticationResponse(commit.options, { counter: 1 }) })
  expect(committed.authenticated).toBe(true)
  const ambient = await appA.beginPasskeySignIn(request('/auth/passkey/begin', cookies(committed.headers))).catch(error => error)
  expect(appA.passkeyErrorResponse(ambient)?.status).toBe(409)
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)
}, 180000)

test('locked binding, database time, deadlines and invocation identity fail closed without publishing another session', async () => {
  observed.mode = ''; observed.shortExpiryMs = 0; observed.afterDelayMs = 0
  const stale = await enroll(appA, 'stale@example.test')
  async function resetStale() {
    await stores.administrator.query('DELETE FROM session')
    await stores.administrator.query('DELETE FROM verification')
    await stores.administrator.query('UPDATE "user" SET recovering=false,recovery_generation=0 WHERE id=$1', [stale.userId])
    await stores.administrator.query('UPDATE passkey SET counter=0 WHERE user_id=$1', [stale.userId])
  }
  async function lockObserved(table: 'user' | 'passkey', observer: 'administrator' | 'runtime' = 'administrator', blockerPid?: number) {
    let blocked = false
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && !blocked) {
      const statement = `SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity waiter JOIN pg_stat_activity blocker ON blocker.pid=ANY(pg_blocking_pids(waiter.pid))
        WHERE waiter.usename='runtime' AND ${blockerPid === undefined ? "blocker.usename='runtime'" : 'blocker.pid=$2'} AND waiter.wait_event_type='Lock'
          AND lower(waiter.query) LIKE $1 AND lower(waiter.query) LIKE '%for update%') AS blocked`
      const values = blockerPid === undefined ? [`%from "${table}"%`] : [`%from "${table}"%`, blockerPid]
      const result = observer === 'administrator'
        ? await stores.administrator.query(statement, values)
        : await poolB.query(statement, values)
      blocked = result.rows[0].blocked === true
      if (!blocked) await delay(10)
    }
    expect(blocked).toBe(true)
  }

  for (const mutation of ['generation', 'recovering'] as const) {
    await resetStale()
    const beginning = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
    const blocker = await poolB.connect()
    let pending: ReturnType<typeof appA.finishPasskeySignIn> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [stale.userId])
      pending = appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(beginning.headers)),
        { response: stale.credential.authenticationResponse(beginning.options, { counter: 1 }) })
      await lockObserved('user')
      await blocker.query(mutation === 'generation'
        ? 'UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1'
        : 'UPDATE "user" SET recovering=true WHERE id=$1', [stale.userId])
      await blocker.query('COMMIT')
      const error = await pending.catch(error => error)
      expect(appA.passkeyErrorResponse(error)?.status).toBe(401)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {}); blocker.release(true)
      if (pending) await Promise.allSettled([pending])
    }
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [stale.userId])).rows).toEqual([{ counter: 0 }])
  }

  await resetStale()
  const originalPublicKey = (await stores.administrator.query('SELECT public_key FROM passkey WHERE user_id=$1', [stale.userId])).rows[0].public_key
  const binding = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  const keyBlocker = stores.administrator
  const keyBlockerPid = (await keyBlocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  let bindingPending: ReturnType<typeof appA.finishPasskeySignIn> | undefined
  try {
    await keyBlocker.query('BEGIN')
    await keyBlocker.query('SELECT id FROM passkey WHERE user_id=$1 FOR UPDATE', [stale.userId])
    bindingPending = appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(binding.headers)),
      { response: stale.credential.authenticationResponse(binding.options, { counter: 1 }) })
    await lockObserved('passkey', 'runtime', keyBlockerPid)
    await keyBlocker.query("UPDATE passkey SET public_key='AQ' WHERE user_id=$1", [stale.userId])
    await keyBlocker.query('COMMIT')
    const error = await bindingPending.catch(error => error)
    expect(appA.passkeyErrorResponse(error)?.status).toBe(401)
  } finally {
    await keyBlocker.query('ROLLBACK').catch(() => {})
    if (bindingPending) await Promise.allSettled([bindingPending])
    await stores.administrator.query('UPDATE passkey SET public_key=$1 WHERE user_id=$2', [originalPublicKey, stale.userId])
  }
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)

  await resetStale(); observed.shortExpiryMs = 200
  const expiring = await appA.beginPasskeySignIn(request('/auth/passkey/begin')); observed.shortExpiryMs = 0
  const afterBefore = observed.afterHookReached, cookieBefore = observed.afterCookieSessions, hooksBefore = observed.verifiedHooks
  observed.afterDelayMs = 300
  try {
    const expired = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(expiring.headers)),
      { response: stale.credential.authenticationResponse(expiring.options, { counter: 1 }) }).catch(error => error)
    expect(appA.passkeyErrorResponse(expired)?.status).toBe(401)
    expect(observed.afterHookReached).toBe(afterBefore + 1)
    expect(observed.afterCookieSessions).toBe(cookieBefore + 1)
    expect(observed.verifiedHooks).toBe(hooksBefore + 1)
  } finally { observed.afterDelayMs = 0 }
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [stale.userId])).rows).toEqual([{ counter: 0 }])

  for (const cancellation of ['deadline', 'abort'] as const) {
    await resetStale()
    const beginning = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
    observed.held = false
    observed.holdEntered = new Promise<void>(resolve => { observed.markHoldEntered = resolve })
    observed.holdBarrier = new Promise<void>(resolve => { observed.releaseHold = resolve })
    observed.mode = 'hold'
    const controller = new AbortController()
    const pending = appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(beginning.headers), undefined, 'POST', {
      deadlineMs: cancellation === 'deadline' ? 120 : 10000, signal: controller.signal,
    }), { response: stale.credential.authenticationResponse(beginning.options, { counter: 1 }) })
    const settled = pending.then(value => ({ value }), error => ({ error }))
    try {
      await Promise.race([observed.holdEntered, delay(3000).then(() => { throw new Error('Cancellation path did not reach the native hold') })])
      if (cancellation === 'abort') controller.abort()
      else await delay(180)
      observed.releaseHold()
      const outcome = await settled
      expect('error' in outcome && outcome.error instanceof Error).toBe(true)
    } finally {
      observed.releaseHold(); observed.mode = ''; await settled
    }
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [stale.userId])).rows).toEqual([{ counter: 0 }])
  }

  await resetStale()
  const foreign = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  observed.authorityEntered = new Promise<void>(resolve => { observed.markAuthorityEntered = resolve })
  observed.authorityBarrier = new Promise<void>(resolve => { observed.releaseAuthority = resolve })
  observed.mode = 'foreign-lease'; observed.authority = undefined
  const originalRequest = request('/auth/passkey/finish', cookies(foreign.headers))
  const original = appA.finishPasskeySignIn(originalRequest,
    { response: stale.credential.authenticationResponse(foreign.options, { counter: 1 }) })
  try {
    await Promise.race([observed.authorityEntered, delay(3000).then(() => { throw new Error('Native authority was not captured') })])
    const refused = await ownerA.runAuthInvocation({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000,
      cleanupTimeoutMs: 1000, correlationId: randomUUID() }, () => ownerA.withAuthPromise(ownerA.invocationOptions(), async () => {
      try { observed.authority!.assert('complete', originalRequest); return false } catch { return true }
    }))
    expect(refused).toBe(true)
  } finally {
    observed.releaseAuthority(); observed.mode = ''; await Promise.allSettled([original])
  }
  expect((await original).authenticated).toBe(true)

  await resetStale()
  const postCommit = await appA.beginPasskeySignIn(request('/auth/passkey/begin'))
  const invoke = ownerA.runAuthInvocation.bind(ownerA)
  let cut = true
  const invocationSpy = vi.spyOn(ownerA, 'runAuthInvocation').mockImplementation((options, call) => invoke(options, async () => {
    const result = await call()
    if (cut) { cut = false; throw new Error('Owned failure after confirmed commit') }
    return result
  }))
  const postCommitRequest = request('/auth/passkey/finish', cookies(postCommit.headers))
  const postCommitError = await appA.finishPasskeySignIn(postCommitRequest,
    { response: stale.credential.authenticationResponse(postCommit.options, { counter: 1 }) }).catch(error => error)
  invocationSpy.mockRestore()
  expect(postCommitError instanceof Error).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [stale.userId])).rows).toEqual([{ counter: 1 }])
  const replay = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(postCommit.headers)),
    { response: stale.credential.authenticationResponse(postCommit.options, { counter: 1 }) }).catch(error => error)
  expect(appA.passkeyErrorResponse(replay)?.status).toBe(401)
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)

  await resetStale()
  const relay = await pgRelay(stores.directRuntimeUrl, 'before-command-complete', true)
  const relayPool = new Pool({ connectionString: relay.url, max: 1 })
  const relayOwner = createTransactions(relayPool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const relayApp = createApplicationAuth(relayOwner, config, limiter)
  try {
    const ambiguous = await relayApp.beginPasskeySignIn(request('/auth/passkey/begin'))
    const ambiguousError = await relayApp.finishPasskeySignIn(request('/auth/passkey/finish', cookies(ambiguous.headers)),
      { response: stale.credential.authenticationResponse(ambiguous.options, { counter: 1 }) }).catch(error => error)
    expect(ambiguousError).toMatchObject({ name: 'PgTransactionError', outcome: 'unknown' })
    expect(relay.sessionInserts()).toBe(1)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [stale.userId])).rows).toEqual([{ counter: 1 }])
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS challenges FROM verification')).rows[0].challenges).toBe(0)
    const ambiguousReplay = await appA.finishPasskeySignIn(request('/auth/passkey/finish', cookies(ambiguous.headers)),
      { response: stale.credential.authenticationResponse(ambiguous.options, { counter: 1 }) }).catch(error => error)
    expect(appA.passkeyErrorResponse(ambiguousReplay)?.status).toBe(401)
    expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(1)
  } finally {
    await relayApp.close(); await relayPool.end(); await relay.close()
  }
}, 180000)
