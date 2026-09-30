import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseError, Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'

const observed = vi.hoisted(() => ({ token: '' }))
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args)
    observed.token = args[3].toString('base64url')
    return result
  } }
})

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
let client = 91
function request(path: string, cookie = '', body?: unknown, method = 'POST') {
  const incoming = Object.assign(new Request(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin, cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-real-ip': `192.0.2.${client++}` } }),
  { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  return incoming
}
const cookies = (headers: Headers) => headers.getSetCookie().map(value => value.split(';')[0]).join('; ')

// Break caught: replacing native signed UV with requested-option intent, issuing
// a fake session, or failing to keep challenge/counter/session in one rollback.
test('enrolled user signs out and returns through native signed-UV passkey login', async () => {
  const probeOwner = createTransactions({ async connect(): Promise<never> { throw new Error('Feature probe must not acquire PostgreSQL') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const probeLimiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'passkey-probe', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  const probe = createApplicationAuth(probeOwner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, probeLimiter)
  try {
    expect('beginPasskeySignIn' in probe, 'Feature absence: named passkey options command is missing').toBe(true)
    expect('finishPasskeySignIn' in probe, 'Feature absence: named passkey finish command is missing').toBe(true)
    expect('passkeyErrorResponse' in probe, 'Feature absence: passkey error boundary is missing').toBe(true)
  } finally { await probe.close(); await probeLimiter.close() }

  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined
  let limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let application: ReturnType<typeof createApplicationAuth> | undefined
  observed.token = ''
  try {
    stores = await startDisposableStores()
    await stores.migrate()
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
    pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 3 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'passkey-login', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
    await limiter.connect()
    const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
    const config = { ...readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }
    application = createApplicationAuth(owner, config, limiter)

    await application.requestMagicLink(request('/auth/magic/request'), { email: 'passkey-login@example.test', locale: 'en' })
    const proof = { token: observed.token, intendedEmail: 'passkey-login@example.test' }
    const consumeRequest = request('/auth/magic/consume', '', proof)
    const enrollmentOptionsResponse = await magicConsumeResponse(consumeRequest, await consumeRequest.json(), application, limiter)
    expect(enrollmentOptionsResponse.status).toBe(200)
    const enrollment = await enrollmentOptionsResponse.json()
    expect(enrollment.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
    const credential = registrationCredentialFixture(enrollment.options, origin)
    const enrollRequest = request('/auth/magic/enroll', cookies(enrollmentOptionsResponse.headers), { ...proof, response: credential.response })
    const enrolled = await magicEnrollmentResponse(enrollRequest, await enrollRequest.json(), application, limiter)
    expect(enrolled.status).toBe(200)
    const enrolledCookie = cookies(enrolled.headers)
    const enrolledPrincipal = await application.readPrincipal(request('/account', enrolledCookie, undefined, 'GET'))
    expect(Boolean(enrolledPrincipal)).toBe(true)
    const enrolledUserId = enrolledPrincipal!.userId

    const signedOut = await application.logout(request('/logout', enrolledCookie))
    expect(cookies(signedOut.headers)).not.toBe('')
    expect(await application.readPrincipal(request('/account', enrolledCookie, undefined, 'GET'))).toBeNull()

    const begin = await application.beginPasskeySignIn(request('/auth/passkey/begin'))
    expect(begin.options.userVerification).toBe('required')
    const challengeCookie = cookies(begin.headers)
    const before = await stores.administrator.query('SELECT counter FROM passkey')
    expect(before.rows).toEqual([{ counter: 0 }])

    const uvFalse = credential.authenticationResponse(begin.options, { uv: false, counter: 1 })
    const rejectedRequest = request('/auth/passkey/finish', challengeCookie, { response: uvFalse })
    const rejectedError = await application.finishPasskeySignIn(rejectedRequest, await rejectedRequest.json()).catch(error => error)
    const rejected = application.passkeyErrorResponse(rejectedError)
    expect(rejected?.status).toBe(401)
    expect(rejected?.headers.getSetCookie().length).toBe(0)
    expect((await stores.administrator.query('SELECT counter FROM passkey')).rows).toEqual([{ counter: 0 }])
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(0)

    const uvTrue = credential.authenticationResponse(begin.options, { uv: true, counter: 1 })
    const acceptedRequest = request('/auth/passkey/finish', challengeCookie, { response: uvTrue })
    const accepted = await application.finishPasskeySignIn(acceptedRequest, await acceptedRequest.json())
    expect(accepted.authenticated).toBe(true)
    expect((await stores.administrator.query('SELECT counter FROM passkey')).rows).toEqual([{ counter: 1 }])
    const admitted = await stores.administrator.query("SELECT user_id,auth_state,auth_method,recovery_generation,authenticated_at=last_activity_at AS same_time FROM session")
    expect(admitted.rows).toEqual([{ user_id: enrolledUserId, auth_state: 'ACTIVE', auth_method: 'passkey', recovery_generation: 0, same_time: true }])
    const returnedPrincipal = await application.readPrincipal(request('/account', cookies(accepted.headers), undefined, 'GET'))
    expect(returnedPrincipal?.userId).toBe(enrolledUserId)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM passkey')).rows[0].count).toBe(1)

    const badChallenge = await application.beginPasskeySignIn(request('/auth/passkey/begin'))
    const consoleMethods = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {})]
    const malformed = credential.authenticationResponse(badChallenge.options, { challenge: 'AQ', counter: 2 })
    const malformedRequest = request('/auth/passkey/finish', cookies(badChallenge.headers), { response: malformed })
    const malformedError = await application.finishPasskeySignIn(malformedRequest, await malformedRequest.json()).catch(error => error)
    const malformedStatus = application.passkeyErrorResponse(malformedError)?.status
    const consoleOutputObserved = consoleMethods.some(method => method.mock.calls.length > 0)
    for (const method of consoleMethods) method.mockRestore()
    expect(malformedStatus).toBe(401)
    expect(consoleOutputObserved).toBe(false)
    expect((await stores.administrator.query('SELECT counter FROM passkey')).rows).toEqual([{ counter: 1 }])
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(1)

    for (const variant of ['signature', 'origin', 'rp', 'up', 'unknown-key', 'missing-cookie'] as const) {
      const negative = await application.beginPasskeySignIn(request('/auth/passkey/begin'))
      const signed = credential.authenticationResponse(negative.options, {
        counter: 2,
        origin: variant === 'origin' ? 'https://other.example.test' : undefined,
        rpId: variant === 'rp' ? 'other.example.test' : undefined,
        up: variant === 'up' ? false : undefined,
      })
      const response = variant === 'signature' ? { ...signed, response: { ...signed.response, signature: 'AQ' } }
        : variant === 'unknown-key' ? { ...signed, id: 'Ag', rawId: 'Ag' } : signed
      const negativeRequest = request('/auth/passkey/finish', variant === 'missing-cookie' ? '' : cookies(negative.headers), { response })
      const error = await application.finishPasskeySignIn(negativeRequest, await negativeRequest.json()).catch(error => error)
      expect(application.passkeyErrorResponse(error)?.status).toBe(401)
      expect((await stores.administrator.query('SELECT counter FROM passkey')).rows).toEqual([{ counter: 1 }])
      expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(1)
    }

    async function restricted(statement: string) {
      try { await pool!.query(statement); return false }
      catch (error) { return error instanceof DatabaseError && error.code === '42501' }
    }
    expect(await restricted('UPDATE passkey SET user_id=user_id')).toBe(true)
    expect(await restricted('UPDATE passkey SET public_key=public_key')).toBe(true)
    expect(await restricted('DELETE FROM passkey')).toBe(true)
  } finally {
    observed.token = ''
    const failures: string[] = []
    for (const [name, close] of [['auth', () => application?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()]] as const) {
      try { await close() } catch { failures.push(name) }
    }
    if (stores) {
      try { await stores.cleanup() } catch { failures.push('stores') }
      finally {
        const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9a-evidence')
        await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n')
      }
    }
    if (failures.length) throw new Error('Passkey login cleanup failed: ' + failures.join(','))
  }
}, 180000)
