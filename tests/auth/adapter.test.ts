import type { BetterAuthOptions, DBAdapter, DBTransactionAdapter } from 'better-auth'
import { Effect, Exit } from 'effect'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createAuthAdapter } from '../../src/modules/auth/adapter.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { fixture, initialization, type Step } from '../platform/db/pg-client-fixture'

const limits = { maxStatementTimeoutMs: 500, maxCleanupTimeoutMs: 100 }
const options = () => ({ deadlineAtMs: Date.now() + 3000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: '3efaf2ac-d41e-43e9-aebe-f446bc233bb0' })
const baOptions: BetterAuthOptions = { user: { additionalFields: { recoveryGeneration: { type: 'number', input: false } } } }
const date = new Date('2026-09-10T00:00:00.000Z')
const columns = '"id", "name", "email", "email_verified", "image", "created_at", "updated_at", "recovering", "recovery_generation", "hold_until"'
const row = ['u1', 'Ada', 'ada@example.test', false, null, date.toISOString(), date.toISOString(), false, 2, null]
const where = [{ field: 'id', value: 'u1' }]
const fullUser = { id: 'u1', name: 'Ada', email: 'ada@example.test', emailVerified: false, image: null, createdAt: date, updatedAt: date, recoveryGeneration: 2 }
const cases: { name: string; call: (adapter: DBTransactionAdapter) => Promise<unknown>; step: Step; expected: unknown }[] = [
  {
    name: 'create',
    call: adapter => adapter.create<{ id: string; name: string; email: string; createdAt: Date; updatedAt: Date; recoveryGeneration: number }, { id: string }>({
      model: 'user', data: { ...fullUser }, forceAllowId: true, select: ['id'],
    }),
    step: { text: `insert into "user" (${columns}) values ($1, $2, $3, $4, $5, $6, $7, default, $8, default) returning ${columns}`,
      values: ['u1', 'Ada', 'ada@example.test', false, null, date.toISOString(), date.toISOString(), 2], rows: [row], command: 'INSERT' },
    expected: { id: 'u1' },
  },
  { name: 'findOne', call: adapter => adapter.findOne<{ id: string }>({ model: 'user', where, select: ['id'] }),
    step: { text: 'select "id" from "user" where "user"."id" = $1', values: ['u1'], rows: [['u1']] }, expected: { id: 'u1' } },
  { name: 'findMany', call: adapter => adapter.findMany<{ id: string }>({ model: 'user', where, select: ['id'], limit: 2 }),
    step: { text: 'select "id" from "user" where "user"."id" = $1 limit $2', values: ['u1', 2], rows: [['u1']] }, expected: [{ id: 'u1' }] },
  { name: 'count', call: adapter => adapter.count({ model: 'user', where }),
    step: { text: 'select count(*) from "user" where "user"."id" = $1', values: ['u1'], rows: [[1]] }, expected: 1 },
  { name: 'update', call: adapter => adapter.update<typeof fullUser>({ model: 'user', where, update: { name: 'Ada', updatedAt: date } }),
    step: { text: `update "user" set "name" = $1, "updated_at" = $2 where "user"."id" = $3 returning ${columns}`, values: ['Ada', date.toISOString(), 'u1'], rows: [row], command: 'UPDATE' }, expected: fullUser },
  { name: 'updateMany', call: adapter => adapter.updateMany({ model: 'user', where, update: { name: 'Ada', updatedAt: date } }),
    step: { text: 'update "user" set "name" = $1, "updated_at" = $2 where "user"."id" = $3', values: ['Ada', date.toISOString(), 'u1'], rows: [{}], command: 'UPDATE' }, expected: 1 },
  { name: 'delete', call: adapter => adapter.delete<{ id: string }>({ model: 'user', where }),
    step: { text: 'delete from "user" where "user"."id" = $1', values: ['u1'], rows: [{}], command: 'DELETE' }, expected: undefined },
  { name: 'deleteMany', call: adapter => adapter.deleteMany({ model: 'user', where }),
    step: { text: 'delete from "user" where "user"."id" = $1', values: ['u1'], rows: [{}], command: 'DELETE' }, expected: 1 },
  { name: 'consumeOne', call: adapter => adapter.consumeOne<typeof fullUser>({ model: 'user', where }),
    step: { text: `delete from "user" where "user"."id" in (select "id" from "user" where "user"."id" = $1 limit $2) returning ${columns}`, values: ['u1', 1], rows: [row], command: 'DELETE' }, expected: fullUser },
  { name: 'incrementOne', call: adapter => adapter.incrementOne<typeof fullUser>({ model: 'user', where, increment: { recoveryGeneration: 1 }, set: { updatedAt: date } }),
    step: { text: `update "user" set "updated_at" = $1, "recovery_generation" = "user"."recovery_generation" + $2 where "user"."id" in (select "id" from "user" where "user"."id" = $3 limit $4) returning ${columns}`, values: [date.toISOString(), 1, 'u1', 1], rows: [row], command: 'UPDATE' }, expected: fullUser },
]

describe.each(['invocation', 'promise-owner', 'effect-owner', 'fresh-child'] as const)('real adapter under %s', mode => {
  it.each(cases)('$name uses the real PostgreSQL builder and exactly one physical transaction', async testCase => {
    const f = fixture([...initialization(), { ...testCase.step }, { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
    let checkouts = 0
    const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
    const adapter = createAuthAdapter(tx, baOptions)
    const opts = options()
    const invoke = () => mode === 'fresh-child' ? adapter.transaction(child => testCase.call(child)) : testCase.call(adapter)
    const result = mode === 'effect-owner'
      ? await Effect.runPromise(tx.withAuthTransaction(opts, tx.invokeAuthPromise(opts, invoke)))
      : await tx.runAuthInvocation(opts, () => mode === 'promise-owner' ? tx.withAuthPromise(opts, invoke) : invoke())
    expect(result).toEqual(testCase.expected)
    expect(checkouts).toBe(1)
    expect(f.remaining()).toBe(0)
    expect(f.releases).toEqual([undefined])
    expect(f.dispatched).toHaveLength(6)
  })
})

it.each(cases)('$name refuses invocation context bypass before SQL', async testCase => {
  const f = fixture([])
  let checkouts = 0
  const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
  const adapter = createAuthAdapter(tx, baOptions)
  await expect(testCase.call(adapter)).rejects.toBeInstanceOf(PgTransactionError)
  expect(checkouts).toBe(0)
})

it('real adapter fails closed without invocation context, before checkout', async () => {
  let checkouts = 0
  const f = fixture([])
  const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
  const adapter: DBAdapter = createAuthAdapter(tx, {})
  await expect(adapter.findMany({ model: 'user' })).rejects.toBeInstanceOf(PgTransactionError)
  expect(checkouts).toBe(0)
})

it('fresh real child adapter retains generic results and joins its physical owner', async () => {
  const f = fixture([...initialization(), {
    text: 'select "id" from "user" where "user"."id" = $1', values: ['u1'], rows: [['u1']],
  }, { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, {})
  const result: { id: string } | null = await tx.runAuthInvocation(options(), () => adapter.transaction(async (child: DBTransactionAdapter) =>
    child.findOne<{ id: string }>({ model: 'user', where: [{ field: 'id', value: 'u1' }], select: ['id'] })))
  expect(result).toEqual({ id: 'u1' })
  expect(f.releases).toEqual([undefined])
  expect(f.remaining()).toBe(0)
})

it('decorates even a child operation that returns before consulting the Drizzle facade', async () => {
  const f = fixture([...initialization(), { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, baOptions)
  const child = await tx.runAuthInvocation(options(), () => adapter.transaction(async child => child))
  // Native BA update with empty where returns null without touching db. Root-only
  // wrapping would silently allow this stale child call outside any invocation.
  await expect(child.update({ model: 'user', where: [], update: { name: 'Ada' } })).rejects.toBeInstanceOf(PgTransactionError)
  expect(f.dispatched).toHaveLength(5)
  expect(f.releases).toEqual([undefined])
})

it('transaction itself refuses missing context before calling the callback', async () => {
  const f = fixture([])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, {})
  let called = false
  await expect(adapter.transaction(async () => { called = true })).rejects.toBeInstanceOf(PgTransactionError)
  expect(called).toBe(false)
  expect(f.dispatched).toEqual([])
})

it('provider work runs within invocation options before any checkout', async () => {
  let checkouts = 0
  const f = fixture([...initialization(), { text: 'select count(*) from "user" where "user"."id" = $1', values: ['u1'], rows: [[1]] }, { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
  const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
  const adapter = createAuthAdapter(tx, {})
  await tx.runAuthInvocation(options(), async () => {
    await Promise.resolve('test-only provider result')
    expect(checkouts).toBe(0)
    expect(await adapter.count({ model: 'user', where })).toBe(1)
  })
  expect(checkouts).toBe(1)
  expect(f.releases).toEqual([undefined])
})

it('nested real adapter transactions share one BEGIN and propagate callback rollback', async () => {
  const f = fixture([...initialization(), { text: 'select count(*) from "user" where "user"."id" = $1', values: ['u1'], rows: [[1]] }, { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, {})
  class BusinessDenied extends Error {}
  const denied = new BusinessDenied('safe reason')
  await expect(tx.runAuthInvocation(options(), () => adapter.transaction(() => adapter.transaction(async child => {
    expect(await child.count({ model: 'user', where })).toBe(1)
    throw denied
  })))).rejects.toBe(denied)
  expect(f.dispatched.map(item => item.text).filter(text => text.startsWith('BEGIN'))).toHaveLength(1)
  expect(f.remaining()).toBe(0)
  expect(f.releases).toEqual([undefined])
})

it('does not return a real mutation result when the physical commit rolls back', async () => {
  const countCase = cases.find(item => item.name === 'updateMany')
  if (!countCase) throw new Error('Missing case')
  const f = fixture([...initialization(), countCase.step, { text: 'COMMIT', command: 'ROLLBACK', status: 'I' }])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, baOptions)
  await expect(tx.runAuthInvocation(options(), () => countCase.call(adapter))).rejects.toMatchObject({ outcome: 'rolled-back' })
  expect(f.releases).toEqual([undefined])
})

it.each(['promise', 'effect'] as const)('real adapter transaction joins an enclosing %s owner', async mode => {
  const f = fixture([...initialization(), { text: 'select count(*) from "user" where "user"."id" = $1', values: ['u1'], rows: [[1]] }, { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
  let checkouts = 0
  const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
  const adapter = createAuthAdapter(tx, {})
  const opts = options()
  const call = () => adapter.transaction(child => child.count({ model: 'user', where }))
  const result = mode === 'effect' ? await Effect.runPromise(tx.withAuthTransaction(opts, tx.invokeAuthPromise(opts, call)))
    : await tx.withAuthPromise(opts, call)
  expect(result).toBe(1)
  expect(checkouts).toBe(1)
  expect(f.remaining()).toBe(0)
  expect(f.releases).toEqual([undefined])
})

it('real child query failures roll back and remove native SQL/parameter/cause data', async () => {
  const marker = 'private-adapter-email@example.test'
  const f = fixture([...initialization(), { text: 'select "id" from "user" where "user"."email" = $1', values: [marker], reject: true, status: 'E' }, { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, {})
  const error = await tx.runAuthInvocation(options(), () => adapter.transaction(child => child.findOne({ model: 'user', where: [{ field: 'email', value: marker }], select: ['id'] }))).catch(error => error)
  expect(error).toBeInstanceOf(PgTransactionError)
  const rendered = inspect(error, { depth: 20 })
  expect(rendered).not.toContain(marker)
  expect(rendered).not.toContain('select "id"')
  expect(rendered).not.toContain('private driver value')
  expect(f.releases).toEqual([undefined])
  expect(f.remaining()).toBe(0)
})

it('a recovered inner bridge timeout closes its real child adapter before subsequent invocation', async () => {
  const f = fixture([...initialization(), { text: 'select count(*) from "user" where "user"."id" = $1', values: ['u1'], hold: true }])
  const tx = createTransactions({ connect: async () => f.client }, limits)
  const adapter = createAuthAdapter(tx, {})
  const opts = { ...options(), cleanupTimeoutMs: 20 }
  let releasesAtBoundary: unknown[] = []
  let lateInvoked = false
  let lateFailed: boolean | undefined
  const result = await Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.uninterruptible(Effect.gen(function* () {
    yield* Effect.interruptible(tx.invokeAuthPromise(opts, () => adapter.transaction(child => child.count({ model: 'user', where })))).pipe(
      Effect.timeoutOrElse({ duration: 5, orElse: () => Effect.succeed(0) }),
    )
    releasesAtBoundary = [...f.releases]
    const late = yield* Effect.exit(tx.invokeAuthPromise(opts, () => {
      lateInvoked = true
      return adapter.count({ model: 'user', where })
    }))
    lateFailed = Exit.isFailure(late)
    return 'must-not-publish'
  }))))
  expect(releasesAtBoundary).toEqual([true])
  expect(lateInvoked).toBe(false)
  expect(lateFailed).toBe(true)
  expect(Exit.isFailure(result)).toBe(true)
  expect(f.pendingCount()).toBe(0)
  expect(f.dispatched).toHaveLength(5)
  expect(f.releases).toEqual([true])
})
