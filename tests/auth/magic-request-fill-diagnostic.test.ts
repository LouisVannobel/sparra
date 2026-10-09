import { expect, test } from 'vitest'
import { fillExceptionCategory, bootstrapResponseCategory, bootstrapFailureCategory, cspCategory, requestFillReportLine, type RequestFillFailure, type RequestFillState } from '../helpers/magic-request-fill-diagnostic'

test('fill exception projection recognizes native categories without accessing private details or getters', () => {
  for (const name of ['TimeoutError', 'TargetClosedError', 'Error', 'SensitivePrivateType']) {
    const error = Object.create(Error.prototype)
    Object.defineProperty(error, 'name', { value: name })
    for (const key of ['message', 'stack', 'cause', 'toJSON']) Object.defineProperty(error, key, { get() { throw new Error('private getter accessed') } })
    expect(fillExceptionCategory(error)).toBe(name === 'SensitivePrivateType' ? 'other' : name)
  }
  expect(fillExceptionCategory(null)).toBe('other')
  expect(fillExceptionCategory('https://private.invalid/#secret')).toBe('other')
  expect(fillExceptionCategory(Object.defineProperty({}, 'name', { get() { throw new Error('getter') } }))).toBe('other')
})

test('script response projection discards private URL values and maps only status classes', () => {
  expect(bootstrapResponseCategory('https://localhost:443/assets/private.js?token=secret#proof', 'https://localhost:443', 200)).toEqual({ sameOrigin: true, status: 'success' })
  expect(bootstrapResponseCategory('https://private.invalid/email@example.test', 'https://localhost', 404)).toEqual({ sameOrigin: false, status: 'client-error' })
  for (const [status, category] of [[302, 'redirect'], [503, 'server-error'], [0, 'other'], [Infinity, 'other']] as const) {
    expect(bootstrapResponseCategory('malformed', 'https://localhost', status)).toEqual({ sameOrigin: false, status: category })
  }
})

test('network failure projection admits exact native codes and rejects appended private data', () => {
  for (const [code, category] of [['net::ERR_ABORTED', 'aborted'], ['net::ERR_CONNECTION_REFUSED', 'connection'], ['net::ERR_CERT_AUTHORITY_INVALID', 'certificate'], ['net::ERR_BLOCKED_BY_CLIENT', 'blocked']] as const) expect(bootstrapFailureCategory(code)).toBe(category)
  expect(bootstrapFailureCategory('net::ERR_ABORTED https://private.invalid/#proof')).toBe('other')
  expect(bootstrapFailureCategory(null)).toBe('other')
})

test('CSP projection records directive categories and never arbitrary directive strings', () => {
  for (const [directive, category] of [['script-src-elem', 'script'], ['style-src', 'style'], ['connect-src', 'connect'], ['frame-src', 'other'], ['script-src private-token', 'other']] as const) expect(cspCategory(directive)).toBe(category)
})

test('native report line reconstructs only the closed failure and actionability fields', () => {
  const failure = { exception: 'TimeoutError', pageClosed: false, contextClosed: false, snapshotUnavailable: false,
    bootstrap: { pageErrors: 1, consoleErrors: 0, scriptResponses: [{ sameOrigin: true, status: 'success' }], scriptFailures: ['blocked'], truncated: false } } satisfies RequestFillFailure
  const state = { fieldCount: 1, visible: true, enabled: false, nativeDisabled: true, readOnly: false, formBusy: false,
    sameLoginRoute: true, emptyFragment: true, firstRouterClean: false, routerPresent: false,
    csp: { script: 1, style: 0, connect: 0, other: 0 } } satisfies RequestFillState
  for (const object of [failure, failure.bootstrap, failure.bootstrap.scriptResponses[0], state, state.csp]) {
    Object.defineProperty(object, 'toJSON', { get() { throw new Error('private serialization getter accessed') } })
    Object.defineProperty(object, 'privateUrl', { value: 'https://private.invalid/email@example.test#proof', enumerable: true })
  }
  const line = requestFillReportLine(failure, state)
  expect(line.startsWith('MAGIC_REQUEST_FILL_DIAGNOSTIC ')).toBe(true)
  expect(line).not.toContain('private.invalid')
  expect(line).not.toContain('toJSON')
  expect(JSON.parse(line.slice('MAGIC_REQUEST_FILL_DIAGNOSTIC '.length))).toEqual({
    exception: 'TimeoutError', pageClosed: false, contextClosed: false, snapshotUnavailable: false,
    bootstrap: { pageErrors: 1, consoleErrors: 0, scriptResponses: [{ sameOrigin: true, status: 'success' }], scriptFailures: ['blocked'], truncated: false },
    state: { fieldCount: 1, visible: true, enabled: false, nativeDisabled: true, readOnly: false, formBusy: false,
      sameLoginRoute: true, emptyFragment: true, firstRouterClean: false, routerPresent: false,
      csp: { script: 1, style: 0, connect: 0, other: 0 } },
  })
})

test('native report line caps counts and arrays and rejects corrupted string categories', () => {
  const failure = { exception: 'Error', pageClosed: true, contextClosed: true, snapshotUnavailable: true,
    bootstrap: { pageErrors: 900, consoleErrors: -1, scriptResponses: Array.from({ length: 40 }, () => ({ sameOrigin: true, status: 'success' as const })),
      scriptFailures: Array.from({ length: 40 }, () => 'aborted' as const), truncated: false } } satisfies RequestFillFailure
  const privateValue = 'email@example.test#private-proof'
  Object.defineProperty(failure, 'exception', { value: privateValue })
  Object.defineProperty(failure.bootstrap.scriptResponses[0], 'status', { value: privateValue })
  Object.defineProperty(failure.bootstrap.scriptFailures, '0', { value: privateValue })
  const line = requestFillReportLine(failure)
  expect(line).not.toContain(privateValue)
  const payload = JSON.parse(line.slice('MAGIC_REQUEST_FILL_DIAGNOSTIC '.length))
  expect(payload.exception).toBe('other')
  expect(payload.bootstrap.pageErrors).toBe(255)
  expect(payload.bootstrap.consoleErrors).toBeNull()
  expect(payload.bootstrap.scriptResponses).toHaveLength(16)
  expect(payload.bootstrap.scriptResponses[0]).toEqual({ sameOrigin: true, status: 'other' })
  expect(payload.bootstrap.scriptFailures).toHaveLength(16)
  expect(payload.bootstrap.scriptFailures[0]).toBe('other')
  expect(payload.bootstrap.truncated).toBe(true)
  expect(payload.state).toBeNull()
})
