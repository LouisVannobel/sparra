import { expect, test } from 'vitest'
import { privateLoginFailureCategory, privateLoginPageErrorCategory, privateLoginReportLine, type PrivateLoginFailure, type PrivateLoginState } from '../helpers/private-login-bootstrap-diagnostic'

test('private login admits only exact network codes and closed page error categories', () => {
  expect(privateLoginFailureCategory('net::ERR_NETWORK_CHANGED')).toBe('network-changed')
  expect(privateLoginFailureCategory('net::ERR_NETWORK_CHANGED https://private.invalid/#proof')).toBe('other')
  expect(privateLoginFailureCategory('net::ERR_CONNECTION_RESET')).toBe('connection')
  expect(privateLoginFailureCategory(null)).toBe('other')
  expect(privateLoginPageErrorCategory('Failed to fetch dynamically imported module: https://private.invalid/email@example.test#proof')).toBe('module-load')
  expect(privateLoginPageErrorCategory('Minified React error #418; private-token')).toBe('hydration')
  expect(privateLoginPageErrorCategory('email@example.test#private-token')).toBe('other')
})

test('private login report reconstructs closed fields without serializing private extras or toJSON', () => {
  const failure = { exception: 'TimeoutError', snapshotUnavailable: false,
    bootstrap: { pageErrors: ['module-load'], scriptResponses: [{ sameOrigin: true, status: 'success' }], scriptFailures: ['network-changed'], truncated: false } } satisfies PrivateLoginFailure
  const state = { buttonCount: 1, nativeDisabled: true, matchesDisabled: true, ariaDisabled: false, documentState: 'complete',
    startOptionsPresent: true, bootstrapPresent: true, coreHydrationFinalized: false, streamEnded: true, routerPresent: false, routerLoading: false,
    googleUnavailable: false, csp: { script: 1, style: 0, connect: 0, other: 0 } } satisfies PrivateLoginState
  for (const object of [failure, failure.bootstrap, failure.bootstrap.scriptResponses[0], state, state.csp]) {
    Object.defineProperty(object, 'toJSON', { get() { throw new Error('private getter accessed') } })
    Object.defineProperty(object, 'privateValue', { value: 'https://private.invalid/email@example.test#proof', enumerable: true })
  }
  const line = privateLoginReportLine(failure, state)
  expect(line.startsWith('PRIVATE_LOGIN_BOOTSTRAP_DIAGNOSTIC ')).toBe(true)
  expect(line).not.toContain('private.invalid')
  expect(line).not.toContain('toJSON')
  expect(JSON.parse(line.slice('PRIVATE_LOGIN_BOOTSTRAP_DIAGNOSTIC '.length))).toEqual({
    exception: 'TimeoutError', snapshotUnavailable: false,
    bootstrap: { pageErrors: ['module-load'], scriptResponses: [{ sameOrigin: true, status: 'success' }], scriptFailures: ['network-changed'], truncated: false },
    state: { buttonCount: 1, nativeDisabled: true, matchesDisabled: true, ariaDisabled: false, documentState: 'complete',
      startOptionsPresent: true, bootstrapPresent: true, coreHydrationFinalized: false, streamEnded: true, routerPresent: false, routerLoading: false,
      googleUnavailable: false, csp: { script: 1, style: 0, connect: 0, other: 0 } },
  })
})

test('private login bounds reports and refuses corrupted values while retaining snapshot failure', () => {
  const failure = { exception: 'Error', snapshotUnavailable: true,
    bootstrap: { pageErrors: Array.from({ length: 40 }, () => 'other' as const),
      scriptResponses: Array.from({ length: 40 }, () => ({ sameOrigin: false, status: 'other' as const })),
      scriptFailures: Array.from({ length: 40 }, () => 'other' as const), truncated: false } } satisfies PrivateLoginFailure
  const state = { buttonCount: 900, nativeDisabled: null, matchesDisabled: null, ariaDisabled: null, documentState: 'loading',
    startOptionsPresent: false, bootstrapPresent: false, coreHydrationFinalized: false, streamEnded: false, routerPresent: false, routerLoading: false,
    googleUnavailable: false, csp: { script: -1, style: Infinity, connect: 0, other: 900 } } satisfies PrivateLoginState
  const privateValue = 'email@example.test#private-proof'
  for (const [object, key] of [[failure, 'exception'], [failure.bootstrap.pageErrors, '0'], [failure.bootstrap.scriptResponses[0], 'status'],
    [failure.bootstrap.scriptFailures, '0'], [state, 'documentState'], [state, 'nativeDisabled']] as const) Object.defineProperty(object, key, { value: privateValue })
  const line = privateLoginReportLine(failure, state)
  expect(line).not.toContain(privateValue)
  const payload = JSON.parse(line.slice('PRIVATE_LOGIN_BOOTSTRAP_DIAGNOSTIC '.length))
  expect(payload.exception).toBe('other')
  expect(payload.snapshotUnavailable).toBe(true)
  expect(payload.bootstrap.pageErrors).toHaveLength(16)
  expect(payload.bootstrap.scriptResponses).toHaveLength(16)
  expect(payload.bootstrap.scriptFailures).toHaveLength(16)
  expect(payload.bootstrap.truncated).toBe(true)
  expect(payload.state).toEqual({ buttonCount: 255, nativeDisabled: null, matchesDisabled: null, ariaDisabled: null, documentState: 'other',
    startOptionsPresent: false, bootstrapPresent: false, coreHydrationFinalized: false, streamEnded: false, routerPresent: false, routerLoading: false,
    googleUnavailable: false, csp: { script: null, style: null, connect: 0, other: 255 } })
  expect(JSON.parse(privateLoginReportLine(failure).slice('PRIVATE_LOGIN_BOOTSTRAP_DIAGNOSTIC '.length)).state).toBeNull()
})
