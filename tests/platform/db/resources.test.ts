import { afterEach, expect, test, vi } from 'vitest'
import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createWebResources } from '../../../src/platform/runtime.server'
import { pgWire } from '../../fixtures/db/pg-wire'
import { redisWire, tuple } from '../../fixtures/db/redis-wire'
import { PgTransactionError } from '../../../src/platform/db/auth-pg-lease.server'
import * as transactionModule from '../../../src/platform/db/transactions.server'

test('resources_observer_redacts_payloads_and_accepts_only_closed_native_fields', () => {
  const secret = 'synthetic-private-payload-correlation-sentinel'
  const native = new PgTransactionError('query', 'unknown', secret)
  expect(safeTransactionFailure(native)).toEqual({ error_class: 'PgTransactionError', phase: 'query', outcome: 'unknown' })
  class ProviderError extends Error { toString() { throw new Error('must-not-stringify') } }
  for (const error of [new ProviderError(secret), new Error(secret), { phase: secret, outcome: secret }]) {
    expect(safeTransactionFailure(error)).toEqual({ error_class: 'OtherException', phase: 'other', outcome: 'other' })
    expect(JSON.stringify(safeTransactionFailure(error))).not.toContain(secret)
  }
  Object.defineProperty(native, 'phase', { get() { throw new Error(secret) } })
  expect(safeTransactionFailure(native)).toEqual({ error_class: 'OtherException', phase: 'other', outcome: 'other' })
})

test('resources_observer_preserves_factory_call_options_callback_result_and_exception_once', async () => {
  const nativeFactory = transactionModule.createTransactions
  const options = { deadlineAtMs: Date.now() + 1000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: randomUUID() }
  const wire = await pgWire(), pool = new Pool({ connectionString: wire.url, connectionTimeoutMillis: 100 })
  cleanups.push(wire.close, () => pool.end())
  const connections = { connect: () => pool.connect() }, limits = { maxStatementTimeoutMs: 500, maxCleanupTimeoutMs: 100 }
  const native = nativeFactory(connections, limits), result = {}, error = new PgTransactionError('query', 'unknown', options.correlationId)
  const callback = vi.fn(async () => result), failures = vi.fn()
  const calls: unknown[][] = [], real = native.withAuthPromise.bind(native)
  const original: typeof native.withAuthPromise = (selected, use) => { calls.push([selected, use]); return real(selected, use) }
  native.withAuthPromise = original
  const factory = vi.fn<typeof nativeFactory>().mockReturnValue(native)
  const observed = observedTransactionFactory(factory, failures)
  expect(observed(pool, limits)).toBe(native)
  expect(factory.mock.calls.length === 1 && factory.mock.calls[0]?.[0] === pool && factory.mock.calls[0]?.[1] === limits).toBe(true)
  expect(await native.withAuthPromise(options, callback)).toBe(result)
  expect(calls.length === 1 && calls[0]?.[0] === options && calls[0]?.[1] === callback).toBe(true)
  expect(failures).not.toHaveBeenCalled()
  const reject = async () => { throw error }
  let caught: unknown
  try { await native.withAuthPromise(options, reject) } catch (value) { caught = value }
  expect(caught === error).toBe(true)
  expect(calls.length === 2 && calls[1]?.[0] === options && calls[1]?.[1] === reject).toBe(true)
  expect(failures.mock.calls.length === 1 && failures.mock.calls[0]?.[0] === error).toBe(true)
  vi.restoreAllMocks()
  expect(native.withAuthPromise).toBe(original)
})

test('resources_observer_safe_wire_shape_never_emits_SQL_command_arguments_or_correlation', () => {
  const secret = 'synthetic-private-wire-sentinel'
  const pg = { connections: () => 2, closedConnections: () => 1,
    queries: ['BEGIN', 'select server_version_num ' + secret, 'select ' + secret, 'ROLLBACK'] }
  const redis = { sockets: new Set(), commands: [['AUTH', secret], ['CLIENT', secret], ['EVAL', secret], [secret]] }
  const state = { failures: 1, failure: safeTransactionFailure(new PgTransactionError('initialize', 'not-started', secret)) }
  const value = resourceDiagnostic(pg, redis, state)
  expect(Object.keys(value)).toHaveLength(9)
  expect(value).toMatchObject({ error_class: 'PgTransactionError', phase: 'initialize', outcome: 'not-started',
    pg_connections: 2, pg_closed_connections: 1, redis_open_sockets: 0, transaction_failures: 1 })
  expect(value.pg_query_categories).toEqual(['begin', 'startup-contract', 'other', 'rollback'])
  expect(value.redis_command_categories).toEqual(['auth', 'client', 'eval', 'other'])
  expect(JSON.stringify(value)).not.toContain(secret)
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { try { for (const close of cleanups.reverse()) await close(); cleanups.length = 0 } finally { vi.restoreAllMocks() } })

function safeTransactionFailure(error: unknown) {
  const other = { error_class: 'OtherException', phase: 'other', outcome: 'other' }
  if (!(error instanceof PgTransactionError)) return other
  const phase: unknown = Object.getOwnPropertyDescriptor(error, 'phase')?.value
  const outcome: unknown = Object.getOwnPropertyDescriptor(error, 'outcome')?.value
  if (typeof phase !== 'string' || !['initialize', 'query', 'finalize'].includes(phase)
    || typeof outcome !== 'string' || !['not-started', 'rolled-back', 'committed', 'unknown'].includes(outcome)) return other
  return { error_class: 'PgTransactionError', phase, outcome }
}

function observedTransactionFactory(factory: typeof transactionModule.createTransactions, capture: (error: unknown) => void): typeof factory {
  return (...args) => {
    const native = factory(...args), original = native.withAuthPromise.bind(native)
    const delegated: typeof native.withAuthPromise = async (options, callback) => {
      try { return await original(options, callback) }
      catch (error) {
        // Diagnostic failure must never replace the native exception.
        try { capture(error) } catch { /* observer only */ }
        throw error
      }
    }
    vi.spyOn(native, 'withAuthPromise').mockImplementation(delegated)
    return native
  }
}

type Observation = { failures: number; failure: ReturnType<typeof safeTransactionFailure> | null }
function resourceDiagnostic(pg: Pick<Awaited<ReturnType<typeof pgWire>>, 'queries' | 'connections' | 'closedConnections'>,
  redis: Pick<Awaited<ReturnType<typeof redisWire>>, 'sockets' | 'commands'>, observed: Observation) {
  function query(sql: string) {
    if (sql.includes('server_version_num')) return 'startup-contract'
    if (sql.includes('set_config') || /^SET\b/i.test(sql)) return 'configure'
    if (/^BEGIN\b/.test(sql)) return 'begin'
    if (sql === 'COMMIT') return 'commit'
    if (sql === 'ROLLBACK') return 'rollback'
    return 'other'
  }
  function command(args: string[]) {
    if (args[0] === 'AUTH') return 'auth'
    if (args[0] === 'CLIENT') return 'client'
    if (args[0] === 'HELLO') return 'hello'
    if (args[0] === 'PING') return 'ping'
    if (args[0] === 'EVAL') return 'eval'
    return 'other'
  }
  return { ...(observed.failure ?? safeTransactionFailure(null)),
    pg_connections: pg.connections(), pg_closed_connections: pg.closedConnections(),
    pg_query_categories: [...new Set(pg.queries.slice(-32).map(query))],
    redis_open_sockets: redis.sockets.size, redis_command_categories: [...new Set(redis.commands.slice(-32).map(command))],
    transaction_failures: observed.failures }
}

async function fixture(pgResult?: Parameters<typeof pgWire>[0], redisReply?: Parameters<typeof redisWire>[0], stallHandshakeAfter = Infinity) {
  const pg = await pgWire(pgResult, stallHandshakeAfter)
  const redis = await redisWire(redisReply ?? ((_, socket) => socket.write(tuple(1, 1, 10000))))
  cleanups.push(pg.close, redis.close)
  const observed: Observation = { failures: 0, failure: null }
  const originalFactory = transactionModule.createTransactions
  vi.spyOn(transactionModule, 'createTransactions').mockImplementation(observedTransactionFactory(originalFactory, error => {
    observed.failures++; observed.failure = safeTransactionFailure(error)
  }))
  const owner = createWebResources({
    DATABASE_URL: pg.url, DB_CONNECT_TIMEOUT_MS: '500', DB_STATEMENT_TIMEOUT_MS: '500', DB_CLEANUP_TIMEOUT_MS: '100', DB_POOL_MAX: '2',
    REDIS_URL: redis.url, RATE_LIMIT_HMAC_SECRET: 'local-only-012345678901234567890123456789', RATE_LIMIT_KEY_ID: 'test', TRUSTED_PROXY_IPS: '127.0.0.2',
    REDIS_CONNECT_TIMEOUT_MS: '300', REDIS_COMMAND_TIMEOUT_MS: '100', REDIS_CLEANUP_TIMEOUT_MS: '100',
  })
  cleanups.push(() => owner.dispose())
  async function ready() {
    try { return await owner.ready() }
    catch (error) {
      try { console.error('RESOURCES_STARTUP_DIAGNOSTIC', JSON.stringify(resourceDiagnostic(pg, redis, observed))) } catch { /* observer only */ }
      throw error
    }
  }
  return { pg, redis, owner, ready }
}

test('startup forces real ManagedRuntime resources before ready and shares one owner across calls', async () => {
  const { pg, owner, ready } = await fixture()
  const resource = await ready()
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
  const { pg, owner, ready } = await fixture(undefined, undefined, 1)
  const resource = await ready()
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
  const { pg, owner, ready } = await fixture(sql => sql.startsWith('select 2') ? { stall: true } : {})
  const resource = await ready()
  const running = resource.transactions.withAuthPromise({ deadlineAtMs: Date.now() + 1000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: randomUUID() }, ({ db }) => db.select({ two: sql<string>`2` }).from(sql`(select 1) as fixture`).execute()).catch(error => error)
  await expect.poll(() => pg.queries.some(sql => sql.startsWith('select 2'))).toBe(true)
  const start = performance.now()
  await owner.dispose()
  expect(performance.now() - start).toBeLessThan(500)
  await expect.poll(pg.closedConnections).toBe(1)
  expect(await running).toBeInstanceOf(Error)
})
