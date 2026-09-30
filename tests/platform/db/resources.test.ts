import { afterEach, expect, test } from 'vitest'
import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { createWebResources } from '../../../src/platform/runtime.server'
import { pgWire } from '../../fixtures/db/pg-wire'
import { redisWire, tuple } from '../../fixtures/db/redis-wire'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0 })
async function fixture(pgResult?: Parameters<typeof pgWire>[0], redisReply?: Parameters<typeof redisWire>[0], stallHandshakeAfter = Infinity) {
  const pg = await pgWire(pgResult, stallHandshakeAfter)
  const redis = await redisWire(redisReply ?? ((_, socket) => socket.write(tuple(1, 1, 10000))))
  cleanups.push(pg.close, redis.close)
  const owner = createWebResources({
    DATABASE_URL: pg.url, DB_CONNECT_TIMEOUT_MS: '500', DB_STATEMENT_TIMEOUT_MS: '500', DB_CLEANUP_TIMEOUT_MS: '100', DB_POOL_MAX: '2',
    REDIS_URL: redis.url, RATE_LIMIT_HMAC_SECRET: 'local-only-012345678901234567890123456789', RATE_LIMIT_KEY_ID: 'test', TRUSTED_PROXY_IPS: '127.0.0.2',
    REDIS_CONNECT_TIMEOUT_MS: '300', REDIS_COMMAND_TIMEOUT_MS: '100', REDIS_CLEANUP_TIMEOUT_MS: '100',
  })
  cleanups.push(() => owner.dispose())
  return { pg, redis, owner }
}

test('startup forces real ManagedRuntime resources before ready and shares one owner across calls', async () => {
  const { pg, owner } = await fixture()
  const resource = await owner.ready()
  expect(await owner.ready()).toBe(resource)
  expect(resource.isReady()).toBe(true)
  const options = { deadlineAtMs: Date.now() + 2000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: randomUUID() }
  const selected = await owner.runtime.runPromise(resource.transactions.withAuthTransaction(options,
    resource.transactions.invokeAuthPromise(options, () => resource.transactions.withAuthPromise(options, ({ db }) => db.select({ one: sql<string>`1` }).from(sql`(select 1) as fixture`).execute())),
  ))
  expect(selected).toEqual([])
  expect(pg.connections()).toBe(1)
  await Promise.all([owner.dispose(), owner.dispose()])
  expect(resource.isReady()).toBe(false)
  await expect.poll(pg.closedConnections).toBe(1)
  await expect(owner.runtime.runPromise(Effect.succeed(1))).rejects.toThrow()
})

test('shutdown also bounds a pg socket whose handshake has not emitted pool connect', async () => {
  const { pg, owner } = await fixture(undefined, undefined, 1)
  const resource = await owner.ready()
  let releaseCallback!: () => void
  let entered!: () => void
  const inCallback = new Promise<void>(resolve => { entered = resolve })
  const opts = () => ({ deadlineAtMs: Date.now() + 1500, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: randomUUID() })
  const first = resource.transactions.withAuthPromise(opts(), async () => {
    entered()
    await new Promise<void>(resolve => { releaseCallback = resolve })
  }).catch(error => error)
  await inCallback
  const second = resource.transactions.withAuthPromise(opts(), async () => 1).catch(error => error)
  await expect.poll(pg.connections).toBe(2)
  const start = performance.now()
  try {
    await owner.dispose()
    expect(performance.now() - start).toBeLessThan(250)
  } finally { releaseCallback() }
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toBeInstanceOf(Error)
  await expect.poll(pg.closedConnections).toBe(2)
})

test('failed partial acquisition is sanitized and closes its already-acquired pool', async () => {
  const { pg, redis, owner } = await fixture(sql => sql.includes('server_version_num') ? { error: 'private-db-startup-marker' } : {})
  await expect(owner.ready()).rejects.toThrow('Application stores unavailable')
  await expect.poll(pg.closedConnections).toBe(1)
  expect(redis.sockets.size).toBe(0)
})

test('startup refuses incorrect version/roles/durability before readiness', async () => {
  const { pg, owner } = await fixture(sql => sql.includes('server_version_num') ? { fields: ['version'], values: ['150000'] } : {})
  await expect(owner.ready()).rejects.toThrow('Application stores unavailable')
  await expect.poll(pg.closedConnections).toBe(1)
})
test('startup refuses an invalid Workspace authority contract despite healthy base schema', async () => {
  const { pg, owner } = await fixture(sql => sql.includes('server_version_num') ? {
    fields: ['version','superuser','bypassrls','database_owner','table_owner','fsync','full_page_writes','synchronous_commit','schema_ready','workspace_ready'],
    values: ['160015','false','false','false','false','on','on','on','true','false'],
  } : {})
  await expect(owner.ready()).rejects.toThrow('Application stores unavailable')
  await expect.poll(pg.closedConnections).toBe(1)
})

test('shutdown bounds a real pg socket stalled after checkout without clean-releasing ambiguity', async () => {
  const { pg, owner } = await fixture(sql => sql.startsWith('select 2') ? { stall: true } : {})
  const resource = await owner.ready()
  const running = resource.transactions.withAuthPromise({ deadlineAtMs: Date.now() + 1000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: randomUUID() }, ({ db }) => db.select({ two: sql<string>`2` }).from(sql`(select 1) as fixture`).execute()).catch(error => error)
  await expect.poll(() => pg.queries.some(sql => sql.startsWith('select 2'))).toBe(true)
  const start = performance.now()
  await owner.dispose()
  expect(performance.now() - start).toBeLessThan(500)
  await expect.poll(pg.closedConnections).toBe(1)
  expect(await running).toBeInstanceOf(Error)
})
