import { afterAll, beforeAll, expect, test } from 'vitest'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { bounded, startWeb } from '../helpers/web-process'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let app: ReturnType<typeof startWeb>
let port: number
const authority = 'fixture.example'
const valid = [`Host: ${authority}`, `X-Forwarded-Host: ${authority}`, 'X-Forwarded-Proto: https', 'X-Forwarded-For: 192.0.2.1']

async function raw(target: string, headers = valid, method = 'GET', body = '') {
  return bounded(new Promise<{ status: number; headers: string; body: string }>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let result = ''
    socket.on('error', reject)
    socket.on('data', data => { result += data.toString() })
    socket.on('end', () => {
      const split = result.indexOf('\r\n\r\n')
      const headers = result.slice(0, split)
      let body = result.slice(split + 4)
      if (/transfer-encoding: chunked/i.test(headers)) {
        let decoded = ''
        while (body) {
          const line = body.indexOf('\r\n'), length = parseInt(body.slice(0, line), 16)
          if (!length) break
          decoded += body.slice(line + 2, line + 2 + length)
          body = body.slice(line + 2 + length + 2)
        }
        body = decoded
      }
      resolve({ status: Number(result.split(' ')[1]), headers, body })
    })
    socket.on('connect', () => socket.write(`${method} ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`))
  }))
}
beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrate()
  app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: `https://${authority}`, SPARRA_INGRESS_PROFILE: 'direct-serve', FIXTURE_INGRESS: 'yes', DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'ingress', TRUSTED_PROXY_IPS: '127.0.0.1', AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'synthetic-fixture-only', REQUEST_TIMEOUT_MS: '200' })
  port = (await bounded(app.ready)).port
})
afterAll(async () => {
  try { if (app) { await app.shutdown(); expect(await bounded(app.exit)).toBe(0); await app.cleanup() } }
  finally {
    if (stores) {
      await stores.cleanup()
      expect(stores.evidence.unrelatedUnchanged).toBe(true)
      expect(stores.evidence.inventoryDelta).toEqual([])
    }
  }
})

test('private_and_funnel_views_agree preserving OAuth query octets and body', async () => {
  for (const marker of [[], ['Tailscale-Funnel-Request: ?1']]) {
    const response = await raw('/__fixture_ingress?code=a%2Fb&state=a%252Fb&x=1&x=2', [...valid, ...marker, 'X-Real-IP: 203.0.113.2', 'X-Real-IP: 203.0.113.3', 'Forwarded: for=invalid', 'Client-IP: invalid', 'X-Vercel-Forwarded-For: invalid', 'Origin: https://browser.example', 'Referer: https://browser.example/path', 'Sec-Fetch-Site: cross-site'], 'POST', 'real consumer body')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ carrier: true, socket: true, rawTarget: true, urls: true, realIp: true, clientIp: '192.0.2.1', hintsGone: true, browserMetadata: true, beforeBody: true, afterBody: true, method: 'POST', text: 'real consumer body', deadline: true, nonce: true })
  }
})
test('raw_duplicates_before_consumers and invalid authority/IP/marker', async () => {
  const before = JSON.parse((await raw('/__fixture_resources')).body).ingressEventCount
  const malformed = [
    [...valid, 'Host: fixture.example'], [...valid, 'x-forwarded-host: fixture.example'], [...valid, 'X-Forwarded-Proto: https'], [...valid, 'X-Forwarded-For: 192.0.2.1'],
    [...valid, 'Tailscale-Funnel-Request: ?1', 'tailscale-funnel-request: ?1'],
    ...['', '?0', '?1, ?1'].map(value => [...valid, `Tailscale-Funnel-Request: ${value}`]),
    ...['Fixture.example', 'fixture.example:443', 'foreign.example'].map(value => valid.map(line => line.startsWith('Host:') ? `Host: ${value}` : line)),
    ...['unknown', '192.0.2.1, 192.0.2.2', '192.0.2.1:80', '[::1]', 'fe80::1%lo', '2001:0db8::1'].map(value => valid.map(line => line.startsWith('X-Forwarded-For:') ? `X-Forwarded-For: ${value}` : line)),
    valid.filter(line => !line.startsWith('X-Forwarded-Host:')),
    ...['Fixture.example', 'fixture.example:443', 'foreign.example'].map(value => valid.map(line => line.startsWith('X-Forwarded-Host:') ? `X-Forwarded-Host: ${value}` : line)),
    ...['http', 'HTTPS', 'https, https'].map(value => valid.map(line => line.startsWith('X-Forwarded-Proto:') ? `X-Forwarded-Proto: ${value}` : line)),
  ]
  for (const headers of malformed) expect((await raw('/__fixture_auth', headers)).status).toBe(400)
  const after = JSON.parse((await raw('/__fixture_resources')).body)
  expect(after.effects).toBe(0)
  expect(after.ingressEventCount).toBe(before + 1)
})
test('raw_callback_aliases_never_route', async () => {
  const before = JSON.parse((await raw('/__fixture_resources')).body).ingressEventCount
  for (const target of ['*', '//fixture.example/', 'https://fixture.example/', '/a/../__fixture_auth', '/api/%61uth/callback/google', '/api/auth%2fcallback/google', '/api/auth%252fcallback/google', '/api/auth/./callback/google', '/api/auth/callback/google%2E', '/api/auth/callback/google%5c', '/api/auth/callback/google#x', '/%GG', '/api/auth/callback/google/child', '/api/auth/account/google/callback/child']) {
    expect((await raw(target)).status).toBe(400)
  }
  const after = JSON.parse((await raw('/__fixture_resources')).body)
  expect(after.effects).toBe(0)
  expect(after.ingressEventCount).toBe(before + 1)
})
test('lazy_body_disconnect_deadline_stream_survive actual Start middleware', async () => {
  const delayed = await bounded(new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let response = ''
    socket.on('error', reject)
    socket.on('data', data => { response += data.toString() })
    socket.on('end', () => resolve(response))
    socket.on('connect', () => {
      socket.write(`POST /__fixture_ingress HTTP/1.1\r\n${valid.join('\r\n')}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n`)
      setTimeout(() => socket.write('5\r\nhello\r\n'), 20)
      setTimeout(() => socket.write('6\r\n world\r\n0\r\n\r\n'), 45)
    })
  }))
  expect(delayed).toContain('"text":"hello world"')
  expect(delayed).toContain('"beforeBody":true')
  expect(delayed).toContain('"afterBody":true')
  const streaming = await bounded(new Promise<{ first: string; all: string }>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let all = '', first = ''
    socket.on('error', reject)
    socket.on('data', data => { all += data.toString(); if (!first && all.includes('started')) first = all })
    socket.on('end', () => resolve({ first, all }))
    socket.on('connect', () => socket.write(`GET /__fixture_ingress_stream HTTP/1.1\r\n${valid.join('\r\n')}\r\nConnection: close\r\n\r\n`))
  }))
  expect(streaming.first).toContain('started')
  expect(streaming.first).not.toContain('finished')
  expect(streaming.all).toContain('finished')
  expect(streaming.all).toMatch(/cache-control: no-store/i)
  expect(streaming.all).toMatch(/set-cookie: fixture_a=1/i)
  expect(streaming.all).toMatch(/set-cookie: fixture_b=2/i)
  expect((await raw('/__fixture_ingress_wait')).status).toBe(504)
  await bounded(new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const listener = (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ingress-response' && 'status' in message && message.status === 499) {
        app.child.removeListener('message', listener); resolve()
      }
    }
    app.child.on('message', listener)
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(`GET /__fixture_ingress_wait HTTP/1.1\r\n${valid.join('\r\n')}\r\n\r\n`)
      setTimeout(() => socket.destroy(), 30)
    })
  }))
})
test('native IPv6 canonical and mapped client views use the same limiter identity', async () => {
  for (const [input, expected] of [['2001:db8::1', '2001:db8::1'], ['::ffff:192.0.2.9', '192.0.2.9'], ['::ffff:c000:209', '192.0.2.9']]) {
    const response = await raw('/__fixture_ingress', valid.map(line => line.startsWith('X-Forwarded-For:') ? `X-Forwarded-For: ${input}` : line))
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ realIp: true, clientIp: expected, urls: true, carrier: true })
  }
})
test('untrusted actual socket never enters per-request limiter', async () => {
  const untrusted = startWeb({ NODE_ENV: 'test', APP_ORIGIN: `https://${authority}`, SPARRA_INGRESS_PROFILE: 'direct-serve', FIXTURE_INGRESS: 'yes', DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'untrusted-ingress', TRUSTED_PROXY_IPS: '127.0.0.2' })
  const saved = port
  try {
    port = (await bounded(untrusted.ready)).port
    expect((await raw('/__fixture_auth')).status).toBe(400)
  } finally {
    port = saved
    await untrusted.shutdown(); expect(await bounded(untrusted.exit)).toBe(0); await untrusted.cleanup()
  }
})
test('forged_real_ip_cannot_reset_budget and separate canonical XFF can', async () => {
  for (let attempt = 0; attempt < 3; attempt++) expect((await raw('/__fixture_auth', [...valid, `X-Real-IP: 203.0.113.${attempt + 1}`])).status).toBe(201)
  expect((await raw('/__fixture_auth', [...valid, 'X-Real-IP: 203.0.113.99'])).status).toBe(429)
  expect((await raw('/__fixture_auth', valid.map(line => line.startsWith('X-Forwarded-For:') ? 'X-Forwarded-For: 192.0.2.2' : line))).status).toBe(201)
})
