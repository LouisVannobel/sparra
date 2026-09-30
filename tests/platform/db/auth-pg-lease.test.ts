import { describe, expect, it, vi } from 'vitest'
import { user } from '../../../src/modules/auth/schema.server'
import { openAuthPgLease, PgTransactionError } from '../../../src/platform/db/auth-pg-lease.server'
import { guardedPgQuery } from '../../../src/platform/db/guarded-pg-query.server'
import { Query } from 'pg'
import { fixture, initialization } from './pg-client-fixture'

const options = { statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId: '3efaf2ac-d41e-43e9-aebe-f446bc233bb0' }
const select = 'select "id" from "user"'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('auth physical pg lease (scripted protocol, real Drizzle)', () => {
  const principal = { userId: 'additional-user', sessionId: 'additional-session', name: 'Fixture', email: 'fixture@example.test' }
  const resolveWorkspace = (workspaceId: string | null) => [
    { text: "SELECT set_config('app.correlation_id', $1, true)", values: [options.correlationId] },
    { text: 'SELECT app_private.resolve_personal_workspace($1, $2, $3) AS workspace_id', values: [principal.userId, principal.sessionId, false], rows: [{ workspace_id: workspaceId }] },
  ]
  it('additional_workspace_retains_auth_sentinel_and_uuid_only', async () => {
    const id = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
    const f = fixture([...initialization(), ...resolveWorkspace(id), { text: select, values: [], rows: [] }, { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    try {
      expect(typeof Reflect.get(lease, 'resolveAdditionalPasskeyWorkspace')).toBe('function')
      expect(await lease.resolveAdditionalPasskeyWorkspace(principal)).toBe(id)
      expect(await lease.db.select({ id: user.id }).from(user)).toEqual([])
      expect(f.dispatched.filter(item => item.text.includes("set_config('app.tenant_id'")).length).toBe(1)
      await expect(lease.selectPersonalWorkspace(principal, false)).rejects.toBeInstanceOf(PgTransactionError)
    } finally { await lease.finalize('rollback') }
  })
  it('additional_workspace_null_never_provisions', async () => {
    const f = fixture([...initialization(), ...resolveWorkspace(null), { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    try {
      expect(typeof Reflect.get(lease, 'resolveAdditionalPasskeyWorkspace')).toBe('function')
      expect(await lease.resolveAdditionalPasskeyWorkspace(principal)).toBeNull()
    } finally { await lease.finalize('rollback') }
  })
  it('additional_workspace_rejects_personal_mode_and_invalid_uuid', async () => {
    for (const selected of ['invalid', '00000000-0000-0000-0000-000000000000', null]) {
      const f = fixture([...initialization(), ...resolveWorkspace(selected), { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
      const lease = await openAuthPgLease(f.client, options)
      try {
        expect(typeof Reflect.get(lease, 'resolveAdditionalPasskeyWorkspace')).toBe('function')
        if (selected === null) {
          await lease.selectPersonalWorkspace(principal, false)
          await expect(lease.resolveAdditionalPasskeyWorkspace(principal)).rejects.toBeInstanceOf(PgTransactionError)
        } else await expect(lease.resolveAdditionalPasskeyWorkspace(principal)).rejects.toBeInstanceOf(PgTransactionError)
      } finally { await lease.finalize('rollback') }
    }
  })
  it('denies client escape and reflective mutation through real prepared builders', async () => {
    const f = fixture([...initialization(), { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    expect(Object.keys(lease.db)).toEqual(['select', 'insert', 'update', 'delete'])
    for (const key of ['connection', 'release', 'end', '$client', 'transaction']) expect(Reflect.get(lease.db, key)).toBeUndefined()
    const prepared = lease.db.select({ id: user.id }).from(user).prepare('inspection-only')
    const guarded: unknown = Reflect.get(prepared, 'client')
    if (typeof guarded !== 'object' || guarded === null) throw new Error('Expected pinned Drizzle client')
    for (const key of ['connection', 'release', 'end', '$client', 'transaction']) expect(() => Reflect.get(guarded, key)).toThrow(PgTransactionError)
    expect(() => Reflect.getOwnPropertyDescriptor(guarded, 'query')).toThrow(PgTransactionError)
    expect(() => Reflect.ownKeys(guarded)).toThrow(PgTransactionError)
    expect(() => Reflect.getPrototypeOf(guarded)).toThrow(PgTransactionError)
    expect(() => Reflect.set(guarded, 'query', () => {})).toThrow(PgTransactionError)
    expect(() => Reflect.defineProperty(guarded, 'query', { value: () => {} })).toThrow(PgTransactionError)
    expect(() => Reflect.deleteProperty(guarded, 'query')).toThrow(PgTransactionError)
    expect(() => Reflect.setPrototypeOf(guarded, {})).toThrow(PgTransactionError)
    expect(() => Reflect.preventExtensions(guarded)).toThrow(PgTransactionError)
    const extracted: unknown = Reflect.get(guarded, 'query')
    if (typeof extracted !== 'function') throw new Error('Expected guarded query')
    expect(() => extracted('SELECT forbidden', () => {})).toThrow(PgTransactionError)
    expect(() => extracted(new Query('SELECT forbidden'))).toThrow(PgTransactionError)
    await lease.finalize('rollback')
    expect(() => extracted('SELECT forbidden')).toThrow(PgTransactionError)
    expect(() => Reflect.get(guarded, 'query')).toThrow()
    expect(f.dispatched).toHaveLength(5)
  })

  it('preserves config/values and both Promise row modes, synchronously refusing opaque overloads', async () => {
    const f = fixture([
      { text: 'SELECT object', values: ['inline'], rows: [{ id: 'object' }] },
      { text: 'SELECT array', values: ['separate'], rows: [['array']] },
    ])
    let admissions = 0
    const query = guardedPgQuery(f.client.query.bind(f.client), run => { admissions++; return run() }, () => new PgTransactionError('query', 'unknown', options.correlationId))
    expect((await query<{ id: string }>({ text: 'SELECT object', values: ['inline'] })).rows).toEqual([{ id: 'object' }])
    expect((await query<[string]>({ text: 'SELECT array', rowMode: 'array' }, ['separate'])).rows).toEqual([['array']])
    expect(() => query('SELECT denied', () => {})).toThrow(PgTransactionError)
    expect(() => query('SELECT denied', [], () => {})).toThrow(PgTransactionError)
    expect(() => query({ text: 'SELECT denied', rowMode: 'array' }, () => {})).toThrow(PgTransactionError)
    expect(() => query(new Query('SELECT denied'))).toThrow(PgTransactionError)
    const callbackConfig = { text: 'SELECT denied', callback: () => {} }
    expect(() => query(callbackConfig)).toThrow(PgTransactionError)
    expect(admissions).toBe(2)
  })

  it('treats an unsolicited wire completion as terminal instead of reusing stale proof', async () => {
    const f = fixture([...initialization()])
    const lease = await openAuthPgLease(f.client, options)
    f.ready('T')
    expect(f.releases).toEqual([true])
    await expect(lease.finalize('rollback')).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.releases).toEqual([true])
    expect(f.dispatched).toHaveLength(4)
  })

  it('keeps rejected business work classified as query when finalization is already draining', async () => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true, reject: true, status: 'E' }, { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    const work = lease.db.select({ id: user.id }).from(user).execute().catch(error => error)
    await tick()
    const finish = lease.finalize('rollback')
    f.complete()
    // Drizzle adds its native SQL wrapper; our cause stays small and redacted.
    expect(await work).toMatchObject({ cause: { phase: 'query', outcome: 'unknown', correlationId: options.correlationId } })
    await finish
  })

  it('initializes before real array and object mode builders and releases a proven commit', async () => {
    const f = fixture([...initialization(), { text: select, values: [], rows: [['u1']] }, { text: 'delete from "user"', values: [], command: 'DELETE' }, { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    expect(await lease.db.select({ id: user.id }).from(user).execute()).toEqual([{ id: 'u1' }])
    expect((await lease.db.delete(user).execute()).command).toBe('DELETE')
    expect(f.dispatched.map(item => item.rowMode)).toEqual([undefined, undefined, undefined, undefined, 'array', undefined])
    expect(await lease.finalize('commit')).toBe('committed')
    expect(f.releases).toEqual([undefined])
    expect(f.listeners()).toBe(0)
  })

  it('owns FIFO admission and closes immediately while draining, then rejects stale builders on reuse', async () => {
    const f = fixture([...initialization(), { text: select, values: [], rows: [['first']], hold: true }, { text: select, values: [], rows: [['second']] }, { text: 'COMMIT', command: 'COMMIT', status: 'I' }, ...initialization(), { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    const stale = lease.db.select({ id: user.id }).from(user)
    const extracted = lease.db.select
    const one = stale.execute()
    const two = lease.db.select({ id: user.id }).from(user).execute()
    await tick()
    expect(f.dispatched).toHaveLength(5)
    const done = lease.finalize('commit')
    expect(lease.finalize('commit')).toBe(done)
    await expect(lease.finalize('rollback')).rejects.toBeInstanceOf(PgTransactionError)
    await expect(stale.execute()).rejects.toThrow()
    f.complete()
    expect(await one).toEqual([{ id: 'first' }])
    expect(await two).toEqual([{ id: 'second' }])
    await done
    expect(lease.finalize('commit')).toBe(done)
    await expect(lease.finalize('rollback')).rejects.toBeInstanceOf(PgTransactionError)
    const reused = await openAuthPgLease(f.client, options)
    await expect(stale.execute()).rejects.toThrow()
    await expect(extracted({ id: user.id }).from(user).execute()).rejects.toThrow()
    await reused.finalize('rollback')
    expect(f.releases).toEqual([undefined, undefined])
    expect(f.listeners()).toBe(0)
  })

  it('waits beyond ErrorResponse, skips admitted work and refuses an aborted commit', async () => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true, reject: true, status: 'E' }, { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    const first = lease.db.select({ id: user.id }).from(user).execute().catch(error => error)
    const second = lease.db.select({ id: user.id }).from(user).execute().catch(error => error)
    await tick()
    f.rejectBeforeReady()
    const done = lease.finalize('commit')
    await tick()
    expect(f.dispatched).toHaveLength(5)
    expect(f.releases).toEqual([])
    f.complete()
    expect(await first).toBeInstanceOf(Error)
    expect(await second).toBeInstanceOf(Error)
    expect(await done).toBe('rolled-back')
    expect(f.releases).toEqual([undefined])
    expect(f.events.slice(8)).toEqual([
      'query:select "id" from "user"', 'error-response', 'ready:E',
      'query:ROLLBACK', 'ready:I', 'release:clean',
    ])
  })

  it.each(['idle', 'missing-public-status'])('evicts business completion with %s instead of accepting stale transaction proof', async failure => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true, status: failure === 'idle' ? 'I' : 'T' }])
    const lease = await openAuthPgLease(f.client, options)
    const work = lease.db.select({ id: user.id }).from(user).execute().catch(error => error)
    await tick()
    if (failure === 'missing-public-status') f.client.getTransactionStatus = () => null
    f.complete()
    expect(await work).toBeInstanceOf(Error)
    await expect(lease.finalize('commit')).rejects.toMatchObject({ outcome: 'unknown' })
    expect(f.releases).toEqual([true])
    expect(f.dispatched).toHaveLength(5)
    expect(f.listeners()).toBe(0)
  })

  it.each(['COMMIT', 'ROLLBACK'])('classifies fresh idle with terminal command %s', async command => {
    const f = fixture([...initialization(), { text: 'COMMIT', command, status: 'I' }])
    const lease = await openAuthPgLease(f.client, options)
    expect(await lease.finalize('commit')).toBe(command === 'COMMIT' ? 'committed' : 'rolled-back')
  })

  it.each([
    { command: 'COMMIT', status: 'I' as const, noReady: true },
    { command: 'COMMIT', status: null },
    { command: 'SELECT', status: 'I' as const },
    { command: 'COMMIT', status: 'T' as const },
    { command: 'COMMIT', status: 'I' as const, reject: true },
  ])('destroys ambiguous finalization %#', async terminal => {
    const f = fixture([...initialization(), { text: 'COMMIT', ...terminal }])
    const lease = await openAuthPgLease(f.client, { ...options, cleanupTimeoutMs: 15 })
    await expect(lease.finalize('commit')).rejects.toMatchObject({ phase: 'finalize', outcome: 'unknown' })
    expect(f.releases).toEqual([true])
    expect(f.client.connection.stream.destroyed).toBe(true)
    await tick()
    expect(f.pendingCount()).toBe(0)
    expect(f.listeners()).toBe(0)
  })

  it.each(['error', 'end', 'close'])('evicts on transport %s while work is pending', async event => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true }])
    const lease = await openAuthPgLease(f.client, options)
    const work = lease.db.select({ id: user.id }).from(user).execute().catch(error => error)
    await tick()
    if (event === 'close') f.client.connection.stream.emit('close')
    else if (event === 'error') f.client.emit('error', new Error('private driver value'))
    else f.client.emit('end')
    expect(await work).toBeInstanceOf(Error)
    await expect(lease.finalize('rollback')).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.releases).toEqual([true])
    await tick()
    expect(f.pendingCount()).toBe(0)
    expect(f.listeners()).toBe(0)
  })

  it.each([null, 'T', 'E'] as const)('refuses an unclean initial checkout %s without SQL', async status => {
    const f = fixture([], status)
    await expect(openAuthPgLease(f.client, options)).rejects.toMatchObject({ phase: 'initialize', outcome: 'not-started' })
    expect(f.dispatched).toEqual([])
    expect(f.releases).toEqual([true])
  })

  it.each(['wrong-isolation', 'null-status', 'failed-begin', 'missing-ready'])('fails initialization %s before exposure', async failure => {
    const steps = initialization()
    if (failure === 'wrong-isolation') steps[2].rows = [{ isolation: 'serializable' }]
    if (failure === 'null-status') steps[0].status = null
    if (failure === 'failed-begin') steps[0].reject = true
    if (failure === 'missing-ready') steps[0].noReady = true
    const f = fixture(steps)
    await expect(openAuthPgLease(f.client, { ...options, cleanupTimeoutMs: 15 })).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.releases).toEqual([true])
    expect(f.listeners()).toBe(0)
  })

  it.each([0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])('validates both timeout budgets %s before SQL', async value => {
    for (const key of ['statementTimeoutMs', 'cleanupTimeoutMs']) {
      const f = fixture([])
      await expect(openAuthPgLease(f.client, { ...options, [key]: value })).rejects.toMatchObject({ outcome: 'not-started' })
      expect(f.dispatched).toEqual([])
      expect(f.releases).toEqual([true])
    }
  })

  it('replaces unsafe correlation values and retains no driver or SQL cause', async () => {
    const f = fixture([])
    const error: unknown = await openAuthPgLease(f.client, { ...options, correlationId: 'postgres://private' }).catch(error => error)
    expect(error).toBeInstanceOf(PgTransactionError)
    expect(error).toMatchObject({ message: 'PostgreSQL transaction failed', phase: 'initialize', outcome: 'not-started' })
    expect(JSON.stringify(error)).not.toContain('private')
    expect(error).not.toHaveProperty('cause')
    if (error instanceof PgTransactionError) expect(error.correlationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('bounds draining and terminates the transport on the cleanup deadline', async () => {
    const f = fixture([...initialization(), { text: select, values: [], hold: true }])
    const lease = await openAuthPgLease(f.client, { ...options, cleanupTimeoutMs: 15 })
    const work = lease.db.select({ id: user.id }).from(user).execute().catch(error => error)
    await tick()
    await expect(lease.finalize('rollback')).rejects.toBeInstanceOf(PgTransactionError)
    expect(await work).toBeInstanceOf(Error)
    expect(f.releases).toEqual([true])
    expect(f.client.connection.stream.destroyed).toBe(true)
    await tick()
    expect(f.pendingCount()).toBe(0)
    expect(f.listeners()).toBe(0)
  })

  it.each([
    { command: 'COMMIT', status: 'I' as const },
    { command: 'ROLLBACK', status: 'I' as const, reject: true },
    { command: 'ROLLBACK', status: 'I' as const, noReady: true },
  ])('never reports rollback from an ambiguous rollback command %#', async terminal => {
    const f = fixture([...initialization(), { text: 'ROLLBACK', ...terminal }])
    const lease = await openAuthPgLease(f.client, { ...options, cleanupTimeoutMs: 15 })
    await expect(lease.finalize('rollback')).rejects.toMatchObject({ phase: 'finalize', outcome: 'unknown' })
    expect(f.releases).toEqual([true])
    expect(f.listeners()).toBe(0)
  })

  it('clears budget timers on initialization and clean finalization', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = fixture([...initialization(), { text: 'COMMIT', command: 'COMMIT', status: 'I' }])
      const lease = await openAuthPgLease(f.client, options)
      expect(vi.getTimerCount()).toBe(0)
      await lease.finalize('commit')
      expect(vi.getTimerCount()).toBe(0)
      expect(f.pendingCount()).toBe(0)
      expect(f.listeners()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('bounds initialization before statement_timeout is configured', async () => {
    const f = fixture([{ text: 'BEGIN ISOLATION LEVEL READ COMMITTED', hold: true }])
    await expect(openAuthPgLease(f.client, { ...options, cleanupTimeoutMs: 15 })).rejects.toMatchObject({ phase: 'initialize', outcome: 'unknown' })
    await tick()
    expect(f.client.connection.stream.destroyed).toBe(true)
    expect(f.pendingCount()).toBe(0)
    expect(f.listeners()).toBe(0)
    expect(f.releases).toEqual([true])
  })
})
