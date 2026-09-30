import { randomBytes } from 'node:crypto'
import { beforeAll, expect, test, vi } from 'vitest'
import { magicConsumeResponse } from '../../src/modules/auth/http-boundary.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'

let factory: typeof import('../../src/modules/auth/auth.server')
beforeAll(async () => {
  // Nitro startup and SSR routes can hold separate module copies. Retain the
  // first real Response consumer, then construct the real factory in a second.
  vi.resetModules()
  factory = await import('../../src/modules/auth/auth.server')
}, 15000)

test('magic response error mapping survives distinct factory and response-boundary module instances', async () => {
  const { createApplicationAuth, readAuthConfig } = factory
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'fixture', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const allowed = vi.spyOn(limiter, 'consumeAuthAttempt').mockResolvedValue()
  const origin = 'https://app.example.test'
  const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
    AUTH_MAIL_KEY_ID: 'fixture', AUTH_MAIL_KEYS_JSON: JSON.stringify({ fixture: randomBytes(32).toString('base64') }),
    AUTH_MAIL_PROFILE_JSON: JSON.stringify({ appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
      from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'reply@example.test', replayWindowSeconds: null }) })!, limiter)
  try {
    const request = Object.assign(new Request(origin + '/auth/magic/consume', { method: 'POST', headers: { origin, 'x-real-ip': '192.0.2.32' } }),
      { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    const response = await magicConsumeResponse(request, { token: 'not-canonical', intendedEmail: 'owned@example.test' }, app, limiter)
    expect(response.status).toBe(401)
    expect(await response.text() === 'Authentication rejected').toBe(true)
    expect(response.headers.getSetCookie().length).toBe(0); expect(checkouts).toBe(0)
  } finally { await app.close(); await limiter.close(); allowed.mockRestore() }
})
