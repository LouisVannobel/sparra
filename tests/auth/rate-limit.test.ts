import { afterEach, expect, test } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { createAuthRateLimiter, readRateLimitConfig, RedisInvalid, RedisUnavailable, rateLimitErrorResponse } from '../../src/modules/auth/rate-limit.server'
import { redisWire, tuple } from '../fixtures/db/redis-wire'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0 })
const env = {
  NODE_ENV: 'test', REDIS_URL: 'redis://:private-redis-marker@127.0.0.1:6379',
  RATE_LIMIT_HMAC_SECRET: 'private-hmac-marker-012345678901234567890123456789',
  RATE_LIMIT_KEY_ID: 'test-v1', TRUSTED_PROXY_IPS: '127.0.0.2,::1',
  REDIS_CONNECT_TIMEOUT_MS: '500', REDIS_COMMAND_TIMEOUT_MS: '100', REDIS_CLEANUP_TIMEOUT_MS: '50',
}

async function fixture(reply: Parameters<typeof redisWire>[0], overrides = {}) {
  const wire = await redisWire(reply)
  cleanups.push(wire.close)
  const limiter = createAuthRateLimiter(readRateLimitConfig({ ...env, REDIS_URL: wire.url, ...overrides }))
  cleanups.push(() => limiter.close())
  await limiter.connect()
  return { wire, limiter }
}

test('requires dedicated stable configuration and never retains secrets in errors or serialization', () => {
  expect(JSON.stringify(readRateLimitConfig(env))).not.toMatch(/private-(redis|hmac)-marker/)
  for (const key of ['REDIS_URL', 'RATE_LIMIT_HMAC_SECRET', 'RATE_LIMIT_KEY_ID', 'TRUSTED_PROXY_IPS']) {
    expect(() => readRateLimitConfig({ ...env, [key]: undefined })).toThrow(key)
  }
  for (const key of ['REDIS_CONNECT_TIMEOUT_MS', 'REDIS_COMMAND_TIMEOUT_MS', 'REDIS_CLEANUP_TIMEOUT_MS']) {
    for (const value of ['0', '-1', 'NaN', '1.5', '999999999']) expect(() => readRateLimitConfig({ ...env, [key]: value })).toThrow(key)
  }
})

test('one static EVAL and HMAC key, exact tuple, second-based retryAfter', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.write(tuple(0, 4, 1001)))
  expect(await limiter.customStorage.consume('private-ip@example.test', { window: 60, max: 3 })).toEqual({ allowed: false, retryAfter: 2 })
  const evals = wire.commands.filter(command => command[0] === 'EVAL')
  expect(evals).toHaveLength(1)
  expect(evals[0].slice(2)).toEqual(['1', 'rl:v1:test:test-v1:' + createHmac('sha256', env.RATE_LIMIT_HMAC_SECRET).update('private-ip@example.test').digest('hex'), '60000', '3'])
  expect(evals[0].join(' ')).not.toContain('private-ip@example.test')
})

test.each([tuple(1, 1, 500), tuple(1, 3, 0)])('accepts exact valid allow (%s)', async reply => {
  const { limiter } = await fixture((_, socket) => socket.write(reply))
  expect(await limiter.customStorage.consume('key', { window: 1, max: 3 })).toEqual({ allowed: true, retryAfter: null })
})

test.each([tuple(1, 4, 500), tuple(0, 3, 500), tuple(2, 1, 500), tuple(1, 0, 500), tuple(1, 1, -1), tuple(1, 1), tuple(1, 1, 1, 1), '*3\r\n$1\r\n1\r\n:1\r\n:500\r\n', '-ERR private-redis-marker\r\n'])(
  'protocol or Redis command error is sanitized 500, never 429/503 (%s)', async reply => {
    const { limiter } = await fixture((_, socket) => socket.write(reply))
    const error = await limiter.customStorage.consume('key', { window: 1, max: 3 }).catch(error => error)
    expect(error).toBeInstanceOf(RedisInvalid)
    const response = rateLimitErrorResponse(error)!
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(JSON.stringify(error)).not.toContain('private-redis-marker')
  },
)

test('post-write stall reaches wall deadline, destroys ownership, never replays; later admission stays 503', async () => {
  const { limiter, wire } = await fixture(() => {})
  const start = performance.now()
  const calls = [limiter.customStorage.consume('a', { window: 1, max: 3 }), limiter.customStorage.consume('b', { window: 1, max: 3 })]
  const results = await Promise.allSettled(calls)
  expect(results.every(result => result.status === 'rejected' && result.reason instanceof RedisUnavailable)).toBe(true)
  expect(performance.now() - start).toBeLessThan(500)
  expect(wire.commands.filter(command => command[0] === 'EVAL')).toHaveLength(2)
  await expect(limiter.customStorage.consume('c', { window: 1, max: 3 })).rejects.toBeInstanceOf(RedisUnavailable)
  expect(limiter.isReady()).toBe(false)
  await limiter.close()
})

test('shutdown stops admission, bounds in-flight work, and closes once even when repeated', async () => {
  const { limiter, wire } = await fixture(() => {}, { REDIS_COMMAND_TIMEOUT_MS: '1000' })
  const result = limiter.customStorage.consume('key', { window: 1, max: 3 }).catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 20))
  const start = performance.now()
  await Promise.all([limiter.close(), limiter.close()])
  expect(await result).toBeInstanceOf(RedisUnavailable)
  expect(performance.now() - start).toBeLessThan(300)
  expect(wire.commands.filter(command => command[0] === 'EVAL')).toHaveLength(1)
  await expect(limiter.customStorage.consume('key', { window: 1, max: 3 })).rejects.toBeInstanceOf(RedisUnavailable)
})

test('graceful close waits for an admitted reply and does not destroy after close', async () => {
  const { limiter } = await fixture((_, socket) => setTimeout(() => socket.write(tuple(1, 1, 900)), 20))
  const result = limiter.customStorage.consume('key', { window: 1, max: 3 })
  await Promise.all([limiter.close(), limiter.close()])
  expect(await result).toEqual({ allowed: true, retryAfter: null })
})

test('shutdown also bounds a connect handshake already in flight', async () => {
  const wire = await redisWire(() => {}, true)
  cleanups.push(wire.close)
  const limiter = createAuthRateLimiter(readRateLimitConfig({ ...env, REDIS_URL: wire.url }))
  cleanups.push(() => limiter.close())
  const connection = limiter.connect().catch(error => error)
  await expect.poll(() => wire.commands.length > 0).toBe(true)
  const start = performance.now()
  await limiter.close()
  expect(performance.now() - start).toBeLessThan(200)
  expect(await connection).toBeInstanceOf(RedisUnavailable)
})

test('shutdown closes the physical Redis TLS preconnection before the connect deadline', async () => {
  const sockets = new Set<Socket>()
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown) => { unhandled.push(error) }
  let accepted!: () => void
  const tcpAccepted = new Promise<void>(resolve => { accepted = resolve })
  // Accept TCP and drain incoming bytes without ever completing TLS. Unlike
  // the RESP cases, the assertion does not wait for Redis's connect event.
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.resume()
    accepted()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing TLS fixture port')
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    ...env, REDIS_URL: `rediss://:private-tls-marker@127.0.0.1:${address.port}`,
    REDIS_CONNECT_TIMEOUT_MS: '5000', REDIS_CLEANUP_TIMEOUT_MS: '50',
  }))
  process.on('unhandledRejection', onUnhandled)
  const connection = limiter.connect().catch(error => error)
  try {
    await tcpAccepted
    expect(sockets.size).toBe(1)
    const started = performance.now()
    await limiter.close()
    expect(performance.now() - started).toBeLessThan(250)
    await expect.poll(() => sockets.size, { interval: 10, timeout: 300 }).toBe(0)
    expect(performance.now() - started).toBeLessThan(400)
    const failure = await connection
    expect(failure).toBeInstanceOf(RedisUnavailable)
    expect(failure).not.toHaveProperty('cause')
    expect(String(failure)).not.toContain('private-tls-marker')
    const later = await limiter.customStorage.consume('after-close', { window: 10, max: 3 }).catch(error => error)
    expect(later).toBe(failure)
    expect(limiter.errorResponse(later)?.status).toBe(503)
    await expect(limiter.connect()).rejects.toBe(failure)
    expect(limiter.isReady()).toBe(false)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.allSettled([limiter.close(), connection])
    process.off('unhandledRejection', onUnhandled)
  }
})

test('shutdown destroys an internal reconnect handshake before native close can disable destroy', async () => {
  const wire = await redisWire(() => {}, 'reconnect')
  const limiter = createAuthRateLimiter(readRateLimitConfig({ ...env, REDIS_URL: wire.url }))
  await limiter.connect()
  const firstHandshake = wire.commands.length
  for (const socket of wire.sockets) socket.destroy()
  await expect.poll(() => wire.commands.length > firstHandshake).toBe(true)
  expect(limiter.isReady()).toBe(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const closed = await Promise.race([limiter.close().then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 200) })])
    expect(closed).toBe(true)
  } finally {
    clearTimeout(timer)
    // Release the controlled wire even on RED, so the deliberately hung native
    // close does not leave a test-owned transport behind.
    for (const socket of wire.sockets) socket.write('+OK\r\n'.repeat(wire.commands.length - firstHandshake))
    await wire.close()
  }
})

test('an automatic reconnect handshake has a wall deadline even without an application command', async () => {
  const wire = await redisWire(() => {}, 'reconnect')
  cleanups.push(wire.close)
  const limiter = createAuthRateLimiter(readRateLimitConfig({ ...env, REDIS_URL: wire.url, REDIS_CONNECT_TIMEOUT_MS: '150' }))
  cleanups.push(() => limiter.close())
  await limiter.connect()
  const firstHandshake = wire.commands.length
  for (const socket of wire.sockets) socket.destroy()
  await expect.poll(() => wire.commands.length > firstHandshake).toBe(true)
  await expect.poll(() => wire.sockets.size, { timeout: 500 }).toBe(0)
  await expect(limiter.customStorage.consume('after-failed-handshake', { window: 10, max: 3 })).rejects.toBeInstanceOf(RedisUnavailable)
  expect(wire.commands.filter(command => command[0] === 'EVAL')).toHaveLength(0)
})

test('a healthy idle client stays connected without reconnect churn', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.write(tuple(1, 1, 10000)))
  const handshakeCommands = wire.commands.length
  await new Promise(resolve => setTimeout(resolve, 650))
  expect(wire.commands.length).toBe(handshakeCommands)
  expect(limiter.isReady()).toBe(true)
  expect(await limiter.customStorage.consume('after-idle', { window: 10, max: 3 })).toEqual({ allowed: true, retryAfter: null })
})

test('connection refusal is bounded and mapped to unavailable without retaining native cause', async () => {
  const wire = await redisWire(() => {})
  await wire.close()
  const limiter = createAuthRateLimiter(readRateLimitConfig({ ...env, REDIS_URL: wire.url }))
  cleanups.push(() => limiter.close())
  const start = performance.now()
  const failure = await limiter.connect().catch(error => error)
  expect(failure).toBeInstanceOf(RedisUnavailable)
  expect(performance.now() - start).toBeLessThan(700)
  expect(failure).not.toHaveProperty('cause')
  expect(limiter.isReady()).toBe(false)
})

test('invalid native storage key/rule inputs fail as protocol errors before EVAL without coercion', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.write(tuple(1, 1, 10000)))
  // @ts-expect-error Exercise a malformed framework configuration at runtime.
  await expect(limiter.customStorage.consume('key', { window: '1', max: 3 })).rejects.toBeInstanceOf(RedisInvalid)
  // @ts-expect-error An object is not a Better Auth storage key.
  await expect(limiter.customStorage.consume({ private: 'key-marker' }, { window: 1, max: 3 })).rejects.toBeInstanceOf(RedisInvalid)
  expect(wire.commands.filter(command => command[0] === 'EVAL')).toHaveLength(0)
})

test('ambiguous post-write socket loss does not replay EVAL across bounded reconnection', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.destroy())
  await expect(limiter.customStorage.consume('ambiguous', { window: 10, max: 3 })).rejects.toBeInstanceOf(RedisUnavailable)
  await expect.poll(limiter.isReady).toBe(true)
  expect(wire.commands.filter(command => command[0] === 'EVAL')).toHaveLength(1)
})

test('server-selected Google entry admits once and rejects unknown operations before Redis', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.write(tuple(1, 1, 10000)))
  const context = limiter.trustedClientContext({ headers: new Headers({ 'x-real-ip': '2001:db8::1' }), runtime: { node: { req: { socket: { remoteAddress: '127.0.0.2' } } } } })
  await limiter.consumeAuthAttempt('beginGoogleSignIn', context)
  expect(wire.commands.filter(command => command[0] === 'EVAL')[0].slice(-2)).toEqual(['10000', '3'])
  // @ts-expect-error Unknown operation cannot be supplied as an application entry.
  await expect(limiter.consumeAuthAttempt('client-bucket', context)).rejects.toBeInstanceOf(RedisInvalid)
  expect(wire.commands.filter(command => command[0] === 'EVAL')).toHaveLength(1)
})

test('server-selected passkey entries use distinct explicit 60-second max-five policies', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.write(tuple(1, 1, 60000)))
  const context = limiter.trustedClientContext({ headers: new Headers({ 'x-real-ip': '2001:db8::2' }), runtime: { node: { req: { socket: { remoteAddress: '127.0.0.2' } } } } })
  await limiter.consumeAuthAttempt('beginPasskeySignIn', context)
  await limiter.consumeAuthAttempt('finishPasskeySignIn', context)
  const evaluations = wire.commands.filter(command => command[0] === 'EVAL')
  expect(evaluations.map(command => command.slice(-2))).toEqual([['60000', '5'], ['60000', '5']])
  expect(evaluations[0][3]).not.toBe(evaluations[1][3])
})

test('additional passkey entries select separate real five-per-minute policies', async () => {
  const { limiter, wire } = await fixture((_, socket) => socket.write(tuple(1, 1, 60000)))
  const context = limiter.trustedClientContext({ headers: new Headers({ 'x-real-ip': '192.0.2.44' }), runtime: { node: { req: { socket: { remoteAddress: '127.0.0.2' } } } } })
  for (const command of ['beginAdditionalPasskey', 'authorizeAdditionalPasskey', 'finishAdditionalPasskey'] as const) await limiter.consumeAuthAttempt(command, context)
  const evaluations = wire.commands.filter(command => command[0] === 'EVAL')
  expect(evaluations.map(command => command.slice(-2))).toEqual([['60000', '5'], ['60000', '5'], ['60000', '5']])
  expect(new Set(evaluations.map(command => command[3])).size).toBe(3)
})

test('denial of a named entry is 429 with Retry-After before any guarded effect', async () => {
  const { limiter } = await fixture((_, socket) => socket.write(tuple(0, 4, 1001)))
  const context = limiter.trustedClientContext({ headers: new Headers({ 'x-real-ip': '192.0.2.1' }), runtime: { node: { req: { socket: { remoteAddress: '127.0.0.2' } } } } })
  let effects = 0
  const error = await (async () => { await limiter.consumeAuthAttempt('beginGoogleSignIn', context); effects++ })().catch(error => error)
  expect(effects).toBe(0)
  const response = rateLimitErrorResponse(error)!
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('2')
})

test.each([undefined, '127.0.0.1', '::ffff:127.0.0.1'])('untrusted transport cannot claim client identity (%s)', async peer => {
  const { limiter } = await fixture((_, socket) => socket.write(tuple(1, 1, 10000)))
  expect(() => limiter.trustedClientContext({ headers: new Headers({ 'x-real-ip': '192.0.2.1' }), runtime: { node: { req: { socket: { remoteAddress: peer } } } } })).toThrow(RedisInvalid)
})

test.each([null, '', '192.0.2.1, 192.0.2.2', 'unknown', '192.0.2.1:443', '[2001:db8::1]'])('rejects malformed/multihop edge identity (%s)', async ip => {
  const { limiter } = await fixture((_, socket) => socket.write(tuple(1, 1, 10000)))
  expect(() => limiter.trustedClientContext({ headers: new Headers(ip === null ? {} : { 'x-real-ip': ip }), runtime: { node: { req: { socket: { remoteAddress: '127.0.0.2' } } } } })).toThrow(RedisInvalid)
})
