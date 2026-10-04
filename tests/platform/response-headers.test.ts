import { expect, test } from 'vitest'
import { responseWithSecurityHeaders } from '../../src/platform/response-headers.server'

const nonce = 'fixtureNonce+/=='
const privateCsp = "default-src 'none'; object-src 'none'; script-src 'self' 'nonce-fixtureNonce+/=='; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

test.each([
  { name: 'root GET', path: '/', method: 'GET', status: 200, contentType: 'text/html', publicDocument: true },
  { name: 'root HEAD', path: '/', method: 'HEAD', status: 200, contentType: 'text/html', publicDocument: true },
  { name: 'root query', path: '/?lang=en', method: 'GET', status: 200, contentType: 'text/html; charset=utf-8', publicDocument: true },
  { name: 'HTML case and whitespace before parameters', path: '/', method: 'GET', status: 200, contentType: 'TEXT/HTML \t; charset=utf-8', publicDocument: true },
  { name: 'native Headers trim outer whitespace', path: '/', method: 'GET', status: 200, contentType: ' text/html ', publicDocument: true },
  { name: 'last successful status', path: '/', method: 'GET', status: 299, contentType: 'text/html', publicDocument: true },
  { name: 'empty successful document', path: '/', method: 'HEAD', status: 204, contentType: 'text/html', publicDocument: true },
  { name: 'login document', path: '/login', method: 'GET', status: 200, contentType: 'text/html', publicDocument: false },
  { name: 'workspace document', path: '/workspace', method: 'GET', status: 200, contentType: 'text/html', publicDocument: false },
  { name: 'double slash path', path: '//', method: 'GET', status: 200, contentType: 'text/html', publicDocument: false },
  { name: 'encoded slash path', path: '/%2F', method: 'GET', status: 200, contentType: 'text/html', publicDocument: false },
  { name: 'root POST', path: '/', method: 'POST', status: 200, contentType: 'text/html', publicDocument: false },
  { name: 'root OPTIONS', path: '/', method: 'OPTIONS', status: 200, contentType: 'text/html', publicDocument: false },
  { name: 'first redirect status', path: '/', method: 'GET', status: 300, contentType: 'text/html', publicDocument: false },
  { name: 'missing root', path: '/', method: 'GET', status: 404, contentType: 'text/html', publicDocument: false },
  { name: 'cancelled root', path: '/', method: 'GET', status: 499, contentType: 'text/html', publicDocument: false },
  { name: 'failed root', path: '/', method: 'HEAD', status: 500, contentType: 'text/html', publicDocument: false },
  { name: 'timed out root', path: '/', method: 'GET', status: 504, contentType: 'text/html', publicDocument: false },
  { name: 'JSON root', path: '/', method: 'GET', status: 200, contentType: 'application/json', publicDocument: false },
  { name: 'XHTML root', path: '/', method: 'GET', status: 200, contentType: 'application/xhtml+xml', publicDocument: false },
  { name: 'HTML suffix', path: '/', method: 'GET', status: 200, contentType: 'text/htmlish', publicDocument: false },
  { name: 'HTML parameters without semicolon', path: '/', method: 'GET', status: 200, contentType: 'text/html charset=utf-8', publicDocument: false },
  { name: 'combined content types', path: '/', method: 'GET', status: 200, contentType: 'text/html, application/json', publicDocument: false },
  { name: 'missing content type', path: '/', method: 'GET', status: 200, contentType: null, publicDocument: false },
])('$name receives the existing document privacy policy', ({ path, method, status, contentType, publicDocument }) => {
  const headers = new Headers({ 'cache-control': 'public, max-age=3600', 'x-robots-tag': 'index, follow' })
  if (contentType !== null) headers.set('content-type', contentType)
  const original = new Response(null, { status, headers })
  const response = responseWithSecurityHeaders(new Request(`https://fixture.example${path}`, { method }), original, nonce)

  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-robots-tag')).toBe(publicDocument ? null : 'noindex')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-security-policy')).toBe(publicDocument ? privateCsp + "; media-src 'self'" : privateCsp)
  expect(response.headers.get('content-type')).toBe(original.headers.get('content-type'))
  expect(response.status).toBe(status)
  expect(response.body).toBeNull()
  expect(original.headers.get('cache-control')).toBe('public, max-age=3600')
  expect(original.headers.get('x-robots-tag')).toBe('index, follow')
})

test.each(['fixtureNonce+/==', 'secondNonce/+='])('the supplied nonce %s remains bound to the document', async documentNonce => {
  const html = `<script nonce="${documentNonce}">document.title = 'fixture'</script>`
  const original = new Response(html, { headers: { 'content-type': 'text/html' } })
  const response = responseWithSecurityHeaders(new Request('https://fixture.example/'), original, documentNonce)

  expect(response.headers.get('content-security-policy')).toContain(`script-src 'self' 'nonce-${documentNonce}'`)
  expect(response.headers.get('content-security-policy')).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval)/)
  expect(await response.text()).toBe(html)
})

test('native immutable redirect headers retain their location and protected defaults', () => {
  const original = Response.redirect('https://fixture.example/login', 307)
  const response = responseWithSecurityHeaders(new Request('https://fixture.example/'), original, nonce)

  expect(response.status).toBe(307)
  expect(response.statusText).toBe(original.statusText)
  expect(response.body).toBeNull()
  expect(response.headers.get('location')).toBe('https://fixture.example/login')
  expect(response.headers.get('x-robots-tag')).toBe('noindex')
  expect(response.headers.get('content-security-policy')).toBe(privateCsp)
  expect(original.headers.get('content-security-policy')).toBeNull()
})

test('private policy preserves cookies, status and opaque body without reading the request or stream', async () => {
  class UnreadRequest extends Request {
    override get body(): never { throw new Error('Response headers must not read the request body') }
  }
  const request = new UnreadRequest('https://fixture.example/', { method: 'POST', body: 'unread request' })
  const bytes = new Uint8Array([0, 255, 195, 40])
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(bytes); controller.close() },
  }, { highWaterMark: 0 })
  const headers = new Headers({
    'content-type': 'text/html', 'x-consumer': 'preserved', 'cache-control': 'public',
    'x-robots-tag': 'index', 'referrer-policy': 'origin', 'x-content-type-options': 'consumer',
    'content-security-policy': "default-src *; media-src *",
  })
  headers.append('set-cookie', 'fixture_a=1; Path=/; HttpOnly')
  headers.append('set-cookie', 'fixture_b=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; Secure')
  const original = new Response(stream, { status: 202, statusText: 'Accepted fixture', headers })
  const originalHeaders = [...original.headers]
  const response = responseWithSecurityHeaders(request, original, nonce)

  expect(response).not.toBe(original)
  expect(response.status).toBe(202)
  expect(response.statusText).toBe('Accepted fixture')
  expect(response.headers.getSetCookie()).toEqual([
    'fixture_a=1; Path=/; HttpOnly',
    'fixture_b=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; Secure',
  ])
  expect(response.headers.get('x-consumer')).toBe('preserved')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-robots-tag')).toBe('noindex')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-security-policy')).toBe(privateCsp)
  expect([...original.headers]).toEqual(originalHeaders)
  expect(response.body).toBe(stream)
  expect(response.body).toBe(original.body)
  expect(response.bodyUsed).toBe(false)
  expect(original.bodyUsed).toBe(false)
  expect(request.bodyUsed).toBe(false)
  expect(stream.locked).toBe(false)
  expect(pulls).toBe(0)

  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(pulls).toBe(1)
})

test('the returned stream leaves cancellation to its reader and passes the reason through', async () => {
  let cancelled = false
  let receivedReason: unknown
  const stream = new ReadableStream<Uint8Array>({
    cancel(reason) { cancelled = true; receivedReason = reason },
  }, { highWaterMark: 0 })
  const original = new Response(stream)
  const response = responseWithSecurityHeaders(new Request('https://fixture.example/workspace'), original, nonce)

  expect(response.body).toBe(stream)
  expect(response.bodyUsed).toBe(false)
  expect(cancelled).toBe(false)
  await response.body!.cancel('fixture-reader-cancel')
  expect(cancelled).toBe(true)
  expect(receivedReason).toBe('fixture-reader-cancel')
})
