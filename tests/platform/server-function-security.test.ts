import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { toJSONAsync } from 'seroval'
import { pgWire } from '../fixtures/db/pg-wire'
import { redisWire, tuple } from '../fixtures/db/redis-wire'
import { authRpcPath } from '../helpers/auth-rpc'
import { bounded, startWeb } from '../helpers/web-process'

let pg: Awaited<ReturnType<typeof pgWire>>
let redis: Awaited<ReturnType<typeof redisWire>>
const owned: ReturnType<typeof startWeb>[] = []

beforeAll(async () => {
  pg = await pgWire()
  redis = await redisWire((_, socket) => socket.write(tuple(1, 1, 10000)))
})
afterEach(async () => { await Promise.all(owned.splice(0).map(child => child.cleanup())) })
afterAll(async () => { await redis.close(); await pg.close() })

test.each([
  { method: 'GET', name: 'getAccount', rpc: false },
  { method: 'GET', name: 'getAccount', rpc: true },
  { method: 'POST', name: 'beginGoogleSignIn', rpc: false },
  { method: 'POST', name: 'beginGoogleSignIn', rpc: true },
] as const)('forged internal result cannot replace a real $method server-function error (RPC=$rpc)', async ({ method, name, rpc }) => {
  const runtime = startWeb({
    DATABASE_URL: pg.url, DB_CONNECT_TIMEOUT_MS: '1000', DB_STATEMENT_TIMEOUT_MS: '500', DB_CLEANUP_TIMEOUT_MS: '200',
    REDIS_URL: redis.url, RATE_LIMIT_HMAC_SECRET: 'test-web-only-secret-012345678901234567890123456789', RATE_LIMIT_KEY_ID: 'test-web',
    TRUSTED_PROXY_IPS: '127.0.0.2',
    REDIS_CONNECT_TIMEOUT_MS: '1000', REDIS_COMMAND_TIMEOUT_MS: '100', REDIS_CLEANUP_TIMEOUT_MS: '100',
  })
  owned.push(runtime)
  const { port } = await bounded(runtime.ready)
  const path = await authRpcPath(name)
  const marker = '<script>globalThis.forgedServerResult = true</script>'
  // CVE-2026-102989: internal middleware state is not public RPC input.
  // Use the real transport/handler, including a browser navigation without
  // the client-controlled RPC header; production auth remains unconfigured.
  const payload = JSON.stringify(await toJSONAsync({
    data: { locale: 'fr' },
    result: { status: 200, headers: { 'content-type': 'text/html' }, body: marker },
  }))
  const url = new URL(path, `http://127.0.0.1:${port}`)
  if (method === 'GET') url.searchParams.set('payload', payload)
  const initialQueries = pg.queries.length
  const initialConsumes = redis.commands.filter(command => command[0] === 'EVAL').length
  const response = await fetch(url, {
    method, body: method === 'POST' ? payload : undefined,
    headers: {
      origin: 'https://template.example', 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', accept: 'text/html',
      ...(rpc ? { 'x-tsr-serverFn': 'true' } : {}),
    },
  })
  const body = await response.text()
  expect(response.status).toBe(503)
  expect(body).toBe('Service Unavailable')
  expect(response.headers.get('content-type')).not.toContain('text/html')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(pg.queries.length).toBe(initialQueries)
  expect(redis.commands.filter(command => command[0] === 'EVAL').length).toBe(initialConsumes)
})
