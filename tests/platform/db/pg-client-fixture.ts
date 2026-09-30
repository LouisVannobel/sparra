import { Client, type PoolClient, type QueryArrayConfig, type QueryArrayResult, type QueryConfig, type QueryConfigValues, type QueryResult, type QueryResultRow, type Submittable, type TransactionStatus } from 'pg'

export type Step = {
  text: string
  values?: unknown[]
  command?: string
  rows?: QueryResultRow[]
  status?: TransactionStatus
  hold?: boolean
  reject?: boolean
  noReady?: boolean
  nativePreparedConflict?: { name: string; previousSql: string }
}

export function fixture(steps: Step[], initial: TransactionStatus = 'I') {
  let status = initial
  const events: string[] = []
  const dispatched: { text: string; values: unknown; rowMode: unknown }[] = []
  const releases: (Error | boolean | undefined)[] = []
  const nativeRejections: string[] = []
  let pending: { step: Step; resolve: (result: QueryResult<QueryResultRow>) => void; reject: (error: Error) => void } | undefined
  const raw = new Client({ host: 'unused.invalid', user: 'fixture', database: 'fixture', password: 'fixture' })
  const nativeQuery = raw.query.bind(raw)
  function ready(next: TransactionStatus) {
    status = next
    events.push(`ready:${next}`)
    raw.connection.emit('readyForQuery', { status: next })
  }
  function complete() {
    if (!pending) throw new Error('No scripted pending query')
    const { step, resolve, reject } = pending
    pending = undefined
    raw.connection.stream.removeListener('close', stopPending)
    if (!step.noReady) ready(step.status === undefined ? 'T' : step.status)
    if (step.reject) reject(new Error('private driver value'))
    else resolve({ command: step.command ?? 'SELECT', rows: step.rows ?? [], rowCount: step.rows?.length ?? 0, oid: 0, fields: [] })
  }
  function stopPending() {
    pending?.reject(new Error('Scripted transport ended'))
    pending = undefined
  }
  function query<T extends Submittable>(stream: T): T
  function query<R extends unknown[] = unknown[], I = unknown[]>(config: QueryArrayConfig<I>, values?: QueryConfigValues<I>): Promise<QueryArrayResult<R>>
  function query<R extends QueryResultRow = QueryResultRow, I = unknown[]>(config: string | QueryConfig<I>, values?: QueryConfigValues<I>): Promise<QueryResult<R>>
  function query<R extends unknown[] = unknown[], I = unknown[]>(config: QueryArrayConfig<I>, callback: (err: Error, result: QueryArrayResult<R>) => void): void
  function query<R extends QueryResultRow = QueryResultRow, I = unknown[]>(config: string | QueryConfig<I>, callback: (err: Error, result: QueryResult<R>) => void): void
  function query<R extends QueryResultRow = QueryResultRow, I = unknown[]>(text: string, values: QueryConfigValues<I>, callback: (err: Error, result: QueryResult<R>) => void): void
  function query(config: string | QueryConfig<unknown[]> | Submittable, values?: unknown, callback?: unknown): unknown {
    if (typeof values === 'function' || callback !== undefined || typeof config !== 'string' && 'submit' in config) throw new Error('Unsupported fixture query')
    const text = typeof config === 'string' ? config : config.text
    const supplied = values ?? (typeof config === 'string' ? undefined : config.values)
    const step = steps.shift()
    if (!step || step.text !== text || JSON.stringify(step.values) !== JSON.stringify(supplied)) throw new Error(`Unexpected scripted SQL: ${text}`)
    if (pending) throw new Error('Concurrent raw dispatch')
    events.push(`query:${text}`)
    dispatched.push({ text, values: supplied, rowMode: typeof config === 'object' && 'rowMode' in config ? config.rowMode : undefined })
    if (step.nativePreparedConflict) {
      if (typeof config === 'string' || config.name !== step.nativePreparedConflict.name) throw new Error('Expected native named query')
      Object.assign(raw, { readyForQuery: true })
      Object.assign(raw.connection, { parsedStatements: { [step.nativePreparedConflict.name]: step.nativePreparedConflict.previousSql } })
      return nativeQuery(config, Array.isArray(supplied) ? supplied : undefined).catch((error: unknown) => {
        if (error instanceof Error) nativeRejections.push(error.message)
        throw error
      })
    }
    return new Promise<QueryResult<QueryResultRow>>((resolve, reject) => {
      pending = { step, resolve, reject }
      raw.connection.stream.once('close', stopPending)
      if (!step.hold) queueMicrotask(complete)
    })
  }
  const checkedQuery: PoolClient['query'] = query
  const client: PoolClient = Object.assign(raw, {
    query: checkedQuery,
    getTransactionStatus: () => status,
    release(error?: Error | boolean) { releases.push(error); events.push(`release:${error === true ? 'destroy' : 'clean'}`) },
  })
  return {
    client, events, dispatched, releases, nativeRejections, complete, ready,
    rejectBeforeReady() {
      if (!pending) throw new Error('No pending query')
      pending.reject(new Error('private driver value'))
      events.push('error-response')
    },
    remaining: () => steps.length,
    pendingCount: () => pending ? 1 : 0,
    listeners: () => client.listenerCount('error') + client.listenerCount('end') + client.connection.listenerCount('readyForQuery') + client.connection.stream.listenerCount('close'),
  }
}

export function initialization(): Step[] {
  return [
    { text: 'BEGIN ISOLATION LEVEL READ COMMITTED', command: 'BEGIN' },
    { text: "SELECT set_config('app.tenant_id', $1, true)", values: ['00000000-0000-0000-0000-000000000000'] },
    { text: "SELECT current_setting('transaction_isolation') AS isolation", rows: [{ isolation: 'read committed' }] },
    { text: "SELECT set_config('statement_timeout', $1, true)", values: ['500ms'] },
  ]
}
