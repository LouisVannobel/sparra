import { randomBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { AuthAttemptExceeded, createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { recoveryAttempt, recoveryCode, recoveryCodeBatch, recoveryCodeRotationFact } from '../../src/modules/auth/schema.server'
import { decodeRecoveryCode, digestRecoveryCode, issueRecoveryCodes, validateRecoveryGoogleBegin,
  validateRecoveryRotationFinish, checkRecoveryGoogleUser, recoveryGoogleCleanupCandidate, assertRecoveryAttemptBinding } from '../../src/modules/auth/recovery.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { validateRecoverySessionResult, validateRecoveryStateHeaders, classifyRecoveryFailure } from '../../src/modules/auth/recovery-native.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'

const origin = 'https://app.example.test'
const operations = ['beginRecoveryCodeRotation', 'finishRecoveryCodeRotation', 'beginRecoveryGoogleProof', 'completeRecoveryGoogleProof'] as const

test('codes decode canonically and digest without storing the submitted spelling', () => {
  expect(digestRecoveryCode('rc1_' + 'A'.repeat(27))).toBe('d2aa97cf0cc0f1704a4a206cbd9397a31636853b8010f570b667dcc4651c20ba')
  const issued = issueRecoveryCodes()
  expect(issued).toHaveLength(8)
  expect(new Set(issued)).toHaveProperty('size', 8)
  for (const code of issued) {
    expect(/^rc1_[A-Za-z0-9_-]{27}$/.test(code)).toBe(true)
    expect(decodeRecoveryCode(code)).toHaveLength(20)
    expect(digestRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/)
    expect(digestRecoveryCode(code).includes(code)).toBe(false)
  }
  for (const wrong of ['RC1_' + 'A'.repeat(27), 'rc1_' + 'A'.repeat(26) + 'B', 'rc1_' + 'A'.repeat(26),
    'rc1_' + 'A'.repeat(26) + '=', 'rc1_' + 'A'.repeat(26) + '+']) expect(() => decodeRecoveryCode(wrong)).toThrow('Authentication rejected')
  const normalized = validateRecoveryGoogleBegin({ email: ' OWNER@EXAMPLE.TEST ', code: issued[0] })
  expect(normalized.email).toBe('owner@example.test')
  expect(normalized.code === issued[0]).toBe(true)
  expect(() => validateRecoveryGoogleBegin({ email: 'owner@example.test', code: issued[0], userId: 'forbidden' })).toThrow('Authentication rejected')
})

test('recovery authority uses a current batch, immutable attempts and insert-only facts', () => {
  const batch = getTableConfig(recoveryCodeBatch), code = getTableConfig(recoveryCode)
  const attempt = getTableConfig(recoveryAttempt), fact = getTableConfig(recoveryCodeRotationFact)
  expect(batch.enableRLS).toBe(true)
  expect(code.enableRLS).toBe(true)
  expect(attempt.enableRLS).toBe(true)
  expect(fact.enableRLS).toBe(true)
  expect(code.foreignKeys).toHaveLength(1)
  expect(code.foreignKeys[0].reference().foreignTable).toBe(recoveryCodeBatch)
  expect(attempt.foreignKeys.map(key => key.reference().foreignTable)).not.toContain(recoveryCodeBatch)
  expect(attempt.foreignKeys.map(key => key.reference().foreignTable)).not.toContain(recoveryCode)
  expect(fact.foreignKeys).toEqual([])
  expect(fact.policies.map(policy => policy.for)).toEqual(['insert'])
})

test('rotation accepts only a challenge UUID and a strict signed assertion envelope', () => {
  const challengeId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  const key = registrationCredentialFixture({ challenge: 'fixture', rp: { id: 'app.example.test' } }, origin)
  const response = key.authenticationResponse({ challenge: 'fixture', rpId: 'app.example.test' })
  const value = validateRecoveryRotationFinish({ challengeId, response })
  expect(value.challengeId).toBe(challengeId)
  expect(value.response.id === response.id).toBe(true)
  for (const bad of [{ challengeId: 'bad', response }, { challengeId, response, userId: 'posted' },
    { challengeId, response: { ...response, response: { ...response.response, uv: true } } }])
    expect(() => validateRecoveryRotationFinish(bad)).toThrow('Authentication rejected')
})

test('native rotation session reader refuses every emitted cookie and error Response', () => {
  const ambient = { user: { id: 'u1' }, session: { id: 's1' } }
  expect(validateRecoverySessionResult({ response: ambient, headers: new Headers() })).toEqual(ambient)
  for (const bad of [new Response('error', { status: 500 }), { response: ambient, headers: new Headers({ 'set-cookie': 'session=unexpected' }) },
    { response: ambient, headers: new Headers({ location: origin + '/login' }) }, { response: null, headers: new Headers() }])
    expect(() => validateRecoverySessionResult(bad)).toThrow('Authentication unavailable')
})

test('native state publication requires exact cookie attributes and no auxiliary cookie', () => {
  const name = '__Secure-better-auth.state'
  const begin = new Headers({ 'set-cookie': name + '=fixture; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax' })
  expect(validateRecoveryStateHeaders(begin, name, 'begin').getSetCookie().length).toBe(1)
  const cleared = new Headers({ 'set-cookie': name + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax' })
  expect(validateRecoveryStateHeaders(cleared, name, 'complete').getSetCookie().length).toBe(1)
  for (const bad of [new Headers({ 'set-cookie': name + '=fixture; Max-Age=300; Path=/; Secure; SameSite=Lax' }),
    new Headers({ 'set-cookie': name + '=fixture; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=example.test' }),
    new Headers([['set-cookie', name + '=fixture; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax'], ['set-cookie', '__Secure-better-auth.session_token=fixture']])])
    expect(() => validateRecoveryStateHeaders(bad, name, 'begin')).toThrow('Authentication unavailable')
})

test('linked Google code admission does not invent an emailVerified factor', () => {
  expect(() => checkRecoveryGoogleUser({ recovering: false, emailVerified: false })).not.toThrow()
  expect(() => checkRecoveryGoogleUser({ recovering: true, emailVerified: true })).toThrow('Authentication rejected')
})

test('cleanup leaves a malformed native state singleton untouched', () => {
  const attempt = { id: 'f1307f5a-34b8-48e4-a62e-9b86d38746e0', userId: 'u1', recoveryGeneration: 0,
    batchId: 'a1307f5a-34b8-48e4-a62e-9b86d38746e0', codeId: 'b1307f5a-34b8-48e4-a62e-9b86d38746e0',
    googleAccountId: 'account1', issuer: 'https://accounts.google.com', subject: 'subject1', oauthState: 'state1',
    createdAt: new Date('2030-01-01T00:00:00Z'), expiresAt: new Date('2030-01-01T00:05:00Z'), phase: 'PENDING_GOOGLE' }
  const state = { identifier: 'state1', expiresAt: new Date('2030-01-01T00:10:00Z'),
    value: JSON.stringify({ oauthState: 'state1', callbackURL: origin + '/login', errorURL: origin + '/login',
      codeVerifier: 'verifier', idTokenNonce: 'nonce', expiresAt: Date.parse('2030-01-01T00:10:00Z'),
      serverContext: { purpose: 'recovery-google-proof', attemptId: attempt.id } }) }
  expect(recoveryGoogleCleanupCandidate(attempt, [], [state], origin)).toBe(true)
  expect(recoveryGoogleCleanupCandidate(attempt, [], [{ ...state, value: state.value.replace('"nonce"', 'true') }], origin)).toBe(false)
  expect(recoveryGoogleCleanupCandidate(attempt, [], [state, state], origin)).toBe(false)
})

test('rechecks retain immutable attempt bindings across an explicit phase transition', () => {
  const attempt = { id: 'i1', userId: 'u1', recoveryGeneration: 1, batchId: 'b1', codeId: 'c1', googleAccountId: 'a1',
    issuer: 'https://accounts.google.com', subject: 'subject1', oauthState: 'state1',
    createdAt: new Date('2030-01-01T00:00:00Z'), expiresAt: new Date('2030-01-01T00:05:00Z'), phase: 'PENDING_GOOGLE' }
  expect(() => assertRecoveryAttemptBinding(attempt, { ...attempt, phase: 'EXCHANGING' }, 'EXCHANGING')).not.toThrow()
  for (const changed of [{ ...attempt, subject: 'retargeted', phase: 'EXCHANGING' },
    { ...attempt, expiresAt: new Date('2030-01-01T00:06:00Z'), phase: 'EXCHANGING' },
    { ...attempt, phase: 'PROVED' }]) expect(() => assertRecoveryAttemptBinding(attempt, changed, 'EXCHANGING')).toThrow('Authentication rejected')
})

test('raw native failures use fixed categories and preserve unknown transaction outcome', () => {
  const opaque = 'fixture-secret-canary'
  const unavailable = classifyRecoveryFailure(new Error(opaque), 'before-commit')
  expect(unavailable.message).toBe('Authentication unavailable')
  expect(unavailable.message.includes(opaque)).toBe(false)
  const late = classifyRecoveryFailure(new Error(opaque), 'after-confirmed-commit')
  expect(late.message).toBe('Authentication outcome unconfirmed')
  const unknown = classifyRecoveryFailure(new PgTransactionError('finalize', 'unknown', 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'), 'before-commit')
  expect(unknown instanceof PgTransactionError).toBe(true)
  if (!(unknown instanceof PgTransactionError)) throw new Error('Transaction classification changed')
  expect(unknown.outcome).toBe('unknown')
})

test.each(operations)('%s charges its own limiter before input decoding or database work', async operation => {
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'recovery-source', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(new AuthAttemptExceeded(17))
  const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, limiter)
  try {
    const callback = operation === 'completeRecoveryGoogleProof'
    const request = Object.assign(new Request(origin + (callback ? '/api/auth/recovery/google/callback?state=bad' : '/account-command'), {
      method: callback ? 'GET' : 'POST', headers: { ...(callback ? {} : { origin }), 'sec-fetch-site': callback ? 'cross-site' : 'same-origin', 'x-real-ip': '192.0.2.41' },
    }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    const call = () => {
      switch (operation) {
        case 'beginRecoveryCodeRotation': return app.beginRecoveryCodeRotation(request)
        case 'finishRecoveryCodeRotation': return app.finishRecoveryCodeRotation(request, { userId: 'forbidden' })
        case 'beginRecoveryGoogleProof': return app.beginRecoveryGoogleProof(request, { userId: 'forbidden' })
        case 'completeRecoveryGoogleProof': return app.completeRecoveryGoogleProof(request)
      }
    }
    const error = await call().catch((failure: unknown) => failure)
    expect(limiter.errorResponse(error)?.status).toBe(429)
    expect(checkouts).toBe(0)
    expect(consume).toHaveBeenCalledExactlyOnceWith(operation, expect.anything())
  } finally { await app.close(); await limiter.close() }
})
