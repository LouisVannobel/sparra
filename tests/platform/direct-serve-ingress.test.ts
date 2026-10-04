import { expect, test } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
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

test('raw and Node sanitation precedes lazy headers without consuming or replacing body and signal', async () => {
  const socket = new Socket()
  try {
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' })
    const node = new IncomingMessage(socket)
    node.url = '/api/auth/callback/google?code=a%2Fb&state=a%252Fb&x=1&x=2'
    node.rawHeaders = ['Host', 'fixture.example', 'X-Forwarded-Host', 'fixture.example',
      'X-Forwarded-Proto', 'https', 'X-Forwarded-For', '192.0.2.1',
      'X-Real-IP', '203.0.113.1', 'Forwarded', 'for=invalid']
    node.headers = { host: 'fixture.example', 'x-forwarded-host': 'fixture.example',
      'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1',
      'x-real-ip': '203.0.113.1', forwarded: 'for=invalid' }
    const rawHeaders = node.rawHeaders
    const controller = new AbortController()
    const request = new Request('http://initial.invalid/', { method: 'POST', body: 'unchanged body', signal: controller.signal })
    const body = request.body, signal = request.signal
    let url = new URL(request.url), headerReads = 0
    Object.defineProperties(request, {
      runtime: { value: { node: { req: node } } },
      _url: { get: () => url, set: (value: URL) => { url = value } },
      url: { get: () => url.href },
      body: { configurable: true, get: () => { throw new Error('premature body read') } },
      signal: { configurable: true, get: () => { throw new Error('premature signal read') } },
      headers: { get: () => {
        headerReads++
        expect(node.rawHeaders).toBe(rawHeaders)
        expect(node.rawHeaders).toEqual(['Host', 'fixture.example', 'X-Forwarded-Host', 'fixture.example',
          'X-Forwarded-Proto', 'https', 'X-Forwarded-For', '192.0.2.1', 'X-Real-IP', '192.0.2.1'])
        expect(node.headers['x-real-ip']).toBe('192.0.2.1')
        expect(node.headers.forwarded).toBeUndefined()
        return new Headers(node.rawHeaders.reduce<[string, string][]>((pairs, value, index) => {
          if (index % 2 === 0) pairs.push([value, node.rawHeaders[index + 1]])
          return pairs
        }, []))
      } },
    })
    expect(normalizeDirectServeIngress(request, { origin, trustedProxyIps: ['127.0.0.1'] })).toBeUndefined()
    expect(headerReads).toBe(1)
    expect(request.url).toBe('https://fixture.example/api/auth/callback/google?code=a%2Fb&state=a%252Fb&x=1&x=2')
    Reflect.deleteProperty(request, 'body'); Reflect.deleteProperty(request, 'signal')
    expect(request.body).toBe(body)
    expect(request.signal).toBe(signal)
    expect(request.bodyUsed).toBe(false)
    controller.abort()
    expect(signal.aborted).toBe(true)
    expect(await request.text()).toBe('unchanged body')
  } finally { socket.destroy() }
})
