import { randomBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { AuthAttemptExceeded, createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { authSessionRevocation } from '../../src/modules/auth/schema.server'
import * as api from '../../src/modules/auth/session-management.server'

const origin = 'https://app.example.test'
const commands = ['beginSessionRevocation', 'finishSessionRevocation', 'beginSessionList', 'finishSessionList'] as const

test.each(commands)('%s charges the canonical limiter before malformed input or protected effects', async command => {
  let checkouts = 0
  const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'session-management-source', TRUSTED_PROXY_IPS: '127.0.0.1' }))
  const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(new AuthAttemptExceeded(17))
  const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, limiter)
  try {
    const method = app[command]
    const request = Object.assign(new Request(origin + '/account-command', {
      method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'x-real-ip': '192.0.2.41' },
    }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    const error = await method(request, { userId: 'forbidden' }).catch((error: unknown) => error)
    expect(limiter.errorResponse(error)?.status).toBe(429)
    expect(checkouts).toBe(0)
    expect(consume).toHaveBeenCalledExactlyOnceWith(command, expect.anything())
  } finally { await app.close(); await limiter.close() }
})

test('revocation accepts only an opaque target or a strict signed assertion envelope', async () => {
  const challengeId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  const key = registrationCredentialFixture({ challenge: 'fixture', rp: { id: 'app.example.test' } }, origin)
  const response = key.authenticationResponse({ challenge: 'fixture', rpId: 'app.example.test' })
  expect(api.validateSessionRevocation({ sessionId: 'native_session/non-uuid' })).toEqual({ sessionId: 'native_session/non-uuid' })
  expect(api.validateSessionManagementFinish({ challengeId, response })).toEqual({ challengeId, response })
  for (const extra of [{ userId: 'posted' }, { token: 'posted' }, { purpose: 'REVOKE' }, { workspaceId: challengeId }]) {
    expect(() => api.validateSessionRevocation({ sessionId: 'target', ...extra })).toThrow('Authentication rejected')
    expect(() => api.validateSessionManagementFinish({ challengeId, response, ...extra })).toThrow('Authentication rejected')
  }
  for (const sessionId of ['', 'x'.repeat(1025)]) expect(() => api.validateSessionRevocation({ sessionId })).toThrow()
  expect(() => api.validateSessionManagementFinish({ challengeId: 'not-uuid', response })).toThrow()
  expect(() => api.validateSessionManagementFinish({ challengeId, response: { ...response, response: { ...response.response, uv: true } } })).toThrow()
})

test('session management allows a valid older session during hold while refusing lost authority and fixed deadline expiry', async () => {
  const now = new Date('2030-01-03T00:00:00Z'), created = new Date('2030-01-01T00:00:00Z')
  const state = { user: { id: 'u1', recoveryGeneration: 2, recovering: false, holdUntil: new Date('2030-01-04T00:00:00Z') },
    session: { id: 's1', userId: 'u1', authState: 'ACTIVE', recoveryGeneration: 2, expiresAt: new Date('2030-01-08T00:00:00Z'),
      createdAt: created, authenticatedAt: created, lastActivityAt: new Date('2030-01-02T23:59:00Z') }, workspaceId: 'w1' }
  expect(() => api.checkSessionManagementState(state, now)).not.toThrow()
  const expiresAt = new Date('2030-01-03T00:05:00Z')
  const proof: api.SessionManagementProof = { version: 1, userId: 'u1', sessionId: 's1', recoveryGeneration: 2, workspaceId: 'w1', action: 'REVOKE',
    targetSessionId: 's2', challenge: 'challenge', expiresAt: expiresAt.toISOString() }
  expect(() => api.checkSessionManagementState(state, now, proof)).not.toThrow()
  for (const changed of [
    { ...state, session: { ...state.session, id: 'another' } }, { ...state, workspaceId: 'w2' },
    { ...state, user: { ...state.user, recoveryGeneration: 3 } }, { ...state, user: { ...state.user, recovering: true } },
    { ...state, session: { ...state.session, authState: 'MFA_PENDING' } }, { ...state, session: { ...state.session, authState: 'RECOVERY_RESTRICTED' } },
    { ...state, session: { ...state.session, expiresAt: now } },
    { ...state, session: { ...state.session, lastActivityAt: new Date('2030-01-02T12:00:00Z') } },
    { ...state, session: { ...state.session, authenticatedAt: new Date('2029-12-27T00:00:00Z') } },
  ]) expect(() => api.checkSessionManagementState(changed, now, proof)).toThrow('Authentication rejected')
  expect(() => api.checkSessionManagementState({ ...state, session: { ...state.session, lastActivityAt: expiresAt } }, expiresAt, proof)).toThrow()
})

test('native completion rejects error Responses and unexpected success shapes before owner commit', async () => {
  expect(api.validateSessionManagementNativeResult({ response: { completed: true }, headers: new Headers() })).toEqual({ completed: true })
  for (const value of [new Response('error', { status: 500 }), new Response('ok'), { response: new Response('error', { status: 500 }), headers: new Headers() },
    { response: { completed: false }, headers: new Headers() }, { response: { completed: true, token: 'unexpected' }, headers: new Headers() },
    { response: { completed: true }, headers: {} }]) expect(() => api.validateSessionManagementNativeResult(value)).toThrow('Authentication unavailable')
})

test('revocation facts survive parent closure and expose only an auth-scoped INSERT policy', async () => {
  const config = getTableConfig(authSessionRevocation)
  expect(config.enableRLS).toBe(true)
  expect(config.foreignKeys).toEqual([])
  expect(config.policies.map(policy => policy.for)).toEqual(['insert'])
  expect(config.columns.map(column => column.name).sort()).toEqual(['actor_user_id', 'authorizing_session_id', 'correlation_id', 'id', 'occurred_at', 'target_session_id', 'workspace_id'])
})

test('LIST binds only optional opaque cursor and exact reconciliation selectors', () => {
  const decode = api.validateSessionList
  expect(decode({})).toEqual({})
  expect(decode({ cursor: 'native/cursor', reconcileSessionId: 'target/not-on-page' })).toEqual({ cursor: 'native/cursor', reconcileSessionId: 'target/not-on-page' })
  for (const input of [{ cursor: '' }, { cursor: 'x'.repeat(1025) }, { reconcileSessionId: '' }, { cursor: 'row', userId: 'posted' }, { page: 2 }, { purpose: 'LIST' }]) {
    expect(() => decode(input)).toThrow('Authentication rejected')
  }
})

test('session page exposes five fields and uses row25 as cursor while exact target state stays independent', () => {
  const project = api.projectSessionPage
  const date = new Date('2030-01-01T00:00:00Z')
  const rows = Array.from({ length: 26 }, (_, n) => ({ id: 'row-' + (n + 1), current: n === 0, createdAt: date, lastActivityAt: date, expiresAt: date,
    token: 'never-publish', userId: 'private', authMethod: 'passkey' }))
  const result = project(rows, 'active')
  expect(result.sessions.length).toBe(25); expect(result.nextCursor).toBe('row-25'); expect(result.targetState).toBe('active')
  expect(result.sessions[0]).toEqual({ id: 'row-1', current: true, createdAt: date.toISOString(), lastActivityAt: date.toISOString(), expiresAt: date.toISOString() })
  expect(project(rows.slice(0, 25), 'ineligible').nextCursor).toBeNull()
  expect(project([], 'absent')).toEqual({ sessions: [], nextCursor: null, targetState: 'absent' })
})

test('cleanup only admits a strict expired same-User singleton and skips duplicate/malformed/live groups', () => {
  const candidate = api.sessionManagementCleanupCandidate
  const now = new Date('2030-01-01T00:00:00Z'), expiresAt = new Date('2029-12-31T23:59:59Z')
  const proof = { version: 1, userId: 'u1', sessionId: 's1', workspaceId: 'f1307f5a-34b8-48e4-a62e-9b86d38746e0', recoveryGeneration: 0,
    action: 'REVOKE', targetSessionId: 's2', challenge: 'challenge', expiresAt: expiresAt.toISOString() }
  const row = { id: 'verification', identifier: 'application-session-v1:7531:f1307f5a-34b8-48e4-a62e-9b86d38746e0', value: JSON.stringify(proof), expiresAt }
  expect(candidate([row], 'u1', now)).toEqual(row)
  expect(candidate([row, { ...row, id: 'duplicate' }], 'u1', now)).toBeUndefined()
  for (const changed of [
    { ...row, expiresAt: now }, { ...row, value: '{}' }, { ...row, value: JSON.stringify({ ...proof, action: 'LINK' }) },
    { ...row, value: JSON.stringify({ ...proof, userId: 'foreign' }) }, { ...row, value: JSON.stringify({ ...proof, extra: true }) },
    { ...row, identifier: 'foreign:' + row.identifier }, { ...row, identifier: 'application-session-v1:7531:not-uuid' },
  ]) expect(candidate([changed], 'u1', now)).toBeUndefined()
  expect(candidate([row], 'foreign', now)).toBeUndefined()
})
