import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { createTransactions } from '../../src/platform/db/transactions.server'

test('closed magic-only factory refuses every entry before any store checkout', async () => {
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected fixture checkout') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'fixture', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const origin = 'https://app.example.test'
  const config = { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: {
    envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }),
    profile: { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
      from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'reply@example.test', replayWindowSeconds: null },
  } }
  const app = createApplicationAuth(owner, config, limiter)
  try {
    await app.close()
    const request = new Request(origin + '/auth/magic/consume', { method: 'POST', headers: { origin } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    const refused = (work: () => Promise<unknown>) => work().then(() => false, error => error instanceof Error && error.message === 'Authentication unavailable')
    expect(await refused(() => app.requestMagicLink(request, { email: 'bound@example.test', locale: 'en' }))).toBe(true)
    expect(await refused(() => app.consumeMagicLink(request, { token: randomBytes(32).toString('base64url'), intendedEmail: 'bound@example.test' }))).toBe(true)
    expect(await refused(() => app.completeMagicEnrollment(request, {}))).toBe(true)
    expect(await refused(() => app.readPrincipal(request))).toBe(true)
    expect(await refused(() => app.logout(request))).toBe(true)
    expect(await refused(() => app.beginGoogleSignIn(request))).toBe(true)
    expect(await refused(() => app.beginPasskeySignIn(request))).toBe(true)
    expect(await refused(() => app.finishPasskeySignIn(request, {}))).toBe(true)
    expect(checkouts).toBe(0)
  } finally { await app.close(); await limiter.close() }
})
