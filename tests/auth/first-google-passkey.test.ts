import { expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { AuthAttemptExceeded, createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { FirstGooglePasskeyRejected, validateFirstGoogleTarget, validateFirstGoogleFinish } from '../../src/modules/auth/first-google-passkey.server'
import { firstGooglePasskeyCallbackResponse } from '../../src/modules/auth/http-boundary.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'

test('recent pre-Begin Google authentication has a nonrenewable proof window', async () => {
  const modules = import.meta.glob('../../src/modules/auth/first-google-passkey.server.ts')
  const load = modules['../../src/modules/auth/first-google-passkey.server.ts']
  expect(typeof load).toBe('function')
  const api = await load() as { firstGoogleProofWindow: (input: unknown, now: Date, created: Date) => unknown; FirstGooglePasskeyRejected: new () => Error }
  expect(typeof api.firstGoogleProofWindow).toBe('function')
  const now = new Date('2030-01-01T00:00:00Z'), seconds = now.getTime() / 1000
  const claims = { auth_time: seconds - 10, iat: seconds - 5, exp: seconds + 3600 }
  expect(api.firstGoogleProofWindow(claims, now, new Date(now.getTime() - 1000))).toEqual({
    authenticatedAt: new Date('2029-12-31T23:59:50Z'), expiresAt: new Date('2030-01-01T00:04:50Z'),
  })
  for (const auth_time of [undefined, '1', -1, 1.5, NaN, Infinity, seconds + 1, seconds - 300, seconds - 4]) {
    expect(() => api.firstGoogleProofWindow({ ...claims, auth_time }, now, now)).toThrow(api.FirstGooglePasskeyRejected)
  }
  for (const overrides of [{ iat: seconds + 1 }, { iat: Infinity }, { exp: seconds }, { exp: NaN }, { exp: seconds - 5 }]) {
    expect(() => api.firstGoogleProofWindow({ ...claims, ...overrides }, now, now)).toThrow(api.FirstGooglePasskeyRejected)
  }
  expect(api.firstGoogleProofWindow({ ...claims, exp: seconds + 20 }, now, now)).toEqual({
    authenticatedAt: new Date('2029-12-31T23:59:50Z'), expiresAt: new Date('2030-01-01T00:00:20Z'),
  })
  expect(api.firstGoogleProofWindow(claims, now, new Date('2029-12-31T23:56:00Z'))).toEqual({
    authenticatedAt: new Date('2029-12-31T23:59:50Z'), expiresAt: new Date('2030-01-01T00:01:00Z'),
  })
  for (const created of [new Date('2029-12-31T23:55:00Z'), new Date('2030-01-01T00:00:01Z'), new Date(NaN)]) {
    expect(() => api.firstGoogleProofWindow(claims, now, created)).toThrow(api.FirstGooglePasskeyRejected)
  }
})

test('first-key public inputs select only an intent and a strict native registration', () => {
  const intentId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  expect(validateFirstGoogleTarget({ intentId })).toEqual({ intentId })
  for (const extra of [{ userId: 'posted' }, { sessionId: 'posted' }, { purpose: 'posted' }, { provider: 'google' }, { claims: {} }, { redirect: 'https://other.example.test' }]) {
    expect(() => validateFirstGoogleTarget({ intentId, ...extra })).toThrow(FirstGooglePasskeyRejected)
  }
  const response = registrationCredentialFixture({ challenge: 'fixture', rp: { id: 'app.example.test' } }, 'https://app.example.test').response
  expect(validateFirstGoogleFinish({ intentId, response }).intentId).toBe(intentId)
  expect(() => validateFirstGoogleFinish({ intentId, response, createSession: true })).toThrow(FirstGooglePasskeyRejected)
  expect(() => validateFirstGoogleFinish({ intentId, response: { ...response, response: { ...response.response, publicKey: 'AQ' } } })).toThrow(FirstGooglePasskeyRejected)
})

test('callback has its own canonical cross-site GET boundary and sanitized no-store failures', async () => {
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } }, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1', RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'first-boundary', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(new AuthAttemptExceeded(17))
  const origin = 'https://app.example.test', app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, limiter)
  try {
    for (const path of ['/api/auth/first-passkey/google/callback/', '/api/auth/first-passkey/google/callback%00', '/api/auth/callback/google']) {
      const request = new Request(origin + path)
      Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
      const response = await firstGooglePasskeyCallbackResponse(request, app, limiter)
      expect({ status: response.status, cookies: response.headers.getSetCookie().length, cache: response.headers.get('cache-control'), referrer: response.headers.get('referrer-policy') })
        .toEqual({ status: 401, cookies: 0, cache: 'no-store', referrer: 'no-referrer' })
    }
    expect(checkouts).toBe(0); expect(consume).not.toHaveBeenCalled()
    for (const path of ['/application/first-passkey/google/begin', '/application/first-passkey/google/complete']) {
      expect((await app.callback(new Request(origin + '/api/auth' + path))).status).toBe(404)
    }
  } finally { await app.close(); await limiter.close() }
})
test.each(['beginFirstGooglePasskey', 'completeFirstGooglePasskeyOAuth', 'readFirstGooglePasskey', 'prepareFirstGooglePasskey', 'finishFirstGooglePasskey', 'cancelFirstGooglePasskey'])(
  '%s limits before decoding, session reads or provider effects', async command => {
    let checkouts = 0
    const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } }, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1', RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'first-source', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(new AuthAttemptExceeded(17))
    const origin = 'https://app.example.test'
    const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret' })!, limiter)
    try {
      const method = Reflect.get(app, command)
      expect(typeof method).toBe('function')
      const callback = command === 'completeFirstGooglePasskeyOAuth'
      const request = Object.assign(new Request(origin + (callback ? '/api/auth/first-passkey/google/callback?state=bad' : '/first'), { method: callback ? 'GET' : 'POST', headers: { ...(callback ? {} : { origin }), 'sec-fetch-site': callback ? 'cross-site' : 'same-origin', 'x-real-ip': '192.0.2.41' } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
      Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
      const error = await method(request, {}).catch((error: unknown) => error)
      expect(limiter.errorResponse(error)?.status).toBe(429)
      expect(checkouts).toBe(0)
      expect(consume).toHaveBeenCalledExactlyOnceWith(command, expect.anything())
    } finally { await app.close(); await limiter.close() }
  })
