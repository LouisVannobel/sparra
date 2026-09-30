import { randomUUID } from 'node:crypto'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PoolClient, QueryResult, QueryResultRow, TransactionStatus } from 'pg'
import { authSchema } from '../../modules/auth/schema.server'
import type { AdmittedPrincipal } from '../../modules/auth/session.server'
import { workspace, workspaceSchema } from '../../modules/workspaces/schema.server'
import { eq } from 'drizzle-orm'
import { guardedPgQuery } from './guarded-pg-query.server'

export type AuthQueryDb = Pick<NodePgDatabase<typeof authSchema>, 'select' | 'insert' | 'update' | 'delete'>
export type WorkspaceQueryDb = Pick<NodePgDatabase<typeof workspaceSchema>, 'select' | 'insert' | 'update'>
export type PersonalWorkspaceLease = Readonly<{ db: WorkspaceQueryDb; workspaceId: string }>
export type AuthPgLeaseOptions = Readonly<{ statementTimeoutMs: number; cleanupTimeoutMs: number; correlationId: string }>
export type TransactionOutcome = 'not-started' | 'rolled-back' | 'committed' | 'unknown'
export type TransactionPhase = 'initialize' | 'query' | 'finalize'
export class PgTransactionError extends Error {
  constructor(readonly phase: TransactionPhase, readonly outcome: TransactionOutcome, readonly correlationId: string) {
    super('PostgreSQL transaction failed')
    this.name = 'PgTransactionError'
  }
}
export interface AuthPgLease {
  readonly db: AuthQueryDb
  resolveAdditionalPasskeyWorkspace(principal: AdmittedPrincipal): Promise<string | null>
  selectPersonalWorkspace(principal: AdmittedPrincipal, createIfMissing: boolean): Promise<PersonalWorkspaceLease | null>
  finalize(decision: 'commit' | 'rollback'): Promise<'committed' | 'rolled-back'>
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0

export async function openAuthPgLease(client: PoolClient, options: AuthPgLeaseOptions): Promise<AuthPgLease> {
  const correlationId = uuid.test(options.correlationId) ? options.correlationId : randomUUID()
  const raw = client.query.bind(client)
  const release = client.release.bind(client)
  const connection = client.connection
  const stream = connection.stream
  let phase: TransactionPhase = 'initialize'
  let outcome: TransactionOutcome = 'not-started'
  let accepting = false
  let failed = false
  let disposed = false
  let epoch = 0
  let wireStatus: TransactionStatus = null
  let wakeWire: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let revoke = () => {}
  let tail: Promise<void> = Promise.resolve()
  let finalization: Promise<'committed' | 'rolled-back'> | undefined
  let decisionRecorded: 'commit' | 'rollback' | undefined
  let wakeDisposed: () => void = () => {}
  const disposedSignal = new Promise<void>(resolve => { wakeDisposed = resolve })
  const error = () => new PgTransactionError(phase, outcome, correlationId)
  const queryError = () => new PgTransactionError('query', outcome, correlationId)

  function dispose(destroy: boolean) {
    if (disposed) return
    disposed = true
    accepting = false
    revoke()
    if (timer) clearTimeout(timer)
    timer = undefined
    connection.removeListener('readyForQuery', onReady)
    client.removeListener('error', onTransportFailure)
    client.removeListener('end', onTransportFailure)
    stream.removeListener('close', onTransportFailure)
    // Pool removal alone is insufficient to bound a query whose wire cycle is
    // stuck. Destroy the actual transport before releasing the checkout.
    if (destroy) stream.destroy()
    release(destroy ? true : undefined)
    wakeWire?.()
    wakeWire = undefined
    wakeDisposed()
  }
  function onTransportFailure() { dispose(true) }
  function onReady(message: unknown) {
    if (!wakeWire) { dispose(true); return }
    epoch++
    wireStatus = typeof message === 'object' && message !== null && 'status' in message
      && (message.status === 'I' || message.status === 'T' || message.status === 'E') ? message.status : null
    if (wireStatus === null) dispose(true)
    wakeWire?.()
    wakeWire = undefined
  }
  function startBudget() {
    // Chunk very large valid budgets because Node timers clamp above 2^31-1.
    const deadline = performance.now() + options.cleanupTimeoutMs
    const arm = () => {
      const remaining = deadline - performance.now()
      if (remaining <= 0) dispose(true)
      else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647))
    }
    arm()
  }
  function stopBudget() {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  async function cycle(run: () => Promise<QueryResult<QueryResultRow>>) {
    if (disposed) throw error()
    const before = epoch
    const wire = new Promise<void>(resolve => { wakeWire = resolve })
    // Convert the rejection immediately, but keep ownership until a new
    // ReadyForQuery. ErrorResponse rejects pg before its wire cycle finishes.
    const result = (async () => {
      try { return { ok: true as const, value: await run() } }
      catch { return { ok: false as const } }
    })()
    const completed = await Promise.race([
      Promise.all([result, wire]),
      disposedSignal.then((): never => { throw error() }),
    ])
    if (disposed || epoch !== before + 1 || wireStatus === null || client.getTransactionStatus() !== wireStatus) {
      dispose(true)
      throw error()
    }
    return { result: completed[0], status: wireStatus }
  }
  async function control(text: string, values?: unknown[]) {
    const completion = await cycle(() => raw(text, values))
    if (!completion.result.ok) { dispose(true); throw error() }
    return { result: completion.result.value, status: completion.status }
  }
  function admit(run: () => Promise<QueryResult<QueryResultRow>>) {
    if (!accepting || failed || disposed) throw queryError()
    const admitted = tail.then(async () => {
      if (failed || disposed) throw queryError()
      const completion = await cycle(run)
      if (!completion.result.ok || completion.status !== 'T') {
        failed = true
        accepting = false
        if (completion.status !== 'T' && completion.status !== 'E') dispose(true)
        throw queryError()
      }
      return completion.result.value
    }).catch(() => { throw queryError() })
    tail = admitted.then(() => {}, () => {})
    return admitted
  }

  connection.on('readyForQuery', onReady)
  client.on('error', onTransportFailure)
  client.on('end', onTransportFailure)
  stream.on('close', onTransportFailure)
  try {
    if (!positiveInteger(options.statementTimeoutMs) || !positiveInteger(options.cleanupTimeoutMs)
      || !uuid.test(options.correlationId) || client.getTransactionStatus() !== 'I' || stream.destroyed) throw error()
    startBudget()
    outcome = 'unknown'
    const begin = await control('BEGIN ISOLATION LEVEL READ COMMITTED')
    if (begin.result.command !== 'BEGIN' || begin.status !== 'T') throw error()
    const sentinel = await control("SELECT set_config('app.tenant_id', $1, true)", ['00000000-0000-0000-0000-000000000000'])
    if (sentinel.status !== 'T') throw error()
    const isolation = await control("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.status !== 'T' || isolation.result.rows.length !== 1 || isolation.result.rows[0].isolation !== 'read committed') throw error()
    const timeout = await control("SELECT set_config('statement_timeout', $1, true)", [`${options.statementTimeoutMs}ms`])
    if (timeout.status !== 'T') throw error()
    stopBudget()
    phase = 'query'
    accepting = true
    const query = guardedPgQuery(raw, admit, queryError)
    const guarded = Proxy.revocable<PoolClient>(client, {
      get(_target, key): unknown { if (key === 'query') return query; throw error() },
      getOwnPropertyDescriptor() { throw error() },
      ownKeys() { throw error() },
      getPrototypeOf() { throw error() },
      set() { throw error() },
      defineProperty() { throw error() },
      deleteProperty() { throw error() },
      setPrototypeOf() { throw error() },
      preventExtensions() { throw error() },
      has(_target, key) { return key === 'query' },
    })
    revoke = guarded.revoke
    const database = drizzle({ client: guarded.proxy, schema: authSchema })
    const db: AuthQueryDb = Object.freeze({
      select: database.select.bind(database), insert: database.insert.bind(database),
      update: database.update.bind(database), delete: database.delete.bind(database),
    })
    let exposed: 'none' | 'auth' | 'personal' = 'none'
    async function resolvePersonalWorkspaceAuthority(principal: AdmittedPrincipal, createIfMissing: boolean): Promise<string | null> {
      await admit(() => raw("SELECT set_config('app.correlation_id', $1, true)", [options.correlationId]))
      const result = await admit(() => raw('SELECT app_private.resolve_personal_workspace($1, $2, $3) AS workspace_id', [principal.userId, principal.sessionId, createIfMissing]))
      if (result.rows.length !== 1) throw queryError()
      const selected: unknown = result.rows[0].workspace_id
      if (selected === null) return null
      if (typeof selected !== 'string' || !uuid.test(selected) || selected === '00000000-0000-0000-0000-000000000000') throw queryError()
      return selected
    }
    return {
      get db() { if (exposed === 'personal') throw queryError(); exposed = 'auth'; return db },
      async resolveAdditionalPasskeyWorkspace(principal) {
        if (exposed === 'personal') throw queryError()
        exposed = 'auth'
        return resolvePersonalWorkspaceAuthority(principal, false)
      },
      async selectPersonalWorkspace(principal, createIfMissing) {
        if (exposed !== 'none') throw queryError()
        exposed = 'personal'
        const workspaceId = await resolvePersonalWorkspaceAuthority(principal, createIfMissing)
        if (!workspaceId) return null
        const selected = await admit(() => raw("SELECT set_config('app.tenant_id', $1, true) AS tenant_id", [workspaceId]))
        const verified = await admit(() => raw("SELECT current_setting('app.tenant_id', true) AS tenant_id"))
        if (selected.rows.length !== 1 || selected.rows[0].tenant_id !== workspaceId || verified.rows.length !== 1 || verified.rows[0].tenant_id !== workspaceId) throw queryError()
        const tenant = drizzle({ client: guarded.proxy, schema: workspaceSchema })
        const [locked] = await tenant.select({ id: workspace.id, ownerUserId: workspace.ownerUserId, kind: workspace.kind, lifecycle: workspace.lifecycle, organization: workspace.authOrganizationId }).from(workspace).where(eq(workspace.id, workspaceId)).for('update')
        if (!locked || locked.ownerUserId !== principal.userId || locked.kind !== 'personal' || locked.lifecycle !== 'active' || locked.organization !== null) throw queryError()
        return Object.freeze({ workspaceId, db: Object.freeze({ select: tenant.select.bind(tenant), insert: tenant.insert.bind(tenant), update: tenant.update.bind(tenant) }) })
      },
      finalize(decision) {
        if (finalization) return decision === decisionRecorded ? finalization : Promise.reject(error())
        accepting = false
        decisionRecorded = decision
        phase = 'finalize'
        finalization = (async () => {
          try {
            if (disposed) throw error()
            startBudget()
            await tail
            revoke()
            if (disposed) throw error()
            const terminal = await control(decision === 'rollback' || failed ? 'ROLLBACK' : 'COMMIT')
            if (terminal.status !== 'I' || terminal.result.command !== 'COMMIT' && terminal.result.command !== 'ROLLBACK'
              || (decision === 'rollback' || failed) && terminal.result.command !== 'ROLLBACK') throw error()
            outcome = terminal.result.command === 'COMMIT' ? 'committed' : 'rolled-back'
            dispose(false)
            return outcome
          } catch {
            dispose(true)
            throw error()
          }
        })()
        return finalization
      },
    }
  } catch {
    dispose(true)
    throw error()
  }
}
