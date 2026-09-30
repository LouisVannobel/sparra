import { Cause, Effect, Exit, Schema } from 'effect'
import { inspect } from 'node:util'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { user } from '../../../src/modules/auth/schema.server'
import { PgTransactionError } from '../../../src/platform/db/auth-pg-lease.server'
import { createTransactions } from '../../../src/platform/db/transactions.server'
import { fixture, initialization } from './pg-client-fixture'

const limits = { maxStatementTimeoutMs: 500, maxCleanupTimeoutMs: 100 }
const options = () => ({ deadlineAtMs: Date.now() + 3000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: '3efaf2ac-d41e-43e9-aebe-f446bc233bb0' })
const select = 'select "id" from "user"'
const commit = { text: 'COMMIT', command: 'COMMIT', status: 'I' as const }
const rollback = { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' as const }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('shared auth transaction owner', () => {
  it('allows provider work only outside an enclosing physical lease', async () => {
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    await expect(tx.runAuthInvocation(opts, async () => tx.assertNoActiveAuthTransaction())).resolves.toBeUndefined()
    await expect(tx.withAuthPromise(opts, async () => tx.assertNoActiveAuthTransaction())).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.remaining()).toBe(0)
  })
  it('joins Effect after suspension and Promise invocation on one physical lease', async () => {
    const f = fixture([...initialization(), { text: select, values: [], rows: [['u1']] }, commit])
    let checkouts = 0
    const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
    const opts = options()
    const program = tx.withAuthTransaction(opts, Effect.gen(function* () {
      yield* Effect.yieldNow
      return yield* tx.withAuthTransaction(opts, tx.invokeAuthPromise(opts, () =>
        tx.withAuthPromise(opts, lease => lease.db.select({ id: user.id }).from(user).execute())))
    }))
    expect(await Effect.runPromise(program)).toEqual([{ id: 'u1' }])
    expect(checkouts).toBe(1)
    expect(f.remaining()).toBe(0)
    expect(f.releases).toEqual([undefined])
  })

  it('rejects mismatched options and rolls back before returning the failure', async () => {
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    await expect(tx.withAuthPromise(opts, () => tx.withAuthPromise({ ...opts, statementTimeoutMs: 1 }, async () => 1))).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.remaining()).toBe(0)
    expect(f.releases).toEqual([undefined])
  })

  it('deadline finalizes independently of a callback that never settles', async () => {
    const opts = { ...options(), deadlineAtMs: Date.now() + 60, statementTimeoutMs: 10 }
    // The requested statement bound is below the remaining deadline.
    const steps = initialization()
    steps[3] = { ...steps[3], values: ['10ms'] }
    const stalled = fixture([...steps, rollback])
    const owner = createTransactions({ connect: async () => stalled.client }, limits)
    await expect(owner.withAuthPromise(opts, () => new Promise<never>(() => {}))).rejects.toBeInstanceOf(PgTransactionError)
    expect(stalled.remaining()).toBe(0)
    expect(stalled.releases).toEqual([undefined])
  })

  it('Effect interruption awaits rollback and invalidates inherited builders', async () => {
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    const controller = new AbortController()
    let stale: PromiseLike<unknown> | undefined
    const running = Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.gen(function* () {
      yield* tx.invokeAuthPromise(opts, async () => {
        stale = tx.currentDb().select({ id: user.id }).from(user)
      })
      return yield* Effect.never
    })), { signal: controller.signal })
    await tick()
    controller.abort()
    expect(Exit.isFailure(await running)).toBe(true)
    expect(f.releases).toEqual([undefined])
    await expect(Promise.resolve(stale)).rejects.toBeDefined()
    expect(f.dispatched).toHaveLength(5)
  })

  it('preserves intentional typed business failure after rollback', async () => {
    class Denied extends Schema.TaggedError<Denied>()('Denied', {}) {}
    const denied = new Denied()
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const result = await Effect.runPromise(tx.withAuthTransaction(options(), Effect.fail(denied)).pipe(Effect.flip))
    expect(result).toBe(denied)
    expect(f.releases).toEqual([undefined])
  })

  it('preserves a native UnknownError containing a safe business failure', async () => {
    class Denied extends Schema.TaggedError<Denied>()('Denied', {}) {}
    const denied = new Denied()
    const wrapped = new Cause.UnknownError(denied)
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const result = await Effect.runPromise(tx.withAuthTransaction(options(), Effect.fail(wrapped)).pipe(Effect.flip))
    expect(result).toBe(wrapped)
    if (!Cause.isUnknownError(result)) throw new Error('Expected preserved native envelope')
    expect(result.cause).toBe(denied)
    expect(f.releases).toEqual([undefined])
  })

  it('does not relabel a foreign Effect owner as a matching participant', async () => {
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    let foreignCheckouts = 0
    const foreign = createTransactions({ async connect() { foreignCheckouts++; return f.client } }, limits)
    const opts = options()
    const result = await Effect.runPromiseExit(tx.withAuthTransaction(opts, foreign.withAuthTransaction(opts, Effect.succeed(1))))
    expect(Exit.isFailure(result)).toBe(true)
    expect(foreignCheckouts).toBe(0)
    expect(f.remaining()).toBe(0)
    expect(f.releases).toEqual([undefined])
  })

  it.each(['promise', 'effect'] as const)('keeps concurrent %s roots on independent checkouts', async mode => {
    const a = fixture([...initialization(), { text: select, values: [], rows: [['a']], hold: true }, commit])
    const b = fixture([...initialization(), { text: select, values: [], rows: [['b']], hold: true }, commit])
    const clients = [a.client, b.client]
    const tx = createTransactions({ async connect() { const client = clients.shift(); if (!client) throw new Error('Too many checkouts'); return client } }, limits)
    const run = () => {
      const opts = options()
      const work = () => tx.withAuthPromise(opts, lease => lease.db.select({ id: user.id }).from(user).execute())
      return mode === 'promise' ? work() : Effect.runPromise(tx.withAuthTransaction(opts, tx.invokeAuthPromise(opts, work)))
    }
    const first = run()
    const second = run()
    await tick()
    b.complete()
    expect(await second).toEqual([{ id: 'b' }])
    expect(a.releases).toEqual([])
    a.complete()
    expect(await first).toEqual([{ id: 'a' }])
    expect(a.releases).toEqual([undefined])
    expect(b.releases).toEqual([undefined])
  })

  it.each(['promise', 'effect', 'effect-defect'] as const)('sanitizes the actual Drizzle SQL/params/cause wrapper at the %s boundary', async mode => {
    const marker = 'private-sql-parameter-marker'
    const f = fixture([...initialization(), {
      text: 'select "id" from "user" where "user"."email" = $1', values: [marker], reject: true, status: 'E',
    }, rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    const query = () => tx.currentDb().select({ id: user.id }).from(user).where(eq(user.email, marker)).execute()
    let error: unknown
    if (mode === 'promise') error = await tx.withAuthPromise(opts, query).catch(error => error)
    else {
      error = await Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.gen(function* () {
        const builder = yield* tx.invokeAuthPromise(opts, async () => ({
          query: tx.currentDb().select({ id: user.id }).from(user).where(eq(user.email, marker)),
        }))
        return yield* (mode === 'effect' ? Effect.tryPromise({ try: () => builder.query.execute(), catch: error => error })
          : Effect.promise(() => builder.query.execute()))
      })))
    }
    const rendered = inspect(error, { depth: 20 })
    expect(rendered).toContain('PgTransactionError')
    expect(rendered).not.toContain(marker)
    expect(rendered).not.toContain('private driver value')
    expect(rendered).not.toContain('select "id"')
    expect(f.releases).toEqual([undefined])
    expect(f.remaining()).toBe(0)
  })

  it('redacts a real Drizzle rejection wrapped by native default Effect.tryPromise', async () => {
    const marker = 'private-default-tryPromise-marker'
    const f = fixture([...initialization(), {
      text: 'select "id" from "user" where "user"."email" = $1', values: [marker], reject: true, status: 'E',
    }, rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    const result = await Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.gen(function* () {
      const { query } = yield* tx.invokeAuthPromise(opts, async () => ({
        query: tx.currentDb().select({ id: user.id }).from(user).where(eq(user.email, marker)),
      }))
      return yield* Effect.tryPromise(() => query.execute())
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.remaining()).toBe(0)
    expect(f.releases).toEqual([undefined])
    const rendered = inspect(result, { depth: 20 })
    expect(rendered).not.toContain(marker)
    expect(rendered).not.toContain('select "id"')
    expect(rendered).not.toContain('DrizzleQueryError')
    expect(rendered).not.toContain('private driver value')
    if (!Exit.isFailure(result)) throw new Error('Expected failure')
    const reason = result.cause.reasons[0]
    if (!Cause.isFailReason(reason)) throw new Error('Expected typed failure')
    expect(reason.error).toBeInstanceOf(PgTransactionError)
    expect(reason.error).not.toHaveProperty('cause')
  })

  it('awaits the recorded pending COMMIT when abort requests conflicting rollback', async () => {
    const f = fixture([...initialization(), { ...commit, hold: true }])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const controller = new AbortController()
    let returned = false
    const result = tx.withAuthPromise({ ...options(), signal: controller.signal }, async () => 'must-not-publish').catch(error => error).finally(() => { returned = true })
    await tick()
    expect(f.dispatched.at(-1)?.text).toBe('COMMIT')
    controller.abort()
    await tick()
    expect(returned).toBe(false)
    expect(f.releases).toEqual([])
    f.complete()
    expect(await result).toMatchObject({ name: 'PgTransactionError', outcome: 'committed' })
    expect(f.releases).toEqual([undefined])
  })

  it('does not publish success if PostgreSQL resolves requested COMMIT as ROLLBACK', async () => {
    const f = fixture([...initialization(), { ...commit, command: 'ROLLBACK' }])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    await expect(tx.withAuthPromise(options(), async () => 'must-not-publish')).rejects.toMatchObject({ outcome: 'rolled-back' })
    expect(f.releases).toEqual([undefined])
  })

  it('client abort finalizes a callback that ignores its signal', async () => {
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const controller = new AbortController()
    const result = tx.withAuthPromise({ ...options(), signal: controller.signal }, () => new Promise<never>(() => {})).catch(error => error)
    await tick()
    controller.abort()
    expect(await result).toBeInstanceOf(PgTransactionError)
    expect(f.releases).toEqual([undefined])
  })

  it.each(['expired', 'aborted', 'zero-statement', 'zero-cleanup', 'nan-deadline'] as const)('rejects %s before checkout', async invalid => {
    const f = fixture([])
    let checkouts = 0
    const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
    const opts = options()
    if (invalid === 'expired') opts.deadlineAtMs = Date.now() - 1
    if (invalid === 'zero-statement') opts.statementTimeoutMs = 0
    if (invalid === 'zero-cleanup') opts.cleanupTimeoutMs = 0
    if (invalid === 'nan-deadline') opts.deadlineAtMs = Number.NaN
    const signal = invalid === 'aborted' ? AbortSignal.abort() : undefined
    await expect(tx.withAuthPromise({ ...opts, signal }, async () => 1)).rejects.toBeInstanceOf(PgTransactionError)
    expect(checkouts).toBe(0)
  })

  it('independently destroys a native prepared-name rejection with no ReadyForQuery', async () => {
    const setup = initialization()
    setup[3] = { ...setup[3], values: ['10ms'] }
    const f = fixture([...setup, { text: select, values: [], nativePreparedConflict: { name: 'collision', previousSql: 'select private-prior-sql' } }])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = { ...options(), deadlineAtMs: Date.now() + 60, statementTimeoutMs: 10, cleanupTimeoutMs: 20 }
    const result = tx.withAuthPromise(opts, lease => lease.db.select({ id: user.id }).from(user).prepare('collision').execute()).catch(error => error)
    await tick()
    expect(f.nativeRejections).toEqual(["Prepared statements must be unique - 'collision' was used for a different statement"])
    expect(f.events.filter(event => event.startsWith('ready:'))).toHaveLength(4)
    expect(f.releases).toEqual([])
    expect(await result).toBeInstanceOf(PgTransactionError)
    expect(f.releases).toEqual([true])
    expect(f.client.connection.stream.destroyed).toBe(true)
    expect(f.listeners()).toBe(0)
    expect(f.remaining()).toBe(0)
  })

  it('deadline interrupts an Effect that never settles and awaits rollback', async () => {
    const setup = initialization()
    setup[3] = { ...setup[3], values: ['10ms'] }
    const f = fixture([...setup, rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const result = await Effect.runPromiseExit(tx.withAuthTransaction({ ...options(), deadlineAtMs: Date.now() + 60, statementTimeoutMs: 10 }, Effect.never))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.releases).toEqual([undefined])
    expect(f.remaining()).toBe(0)
  })

  it('Effect interruption drains a pending query or destroys it within cleanup bound', async () => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true }])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = { ...options(), cleanupTimeoutMs: 20 }
    const controller = new AbortController()
    let invocationSignal: AbortSignal | undefined
    const result = Effect.runPromiseExit(tx.withAuthTransaction(opts, tx.invokeAuthPromise(opts, signal => {
      invocationSignal = signal
      return tx.currentDb().select({ id: user.id }).from(user).execute()
    })), { signal: controller.signal })
    await tick()
    controller.abort()
    expect(Exit.isFailure(await result)).toBe(true)
    expect(f.releases).toEqual([true])
    expect(f.pendingCount()).toBe(0)
    expect(f.client.connection.stream.destroyed).toBe(true)
    expect(invocationSignal?.aborted).toBe(true)
  })

  it('a swallowed nested failure cannot turn a rolled-back physical owner into success', async () => {
    const f = fixture([...initialization(), rollback])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    await expect(tx.withAuthPromise(opts, async () => {
      await tx.withAuthPromise(opts, async () => { throw new Error('safe failure') }).catch(() => {})
      return 'must-not-publish'
    })).rejects.toMatchObject({ outcome: 'rolled-back' })
    expect(f.releases).toEqual([undefined])
  })

  it('caps requested statement and cleanup bounds at the configured ceilings', async () => {
    const f = fixture([...initialization(), { ...commit, hold: true }])
    const tx = createTransactions({ connect: async () => f.client }, { ...limits, maxCleanupTimeoutMs: 20 })
    await expect(tx.withAuthPromise({ ...options(), statementTimeoutMs: 2000, cleanupTimeoutMs: 2000 }, async () => 1)).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.dispatched[3].values).toEqual(['500ms'])
    expect(f.releases).toEqual([true])
  })

  it('Effect invocation bridge requires an active owner and never calls unscoped BA', async () => {
    let checkouts = 0
    let calls = 0
    const f = fixture([])
    const tx = createTransactions({ async connect() { checkouts++; return f.client } }, limits)
    const result = await Effect.runPromiseExit(tx.invokeAuthPromise(options(), async () => { calls++; return 1 }))
    expect(Exit.isFailure(result)).toBe(true)
    expect(calls).toBe(0)
    expect(checkouts).toBe(0)
  })

  it('refuses BEGIN when the deadline expires during checkout before timer delivery', async () => {
    const f = fixture([])
    const queries = vi.spyOn(f.client, 'query')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const tx = createTransactions({ async connect() { clock.mockReturnValue(3001); return f.client } }, limits)
      await expect(tx.withAuthPromise({ ...options(), deadlineAtMs: 3000 }, async () => 1)).rejects.toBeInstanceOf(PgTransactionError)
      expect(queries).not.toHaveBeenCalled()
      expect(f.dispatched).toEqual([])
      expect(f.releases).toEqual([true])
      expect(f.listeners()).toBe(0)
    } finally { clock.mockRestore() }
  })

  it('bounds statement timeout by the deadline remaining after checkout', async () => {
    const setup = initialization()
    setup[3] = { ...setup[3], values: ['200ms'] }
    const f = fixture([...setup, commit])
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const tx = createTransactions({ async connect() { clock.mockReturnValue(2800); return f.client } }, limits)
      expect(await tx.withAuthPromise({ ...options(), deadlineAtMs: 3000 }, async () => 1)).toBe(1)
      expect(f.remaining()).toBe(0)
      expect(f.releases).toEqual([undefined])
    } finally { clock.mockRestore() }
  })

  it('evicts a late pool checkout after an aborted invocation, without BEGIN', async () => {
    const f = fixture([])
    const controller = new AbortController()
    let giveClient: (client: typeof f.client) => void = () => {}
    const pending = new Promise<typeof f.client>(resolve => { giveClient = resolve })
    const tx = createTransactions({ connect: () => pending }, limits)
    const result = tx.withAuthPromise({ ...options(), signal: controller.signal }, async () => 1).catch(error => error)
    controller.abort()
    expect(await result).toBeInstanceOf(PgTransactionError)
    giveClient(f.client)
    await tick()
    expect(f.releases).toEqual([true])
    expect(f.dispatched).toEqual([])
  })

  it.each(['promise', 'effect'] as const)('checks the absolute deadline before %s commit even before timer delivery', async mode => {
    const f = fixture([...initialization(), rollback])
    const queries = vi.spyOn(f.client, 'query')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const tx = createTransactions({ connect: async () => f.client }, limits)
      const opts = { ...options(), deadlineAtMs: 3000 }
      const call = () => { clock.mockReturnValue(3001); return 'must-not-publish' }
      if (mode === 'promise') await expect(tx.withAuthPromise(opts, async () => call())).rejects.toBeInstanceOf(PgTransactionError)
      else expect(Exit.isFailure(await Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.sync(call))))).toBe(true)
      expect(queries.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
      expect(f.releases).toEqual([undefined])
    } finally { clock.mockRestore() }
  })

  it('a locally recovered bridge timeout closes a held callback before continuation and denies late SQL', async () => {
    const f = fixture([...initialization(), rollback])
    const queries = vi.spyOn(f.client, 'query')
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = options()
    let releaseCallback = () => {}
    const held = new Promise<void>(resolve => { releaseCallback = resolve })
    let callbackResult: Promise<unknown> | undefined
    let invocationSignal: AbortSignal | undefined
    let continued = false
    let abortedAtBoundary: boolean | undefined
    let releasesAtBoundary: unknown[] = []
    let lateResult: unknown
    const result = await Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.uninterruptible(Effect.gen(function* () {
      yield* Effect.interruptible(tx.invokeAuthPromise(opts, signal => {
        invocationSignal = signal
        const builder = tx.currentDb().select({ id: user.id }).from(user)
        callbackResult = held.then(() => builder.execute()).catch(error => error)
        return callbackResult
      })).pipe(Effect.timeoutOrElse({ duration: 5, orElse: () => Effect.succeed('fallback') }))
      // Observe after timeoutOrElse joins its loser, not inside its orElse branch.
      continued = true
      abortedAtBoundary = invocationSignal?.aborted
      releasesAtBoundary = [...f.releases]
      if (!abortedAtBoundary) return 'must-not-publish'
      releaseCallback()
      lateResult = yield* Effect.promise(() => Promise.resolve(callbackResult))
      return 'must-not-publish'
    }))))
    releaseCallback()
    expect(continued).toBe(true)
    expect(abortedAtBoundary).toBe(true)
    expect(releasesAtBoundary).toEqual([undefined])
    expect(lateResult).toBeInstanceOf(Error)
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.releases).toEqual([undefined])
    expect(queries).toHaveBeenCalledTimes(5)
  })

  it('a locally recovered bridge timeout awaits bounded destruction of its pending real builder', async () => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true }])
    const tx = createTransactions({ connect: async () => f.client }, limits)
    const opts = { ...options(), cleanupTimeoutMs: 20 }
    let invocationSignal: AbortSignal | undefined
    let continued = false
    let abortedAtBoundary: boolean | undefined
    let releasesAtBoundary: unknown[] = []
    let pendingAtBoundary: number | undefined
    let destroyedAtBoundary: boolean | undefined
    let lateFailed: boolean | undefined
    const result = await Effect.runPromiseExit(tx.withAuthTransaction(opts, Effect.uninterruptible(Effect.gen(function* () {
      yield* Effect.interruptible(tx.invokeAuthPromise(opts, signal => {
        invocationSignal = signal
        return tx.currentDb().select({ id: user.id }).from(user).execute()
      })).pipe(Effect.timeoutOrElse({ duration: 5, orElse: () => Effect.succeed('fallback') }))
      continued = true
      abortedAtBoundary = invocationSignal?.aborted
      releasesAtBoundary = [...f.releases]
      pendingAtBoundary = f.pendingCount()
      destroyedAtBoundary = f.client.connection.stream.destroyed
      const late = yield* Effect.exit(tx.invokeAuthPromise(opts, async () => 'late-success'))
      lateFailed = Exit.isFailure(late)
      return 'must-not-publish'
    }))))
    expect(continued).toBe(true)
    expect(abortedAtBoundary).toBe(true)
    expect(releasesAtBoundary).toEqual([true])
    expect(pendingAtBoundary).toBe(0)
    expect(destroyedAtBoundary).toBe(true)
    expect(lateFailed).toBe(true)
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.releases).toEqual([true])
  })
})
