import { randomBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { AuthAttemptExceeded, createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { verifyRegistrationResponse } from '@simplewebauthn/server'

const origin = 'https://app.example.test'
const commands = ['beginGoogleAccountLink', 'authorizeGoogleAccountLink', 'completeGoogleAccountLinkOAuth',
  'beginGoogleAccountUnlink', 'finishGoogleAccountUnlink', 'readGoogleAccountIntent', 'cancelGoogleAccountIntent'] as const

test('Google callback dispatch admits only its exact cross-site GET spelling', async () => {
  const api = await import('../../src/modules/auth/http-boundary.server')
  const admit = Reflect.get(api, 'isGoogleAccountCallbackRequest')
  expect(typeof admit).toBe('function')
  expect(admit({ method: 'GET', url: origin + '/api/auth/account/google/callback?code=a&state=b' }, origin)).toBe(true)
  for (const path of ['/api/auth/account/google/callback/', '/api/auth/account/google/callback%00', '/api/auth/account/./google/callback', '/api/auth/callback/google', '/api/auth/account/google/callback-extra']) {
    expect(admit({ method: 'GET', url: origin + path }, origin)).toBe(false)
  }
  expect(admit({ method: 'POST', url: origin + '/api/auth/account/google/callback' }, origin)).toBe(false)
})

test('connection DTO keeps local unlink available without Google config and hides ambiguous rows', async () => {
  const api = await import('../../src/modules/auth/google-account.server')
  const project = Reflect.get(api, 'googleAccountConnection')
  expect(typeof project).toBe('function')
  expect(project([], true, true)).toEqual({ state: 'unlinked', canLink: true })
  expect(project([], true, false)).toEqual({ state: 'unlinked', canLink: false })
  expect(project([{ id: 'opaque-id' }], true, false)).toEqual({ state: 'linked', accountId: 'opaque-id', canUnlink: true })
  expect(project([{ id: 'opaque-id' }], false, true)).toEqual({ state: 'linked', accountId: 'opaque-id', canUnlink: false })
  expect(project([{ id: 'one' }, { id: 'two' }], true, true)).toEqual({ state: 'unavailable' })
})

test('Google step-up verifies the stored signature, challenge, origin, RP, signed UV and advancing counter', async () => {
  const api = await import('../../src/modules/auth/google-account.server')
  const verify = Reflect.get(api, 'verifyGoogleAccountAssertion')
  expect(typeof verify).toBe('function')
  const key = registrationCredentialFixture({ challenge: 'registration-challenge', rp: { id: 'app.example.test' } }, origin)
  const registration = await verifyRegistrationResponse({ response: { ...key.response, response: { ...key.response.response, transports: ['internal'] } }, expectedChallenge: 'registration-challenge', expectedOrigin: origin, expectedRPID: 'app.example.test', requireUserVerification: true })
  expect(registration.verified).toBe(true)
  const stored = { credentialID: key.response.id, publicKey: Buffer.from(registration.registrationInfo!.credential.publicKey).toString('base64'), counter: 1 }
  const options = { challenge: 'link-challenge', rpId: 'app.example.test' }
  expect(await verify(stored, options.challenge, key.authenticationResponse(options, { counter: 2 }), origin)).toBe(2)
  for (const wrong of [{ uv: false }, { up: false }, { origin: 'https://other.example.test' }, { rpId: 'other.example.test' },
    { challenge: 'another-challenge' }, { type: 'webauthn.create' }, { counter: 1 }]) {
    await expect(verify(stored, options.challenge, key.authenticationResponse(options, { counter: 2, ...wrong }), origin)).rejects.toThrow('Authentication rejected')
  }
  const different = registrationCredentialFixture({ challenge: 'registration-challenge', rp: { id: 'app.example.test' } }, origin)
  await expect(verify(stored, options.challenge, different.authenticationResponse(options, { counter: 2 }), origin)).rejects.toThrow('Authentication rejected')
})

test('historical Google receipts have no Account or passkey cascade and remain auth-scoped', async () => {
  const tables = await import('../../src/modules/auth/schema.server')
  const table = Reflect.get(tables, 'googleAccountIntent')
  expect(table).toBeDefined()
  const config = getTableConfig(table)
  expect(config.enableRLS).toBe(true)
  expect(config.foreignKeys.map(key => getTableConfig(key.reference().foreignTable).name).sort()).toEqual(['session', 'user'])
  expect(config.policies.length).toBe(1)
})

test('authority binds the original session, Workspace and immutable deadline while receipts outlive the proof', async () => {
  const api = await import('../../src/modules/auth/google-account.server')
  const check = Reflect.get(api, 'checkGoogleAccountState')
  const status = Reflect.get(api, 'googleAccountStatus')
  expect(typeof check).toBe('function'); expect(typeof status).toBe('function')
  const now = new Date('2030-01-03T00:00:00Z'), created = new Date(now.getTime() - 1000)
  const state = { user: { id: 'u1', recoveryGeneration: 2, recovering: false, holdUntil: null, name: 'Owner', email: 'owner@example.test', emailVerified: true, image: null, createdAt: created, updatedAt: created },
    session: { id: 's1', userId: 'u1', authState: 'ACTIVE', recoveryGeneration: 2, expiresAt: new Date(now.getTime() + 86400000),
      token: 'fixture-token', createdAt: created, updatedAt: created, ipAddress: null, userAgent: null, authMethod: 'passkey', providerIdentity: null,
      authenticatedAt: new Date('2030-01-01T00:00:00Z'), lastActivityAt: new Date(now.getTime() - 1000) },
    workspaceId: 'w1', intent: { id: 'i1', action: 'LINK' as const, userId: 'u1', sessionId: 's1', recoveryGeneration: 2,
      locale: 'en' as const, targetAccountId: null, targetSubject: null, authenticationChallenge: null, authorizingKeyId: 'key1', authorizingCredentialId: 'credential1', authorizingPublicKey: 'public-key', oauthState: 'state1', nativeAccountId: null, providerSubject: null, outcome: null,
      workspaceId: 'w1', createdAt: created, expiresAt: new Date(now.getTime() + 299000), phase: 'AUTHORIZED' as const, reason: null } }
  expect(() => check(state, now, false)).not.toThrow()
  for (const changed of [
    { ...state, session: { ...state.session, id: 'another-same-user-session' } },
    { ...state, workspaceId: 'w2' }, { ...state, user: { ...state.user, recoveryGeneration: 3 } },
    { ...state, user: { ...state.user, recovering: true } }, { ...state, user: { ...state.user, holdUntil: new Date(now.getTime() + 1) } },
    { ...state, session: { ...state.session, authState: 'MFA_PENDING' } },
    { ...state, session: { ...state.session, lastActivityAt: new Date(now.getTime() - 43200000) } },
    { ...state, session: { ...state.session, authenticatedAt: new Date(now.getTime() - 604800000) } },
  ]) expect(() => check(changed, now, false)).toThrow('Authentication rejected')
  expect(() => check(state, state.intent.expiresAt, false)).toThrow()
  const receipt = { ...state, intent: { ...state.intent, phase: 'CONSUMED' as const, nativeAccountId: 'old-deleted-account', providerSubject: 'exact-subject', outcome: 'linked' as const } }
  const later = new Date(now.getTime() + 600000)
  expect(() => check(receipt, later, true)).not.toThrow()
  expect(status(receipt.intent, later)).toEqual({ intentId: 'i1', action: 'LINK', state: 'linked', expiresAt: state.intent.expiresAt.toISOString(), reason: null })
  expect(() => check(receipt, new Date(created.getTime() + 86400000), true)).toThrow()
})

test('Google inputs preserve opaque Account ids and reject posted identity, purpose and proof authority', async () => {
  const modules = import.meta.glob('../../src/modules/auth/google-account.server.ts')
  const load = modules['../../src/modules/auth/google-account.server.ts']
  expect(typeof load).toBe('function')
  const api = await load() as { validateGoogleAccountTarget(input: unknown): unknown; validateGoogleAccountUnlink(input: unknown): unknown;
    validateGoogleAccountAssertion(input: unknown): unknown }
  const intentId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  const key = registrationCredentialFixture({ challenge: 'fixture', rp: { id: 'app.example.test' } }, origin)
  const response = key.authenticationResponse({ challenge: 'fixture', rpId: 'app.example.test' })
  expect(api.validateGoogleAccountUnlink({ accountId: 'native_account/non-uuid' })).toEqual({ accountId: 'native_account/non-uuid' })
  expect(api.validateGoogleAccountTarget({ intentId })).toEqual({ intentId })
  expect(api.validateGoogleAccountAssertion({ intentId, response })).toEqual({ intentId, response })
  for (const extra of [{ userId: 'posted' }, { sessionId: 'posted' }, { purpose: 'LINK' }, { provider: 'google' }, { workspaceId: intentId }, { redirect: origin }, { publicKey: 'AQ' }]) {
    expect(() => api.validateGoogleAccountUnlink({ accountId: 'native-id', ...extra })).toThrow('Authentication rejected')
    expect(() => api.validateGoogleAccountTarget({ intentId, ...extra })).toThrow('Authentication rejected')
    expect(() => api.validateGoogleAccountAssertion({ intentId, response, ...extra })).toThrow('Authentication rejected')
  }
  expect(() => api.validateGoogleAccountUnlink({ accountId: '' })).toThrow()
  expect(() => api.validateGoogleAccountAssertion({ intentId, response: { ...response, response: { ...response.response, uv: true } } })).toThrow()
})

test.each(commands)('%s charges the limiter before decoding or protected effects, including without Google configuration', async command => {
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'google-account-source', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(new AuthAttemptExceeded(17))
  const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, limiter)
  try {
    const method = Reflect.get(app, command)
    expect(typeof method).toBe('function')
    const callback = command === 'completeGoogleAccountLinkOAuth'
    const request = Object.assign(new Request(origin + (callback ? '/api/auth/account/google/callback?state=bad' : '/account-command'), {
      method: callback ? 'GET' : 'POST', headers: { ...(callback ? {} : { origin }), 'sec-fetch-site': callback ? 'cross-site' : 'same-origin', 'x-real-ip': '192.0.2.41' },
    }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    const error = await method(request, { userId: 'forbidden' }).catch((error: unknown) => error)
    expect(limiter.errorResponse(error)?.status).toBe(429)
    expect(checkouts).toBe(0)
    expect(consume).toHaveBeenCalledExactlyOnceWith(command, expect.anything())
  } finally { await app.close(); await limiter.close() }
})
