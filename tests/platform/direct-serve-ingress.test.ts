import { expect, test } from 'vitest'
import { canonicalIp } from '../../src/platform/canonical-ip.server'
import { normalizeDirectServeIngress, readDirectServeConfig } from '../../src/platform/direct-serve-ingress.server'
import { readWebConfig } from '../../src/platform/config.server'

const origin = 'https://fixture.example'
test('missing profile preserves native request without reading carrier or headers', () => {
  const request = new Request(origin)
  expect(normalizeDirectServeIngress(request, null)).toBeUndefined()
  expect(readDirectServeConfig({}, readWebConfig({ APP_ORIGIN: origin }))).toBeNull()
})
test('enabled profile refuses a fabricated request without real Node carrier', () => {
  const response = normalizeDirectServeIngress(new Request(origin), { origin, trustedProxyIps: ['127.0.0.1'] })
  expect(response?.status).toBe(400)
  expect(response?.headers.get('cache-control')).toBe('no-store')
  expect(response?.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response?.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response?.headers.get('x-robots-tag')).toBe('noindex')
})
test.each([
  ['127.0.0.1', '127.0.0.1'], ['::1', '::1'], ['2001:db8::1', '2001:db8::1'],
  ['::ffff:127.0.0.1', '127.0.0.1'], ['::ffff:7f00:1', '127.0.0.1'],
])('native canonicalIp preserves mapped equivalence %s', (ip, expected) => {
  expect(canonicalIp(ip)).toBe(expected)
})
test.each(['', '127.1', 'unknown', '127.0.0.1:80', '[::1]', 'fe80::1%lo'])('canonicalIp refuses %s', ip => {
  expect(() => canonicalIp(ip)).toThrow()
})
