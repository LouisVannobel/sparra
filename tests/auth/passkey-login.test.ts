import { randomBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { AuthAttemptExceeded, createAuthRateLimiter, RedisInvalid, RedisUnavailable, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { PasskeyLoginRejected, validatePasskeyAuthenticationOptions, validatePasskeyFinishInput } from '../../src/modules/auth/passkey-login.server'
import { createTransactions } from '../../src/platform/db/transactions.server'

const origin = 'https://app.example.test'
const assertion = { id: 'AQ', rawId: 'AQ', type: 'public-key', response: {
  clientDataJSON: 'AQ', authenticatorData: 'AQ', signature: 'AQ',
}, clientExtensionResults: {}, authenticatorAttachment: 'platform' }

test('passkey input accepts only a bounded assertion envelope without posted identity or policy', () => {
  expect(validatePasskeyFinishInput({ response: assertion }).response.id).toBe('AQ')
  const refused = [
    assertion,
    { response: { ...assertion, userId: 'posted-user' } },
    { response: { ...assertion, rawId: 'Ag' } },
    { response: { ...assertion, id: 'not+base64url' } },
    { response: { ...assertion, clientExtensionResults: { posted: true } } },
    { response: { ...assertion, response: { ...assertion.response, clientDataJSON: '' } } },
  ].map(input => { try { validatePasskeyFinishInput(input); return false } catch (error) { return error instanceof PasskeyLoginRejected } })
  expect(refused).toEqual([true, true, true, true, true, true])
})

test('anonymous native options retain only the browser contract and force required UV', () => {
  expect(validatePasskeyAuthenticationOptions({ challenge: 'AQ', rpId: 'app.example.test', timeout: 60000,
    allowCredentials: undefined, userVerification: 'preferred', extensions: undefined })).toEqual({
    challenge: 'AQ', rpId: 'app.example.test', timeout: 60000, userVerification: 'required',
  })
  for (const input of [
    { challenge: 'AQ', rpId: 'app.example.test', timeout: 60000, allowCredentials: [{ id: 'AQ', type: 'public-key' }], userVerification: 'preferred' },
    { challenge: 'AQ', rpId: 'other.example.test', timeout: 60000, userVerification: 'preferred', postedUser: 'user-1' },
  ]) expect(() => validatePasskeyAuthenticationOptions(input)).toThrow(PasskeyLoginRejected)
})

test.each([
  ['beginPasskeySignIn', new AuthAttemptExceeded(17), 429],
  ['beginPasskeySignIn', new RedisUnavailable(), 503],
  ['beginPasskeySignIn', new RedisInvalid(), 500],
  ['finishPasskeySignIn', new AuthAttemptExceeded(17), 429],
  ['finishPasskeySignIn', new RedisUnavailable(), 503],
  ['finishPasskeySignIn', new RedisInvalid(), 500],
] as const)('%s limiter refusal %s happens once before PostgreSQL checkout', async (operation, failure, status) => {
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'passkey-source', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(failure)
  const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, limiter)
  try {
    const request = Object.assign(new Request(origin + (operation === 'beginPasskeySignIn' ? '/auth/passkey/begin' : '/auth/passkey/finish'), { method: 'POST', headers: {
      origin, 'sec-fetch-site': 'same-origin', 'x-real-ip': '192.0.2.41',
    } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    const error = await (operation === 'beginPasskeySignIn'
      ? app.beginPasskeySignIn(request)
      : app.finishPasskeySignIn(request, { postedUser: 'user-1' })).catch(error => error)
    expect(limiter.errorResponse(error)?.status).toBe(status)
    expect(checkouts).toBe(0)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0][0]).toBe(operation)
  } finally { await app.close(); await limiter.close() }
})
