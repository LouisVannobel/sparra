import { expect, test } from 'vitest'
import { fillExceptionCategory, bootstrapResponseCategory, bootstrapFailureCategory, cspCategory } from '../helpers/magic-request-fill-diagnostic'

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
