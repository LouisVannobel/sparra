import { existsSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createHmac } from 'node:crypto'
import { pgWire } from '../fixtures/db/pg-wire'
import { redisWire, tuple } from '../fixtures/db/redis-wire'
import { bounded, probeRealStart, startWeb, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

const owned: ReturnType<typeof startWeb>[] = []
let stores: Record<string, string> = {}
let pg: Awaited<ReturnType<typeof pgWire>>
let redis: Awaited<ReturnType<typeof redisWire>>
let redisResponse: string | null = tuple(1, 1, 10000)
beforeAll(async () => {
  pg = await pgWire()
  redis = await redisWire((_, socket) => { if (redisResponse !== null) socket.write(redisResponse) })
  stores = {
    DATABASE_URL: pg.url, DB_CONNECT_TIMEOUT_MS: '1000', DB_STATEMENT_TIMEOUT_MS: '500', DB_CLEANUP_TIMEOUT_MS: '200',
    REDIS_URL: redis.url, RATE_LIMIT_HMAC_SECRET: 'test-web-only-secret-012345678901234567890123456789', RATE_LIMIT_KEY_ID: 'test-web',
    TRUSTED_PROXY_IPS: '127.0.0.2', REDIS_CONNECT_TIMEOUT_MS: '1000', REDIS_COMMAND_TIMEOUT_MS: '100', REDIS_CLEANUP_TIMEOUT_MS: '100',
  }
})
afterAll(async () => { await redis.close(); await pg.close() })
function launch(env: Record<string, string | undefined> = {}) {
  const process = startWeb({ ...stores, ...env })
  owned.push(process)
  return process
}
afterEach(async () => { await Promise.all(owned.splice(0).map(child => child.cleanup())) })

test('provides an executable production web artifact', () => {
  expect(existsSync('.output/server/index.mjs')).toBe(true)
})

test('login SSR is translated and truthfully unavailable, with nonce CSP and no private payload', async () => {
  const runtime = launch()
  const { port } = await bounded(runtime.ready)
  const nonces = new Set<string>()
  for (const [locale, title, label] of [['fr', 'Connexion', 'Continuer avec Google'], ['en', 'Sign in', 'Continue with Google']]) {
    const response = await fetch(`http://127.0.0.1:${port}/login?lang=${locale}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const csp = response.headers.get('content-security-policy')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval)/)
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/)
    const nonce = /'nonce-([^']+)'/.exec(csp!)![1]
    nonces.add(nonce)
    const html = await response.text()
    expect(html).toContain(`nonce="${nonce}"`)
    expect(html).toContain(`<html lang="${locale}"`)
    expect(html).toContain(title)
    expect(html).toContain(label)
    expect(html).toContain('disabled')
    expect(html).not.toMatch(/recoveryGeneration|session_token|GOOGLE_CLIENT_SECRET/)
  }
  expect(nonces.size).toBe(2)
})

test.each([
  { name: 'excess', reply: tuple(0, 4, 1001), status: 429 },
  { name: 'unavailable', reply: null, status: 503 },
  { name: 'invalid', reply: tuple(1, 4, 10000), status: 500 },
  { name: 'allowed', reply: tuple(1, 1, 10000), status: 500 },
])('actual Google-start server function enforces $name before OAuth state effects', async ({ name, reply, status }) => {
  redisResponse = reply
  const runtime = launch({ AUTH_SECRET: 'fixture-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })
  const { port } = await bounded(runtime.ready)
  const path = await authRpcPath('beginGoogleSignIn')
  const baselineQueries = pg.queries.length, baselineConsumes = redis.commands.filter(command => command[0] === 'EVAL').length
  const body = await rpcBody({ locale: 'fr' })
  const result = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((done, reject) => {
    // Test-owned ingress is represented by its real loopback socket, with its
    // fixed client header. No serialized TrustedClientContext bypass exists.
    const call = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', localAddress: '127.0.0.2', headers: {
      'x-real-ip': '192.0.2.11', 'sec-fetch-site': 'same-origin', origin: 'https://template.example',
      'content-type': 'application/json', 'x-tsr-serverFn': 'true',
    } }, response => { let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => done({ status: response.statusCode!, headers: response.headers, body: text })) })
    call.on('error', reject); call.end(body)
  })
  expect(result.status).toBe(status)
  expect(result.headers['set-cookie']).toBeUndefined()
  expect(redis.commands.filter(command => command[0] === 'EVAL').length - baselineConsumes).toBe(1)
  const emitted = pg.queries.slice(baselineQueries)
  if (name === 'allowed') expect(emitted.some(query => query.startsWith('insert into "verification"'))).toBe(true)
  else expect(emitted).toEqual([])
  expect(result.body).not.toMatch(/fixture-only|GOOGLE_CLIENT_SECRET|recoveryGeneration/)
  redisResponse = tuple(1, 1, 10000)
})

test('actual Google-start refuses provider, callback and idToken client fields before the limiter or OAuth store', async () => {
  const runtime = launch({ AUTH_SECRET: 'fixture-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })
  const { port } = await bounded(runtime.ready)
  const path = await authRpcPath('beginGoogleSignIn')
  const initialQueries = pg.queries.length, initialConsumes = redis.commands.filter(command => command[0] === 'EVAL').length
  for (const extra of [{ provider: 'other' }, { callbackURL: 'https://other.example' }, { idToken: 'client-token-marker' }]) {
    const body = await rpcBody({ locale: 'fr', ...extra })
    const response = await new Promise<{ status: number; text: string }>((done, reject) => {
      const call = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', localAddress: '127.0.0.2', headers: {
        'x-real-ip': '192.0.2.12', origin: 'https://template.example', 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true', 'content-type': 'application/json',
      } }, result => { let text = ''; result.on('data', chunk => { text += chunk }); result.on('end', () => done({ status: result.statusCode!, text })) })
      call.on('error', reject); call.end(body)
    })
    expect(response.status).toBe(500)
    expect(response.text).not.toContain('client-token-marker')
  }
  expect(pg.queries.length).toBe(initialQueries)
  expect(redis.commands.filter(command => command[0] === 'EVAL').length).toBe(initialConsumes)
})

test.each([
  { APP_ORIGIN: 'https://user:rejected-private-value@template.example' },
  { HOST: 'rejected-private-value' },
  { PORT: 'rejected-private-value' },
  { SHUTDOWN_TIMEOUT_MS: '1500' },
  { NITRO_HOST: 'rejected-private-value' },
  { NITRO_PORT: '43210' },
  { SERVER_SHUTDOWN_TIMEOUT: '8' },
  { NITRO_SHUTDOWN_TIMEOUT: '8000' },
  { CI: 'rejected-private-value' },
  { TEST: 'rejected-private-value' },
  { NITRO_SSL_CERT: 'rejected-private-value' },
  { NITRO_SSL_KEY: 'rejected-private-value' },
  { APP_ORIGIN: undefined },
  { DATABASE_URL: undefined },
  { DATABASE_URL: 'rejected-private-value' },
  { REDIS_URL: 'rejected-private-value' },
  { RATE_LIMIT_HMAC_SECRET: undefined },
  { REDIS_COMMAND_TIMEOUT_MS: '0' },
])('rejects invalid runtime configuration before listen (%j)', async invalid => {
  const runtime = launch(invalid)
  expect(await bounded(runtime.exit)).not.toBe(0)
  expect(runtime.listened()).toBe(false)
  expect(runtime.output()).toContain('Invalid configuration keys:')
  expect(runtime.output()).not.toContain('rejected-private-value')
})

test('real Nitro-to-SSR requests carry the same process-owned resources without exposing them', async () => {
  const runtime = launch()
  const { port } = await bounded(runtime.ready)
  const base = `http://127.0.0.1:${port}`
  const first = await fetch(`${base}/__fixture_resources`)
  expect(first.status).toBe(200)
  const observed = await first.json()
  expect(observed).toEqual({ resourceId: 1, ready: true, effects: 0 })
  expect(await (await fetch(`${base}/__fixture_resources`)).json()).toEqual(observed)
  const text = await (await fetch(`${base}/health/ready`)).text()
  expect(text).toBe('ok')
  expect(runtime.output()).not.toMatch(/test-web-only-secret|fixture-only/)
})

test('unknown controlled root mode fails safely while ordinary routes still delegate', async () => {
  const runtime = launch({ FIXTURE_ROOT_RESPONSE: 'unknown' })
  const { port } = await bounded(runtime.ready)
  const base = `http://127.0.0.1:${port}`
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(base + '/', { method })
    expect(response.status).toBe(500)
    safeHeaders(response)
    expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Internal Server Error')
  }
  const live = await fetch(base + '/health/live')
  expect(live.status).toBe(200)
  expect(await live.text()).toBe('ok')
  expect(runtime.output()).not.toContain('Unknown root response fixture')
})

test('an allowed fixture auth attempt increments effects after consume and retains resource identity', async () => {
  const runtime = launch()
  const { port } = await bounded(runtime.ready)
  const base = `http://127.0.0.1:${port}`
  expect(await (await fetch(base + '/__fixture_resources')).json()).toEqual({ resourceId: 1, ready: true, effects: 0 })
  const before = redis.commands.length
  const response = await new Promise<{ status: number; body: string }>((done, reject) => {
    const call = httpRequest({ hostname: '127.0.0.1', port, path: '/__fixture_auth', localAddress: '127.0.0.2', headers: { 'x-real-ip': '192.0.2.31' } }, result => {
      let body = ''
      result.on('data', chunk => { body += chunk })
      result.on('end', () => done({ status: result.statusCode!, body }))
    })
    call.on('error', reject); call.end()
  })
  expect(response).toEqual({ status: 201, body: 'effect reached' })
  const attempts = redis.commands.slice(before).filter(command => command[0] === 'EVAL')
  expect(attempts).toHaveLength(1)
  expect(attempts[0][3]).toBe('rl:v1:production:test-web:' + createHmac('sha256', stores.RATE_LIMIT_HMAC_SECRET).update('application:beginGoogleSignIn:192.0.2.31').digest('hex'))
  for (let index = 0; index < 2; index++) expect(await (await fetch(base + '/__fixture_resources')).json()).toEqual({ resourceId: 1, ready: true, effects: 1 })
})

test('native Google IPC ignores malformed commands, correlates receipts and retires normally', async () => {
  const runtime = launch({ FIXTURE_GOOGLE_PROTOCOL: 'yes' })
  await bounded(runtime.ready)
  const messages: unknown[] = []
  const observe = (message: unknown) => { messages.push(message) }
  runtime.child.on('message', observe)
  try {
    runtime.child.send('unknown')
    runtime.child.send({})
    runtime.child.send({ type: 'google-register', id: 23, url: 'invalid' })
    runtime.child.send({ type: 'unknown', id: 'ignored' })
    runtime.child.send({ type: 'google-evidence', id: 'fixture-correlated' })
    expect(await runtime.googleEvidence()).toEqual({ posts: 0, tls: 0, disallowed: 0, activeClientSockets: 0, activeRequests: 0 })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'google-evidence', id: 'fixture-correlated', evidence: expect.objectContaining({ pendingAttempts: 0 }) }))
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'google-registered' }))
    await expect(runtime.registerGoogle('invalid', 'fixture-registration')).rejects.toThrow('Google fixture registration failed')
    const code = await runtime.registerGoogle('https://accounts.google.com/o/oauth2/v2/auth?nonce=fixture&code_challenge=fixture&code_challenge_method=S256&redirect_uri=https%3A%2F%2Ftemplate.example%2Fapi%2Fauth%2Fcallback%2Fgoogle', 'fixture-registration')
    const receipts = messages.filter((message): message is { type: string; id: string; code?: string; failed?: boolean } => typeof message === 'object' && message !== null && 'type' in message && message.type === 'google-registered' && 'id' in message && typeof message.id === 'string')
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toEqual({ type: 'google-registered', id: receipts[0].id, failed: true })
    expect(receipts[1]).toEqual({ type: 'google-registered', id: receipts[1].id, code })
    expect(receipts[0].id).not.toBe(receipts[1].id)
    expect(await runtime.shutdown()).toBeGreaterThan(0)
    expect(await bounded(runtime.exit)).toBe(0)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'google-closed', evidence: expect.objectContaining({ activeClientSockets: 0, activeRequests: 0, pendingAttempts: 0, emergencyCleanup: false }) }))
    expect(runtime.output()).toContain('Server closed successfully')
  } finally { runtime.child.removeListener('message', observe) }
})

test.each([
  { name: 'excess', reply: tuple(0, 4, 1001), status: 429 },
  { name: 'unavailable', reply: null, status: 503 },
  { name: 'invalid', reply: tuple(1, 4, 10000), status: 500 },
])('real application response maps $name before effects through an overwriting local proxy', async ({ reply, status }) => {
  redisResponse = reply
  const runtime = launch()
  const { port } = await bounded(runtime.ready)
  const proxy = createHttpServer((incoming, outgoing) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: incoming.url, localAddress: '127.0.0.2', headers: {
      'x-real-ip': incoming.socket.remoteAddress!,
    } }, response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing) })
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end() })
    upstream.end()
  })
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done))
  try {
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy port')
    const before = redis.commands.length
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/__fixture_auth`, { headers: { 'x-real-ip': '198.51.100.50', 'x-forwarded-for': '198.51.100.51, 198.51.100.52' } })
    expect(response.status).toBe(status)
    const attempts = redis.commands.slice(before).filter(command => command[0] === 'EVAL')
    expect(attempts).toHaveLength(1)
    expect(attempts[0][3]).toBe('rl:v1:production:test-web:' + createHmac('sha256', stores.RATE_LIMIT_HMAC_SECRET).update('application:beginGoogleSignIn:127.0.0.1').digest('hex'))
    safeHeaders(response)
    if (status === 429) expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.text()).toBe(status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : 'Internal Server Error')
    expect((await (await fetch(`http://127.0.0.1:${port}/__fixture_resources`)).json()).effects).toBe(0)
    if (status === 503) {
      expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(503)
      expect((await fetch(`http://127.0.0.1:${proxyAddress.port}/__fixture_auth`)).status).toBe(503)
    }
    expect((await fetch(`http://127.0.0.1:${port}/__fixture_auth`, { headers: { 'x-real-ip': '192.0.2.1' } })).status).toBe(500)
    expect(runtime.output()).not.toMatch(/test-web-only-secret|fixture-only|198\.51\.100/)
  } finally { redisResponse = tuple(1, 1, 10000); proxy.closeAllConnections(); await new Promise<void>(done => proxy.close(() => done())) }
})

test('binds the explicitly selected port and serves there', async () => {
  const selected = await unusedLoopbackPort()
  const runtime = launch({ PORT: String(selected) })
  const address = await bounded(runtime.ready)
  expect(address).toMatchObject({ address: '127.0.0.1', port: selected })
  const response = await fetch(`http://127.0.0.1:${selected}/health/live`, { signal: AbortSignal.timeout(3000) })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
})

test('binds the validated default loopback and an OS-assigned port', async () => {
  const runtime = launch({ HOST: undefined })
  const address = await bounded(runtime.ready)
  expect(address.address).toBe('127.0.0.1')
  expect(address.port).toBeGreaterThan(0)
  expect(address.port).not.toBe(3000)
})

function safeHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-robots-tag')).toBe('noindex')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
}

test('serves only public GET/HEAD health and a private-safe framework 404', async () => {
  const runtime = launch()
  const address = await bounded(runtime.ready)
  const base = `http://127.0.0.1:${address.port}`
  for (const path of ['/health/live', '/health/ready']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(3000) })
      expect(response.status, `${method} ${path}: ${runtime.output()} ${await response.clone().text()}`).toBe(200)
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'ok')
      safeHeaders(response)
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(3000) })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD')
      safeHeaders(response)
    }
  }
  const missing = await fetch(`${base}/workspace-does-not-exist`, { signal: AbortSignal.timeout(3000) })
  expect(missing.status).toBe(404)
  safeHeaders(missing)
  const body = await missing.text()
  expect(body).toContain('Page introuvable')
  for (const forbidden of ['template.example', 'APP_ORIGIN', 'ConfigurationError', 'C:\\Users', 'node_modules']) expect(body).not.toContain(forbidden)
})

test('invokes the real registered shutdown handler, drains and exits cleanly', async () => {
  const runtime = launch({ FIXTURE_STREAM_MS: '350' })
  const { port } = await bounded(runtime.ready)
  const base = `http://127.0.0.1:${port}`
  const stream = await fetch(`${base}/__fixture_stream`, { signal: AbortSignal.timeout(4000) })
  expect(await runtime.shutdown()).toBeGreaterThan(0)
  await expect(fetch(`${base}/health/live`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  expect(await stream.text()).toBe('startedfinished')
  expect(await bounded(runtime.exit)).toBe(0)
  expect(runtime.output()).toContain('Server closed successfully')
})

test('finishes an in-flight keepalive response and closes its socket within grace', async () => {
  const runtime = launch({ FIXTURE_STREAM_MS: '350', FIXTURE_KEEP_ALIVE: 'yes' })
  const { port } = await bounded(runtime.ready)
  const stream = await fetch(`http://127.0.0.1:${port}/__fixture_stream`, { signal: AbortSignal.timeout(4000) })
  const start = performance.now()
  expect(await runtime.shutdown()).toBeGreaterThan(0)
  expect(await stream.text()).toBe('startedfinished')
  expect(await bounded(runtime.exit)).toBe(0)
  expect(performance.now() - start).toBeLessThan(2300)
})

test.each([{ milliseconds: '1000', min: 800, max: 2300 }, { milliseconds: '2000', min: 1800, max: 3300 }])(
  'applies $milliseconds ms to the real forced drain timeout', async ({ milliseconds, min, max }) => {
    const runtime = launch({ SHUTDOWN_TIMEOUT_MS: milliseconds, FIXTURE_STREAM_MS: '10000' })
    const { port } = await bounded(runtime.ready)
    const stream = await fetch(`http://127.0.0.1:${port}/__fixture_stream`, { signal: AbortSignal.timeout(5000) })
    const start = performance.now()
    expect(await runtime.shutdown()).toBeGreaterThan(0)
    await expect(stream.text()).rejects.toThrow()
    expect(await bounded(runtime.exit)).toBe(0)
    const elapsed = performance.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(min)
    expect(elapsed).toBeLessThan(max)
    expect(runtime.output()).toContain('Graceful shutdown timed out')
  },
)

// Only the local mechanics test below uses this double. Real Start/H3 runs in
// separate Node processes above the same compiled application middleware.
const controlled = vi.hoisted(() => ({ fetch: vi.fn<(request: Request) => Promise<Response>>() }))
vi.mock('@tanstack/react-start/server', () => ({
  createStartHandler: () => controlled.fetch,
  defaultStreamHandler: undefined,
}))

describe.each([
  { timeoutMs: 9999, expectedBudgetMs: 9999 },
  { timeoutMs: 10000, expectedBudgetMs: 10000 },
  { timeoutMs: 30000, expectedBudgetMs: 10000 },
])('entry attaches an exact $expectedBudgetMs ms auth ceiling for a $timeoutMs ms HTTP timeout', ({ timeoutMs, expectedBudgetMs }) => {
  const ingressNow = 1_000_000
  let server: (typeof import('../../src/server'))['default']
  let restoreClock: (() => void) | undefined
  // Cold module loading is setup, not the request's five-second test budget.
  // Reset/import for each parameter so its environment gets a fresh server.
  beforeEach(async () => {
    for (const key of ['NITRO_HOST', 'NITRO_PORT', 'NITRO_SHUTDOWN_TIMEOUT', 'SERVER_SHUTDOWN_TIMEOUT', 'NITRO_SSL_CERT', 'NITRO_SSL_KEY', 'CI', 'TEST']) vi.stubEnv(key, undefined)
    vi.stubEnv('APP_ORIGIN', 'https://template.example')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('HOST', '127.0.0.1')
    vi.stubEnv('PORT', '0')
    vi.stubEnv('REQUEST_TIMEOUT_MS', String(timeoutMs))
    vi.stubEnv('SHUTDOWN_TIMEOUT_MS', '1000')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(ingressNow)
    restoreClock = () => clock.mockRestore()
    vi.resetModules()
    server = (await import('../../src/server')).default
  }, 15000)
  afterEach(() => {
    restoreClock?.(); restoreClock = undefined
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  test('preserves request identity, unread body and exact deadline descriptor', async () => {
    class UnreadRequest extends Request {
      override get body(): never { throw new Error('The ingress boundary must not access the body stream') }
    }
    const request = new UnreadRequest('https://template.example/health/live', { method: 'POST', body: 'not-read' })
    const clientSignal = request.signal
    let receivedRequest: Request | undefined
    let receivedSignal: AbortSignal | undefined
    let descriptor: PropertyDescriptor | undefined
    controlled.fetch.mockImplementationOnce(async received => {
      receivedRequest = received
      receivedSignal = received.signal
      descriptor = Object.getOwnPropertyDescriptor(received, 'appAuthDeadlineAtMs')
      return new Response(!received.bodyUsed ? 'untouched' : 'changed')
    })
    const response = await server.fetch(request)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('untouched')
    expect(receivedRequest).toBe(request)
    expect(receivedSignal).not.toBe(clientSignal)
    expect(receivedSignal?.aborted).toBe(false)
    expect(descriptor).toEqual({
      value: ingressNow + expectedBudgetMs,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  })
})

test.each([
  { scenario: 'pre-abort', status: 499, body: 'Request Cancelled', entered: false },
  { scenario: 'deadline', status: 504, body: 'Gateway Timeout', entered: true },
  { scenario: 'client-abort', status: 499, body: 'Request Cancelled', entered: true },
  { scenario: 'unexpected', status: 500, body: 'Internal Server Error', entered: true },
  { scenario: 'forbidden', status: 403, body: 'Forbidden', entered: true },
  { scenario: 'redirect', status: 302, body: '', entered: true },
  { scenario: 'normal', status: 201, body: 'consumer response', entered: true },
])('real pinned Start preserves the $scenario request contract without private stderr', async ({ scenario, status, body, entered }) => {
  const result = await probeRealStart(scenario)
  expect(result.code, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout)
  expect(observed.status, result.stderr).toBe(status)
  expect(observed.body).toBe(body)
  expect(observed.entered).toBe(entered)
  expect(observed.settled).toBe(entered)
  safeHeaders(new Response(null, { headers: observed.headers }))
  expect(result.stderr).not.toContain('private-')
  if (scenario !== 'deadline' && scenario !== 'client-abort') expect(result.stderr).toBe('')
  if (scenario === 'normal' || scenario === 'forbidden') expect(observed.headers['x-consumer']).toBe('preserved')
  if (scenario === 'redirect') expect(observed.headers.location).toBe('https://template.example/health/live')
})

test('isolated boundary mechanics preserve signals and unread bodies, sanitize rejections and dispose replaced responses', async () => {
  for (const key of ['NITRO_HOST', 'NITRO_PORT', 'NITRO_SHUTDOWN_TIMEOUT', 'SERVER_SHUTDOWN_TIMEOUT', 'NITRO_SSL_CERT', 'NITRO_SSL_KEY', 'CI', 'TEST']) vi.stubEnv(key, undefined)
  vi.stubEnv('APP_ORIGIN', 'https://template.example')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('HOST', '127.0.0.1')
  vi.stubEnv('PORT', '0')
  vi.stubEnv('REQUEST_TIMEOUT_MS', '60')
  vi.stubEnv('SHUTDOWN_TIMEOUT_MS', '1000')
  try {
    const server = (await import('../../src/server')).default
    expectTypeOf<Parameters<typeof server.fetch>[0]>().toEqualTypeOf<Request>()
    expectTypeOf<Awaited<ReturnType<typeof server.fetch>>>().toEqualTypeOf<Response>()
    controlled.fetch.mockImplementation(async request => {
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      return new Response('unreachable')
    })
    const start = performance.now()
    const deadline = await bounded(server.fetch(new Request('https://template.example/health/live')))
    expect(deadline.status).toBe(504)
    expect(performance.now() - start).toBeGreaterThanOrEqual(40)
    expect(performance.now() - start).toBeLessThan(500)
    safeHeaders(deadline)
    const controller = new AbortController()
    const pending = server.fetch(new Request('https://template.example/health/live', { signal: controller.signal }))
    controller.abort(new Error('private-abort-reason'))
    const cancelled = await bounded(pending)
    expect(cancelled.status).toBe(499)
    expect(await cancelled.text()).not.toContain('private-abort-reason')
    safeHeaders(cancelled)
    controlled.fetch.mockRejectedValue(new Error('private-provider-stack'))
    const failed = await server.fetch(new Request('https://template.example/health/live'))
    expect(failed.status).toBe(500)
    expect(await failed.text()).toBe('Internal Server Error')
    safeHeaders(failed)
    class UnreadRequest extends Request {
      override get body(): never { throw new Error('The mechanical boundary must not access the body stream') }
    }
    const unread = new UnreadRequest('https://template.example/health/live', { method: 'POST', body: 'not-read' })
    controlled.fetch.mockImplementation(async request => new Response(request === unread && !request.bodyUsed ? 'untouched' : 'changed'))
    const bodyFree = await server.fetch(unread)
    expect(bodyFree.status).toBe(200)
    expect(await bodyFree.text()).toBe('untouched')
    let releaseCancellation!: () => void
    let markCancellationStarted!: () => void
    const cancellationRelease = new Promise<void>(resolve => { releaseCancellation = resolve })
    const cancellationStarted = new Promise<void>(resolve => { markCancellationStarted = resolve })
    let cancellationCompleted = false
    controlled.fetch.mockImplementation(async request => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return new Response(new ReadableStream({ async cancel() {
        markCancellationStarted()
        await cancellationRelease
        cancellationCompleted = true
      } }))
    })
    let responseSettled = false
    const pendingDisposal = Promise.resolve(server.fetch(new Request('https://template.example/health/live'))).then(response => {
      responseSettled = true
      return response
    })
    await bounded(cancellationStarted)
    expect(responseSettled).toBe(false)
    releaseCancellation()
    const fulfilledAfterDeadline = await bounded(pendingDisposal)
    expect(fulfilledAfterDeadline.status).toBe(504)
    expect(cancellationCompleted).toBe(true)
  } finally {
    vi.unstubAllEnvs()
  }
})
