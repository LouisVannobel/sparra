import type { PoolClient, QueryArrayConfig, QueryArrayResult, QueryConfig, QueryConfigValues, QueryResult, QueryResultRow, Submittable } from 'pg'

// The immediate consumer is the auth lease. Only the Promise overloads used by
// pinned node-postgres Drizzle can enter its owned FIFO.
export function guardedPgQuery(
  raw: PoolClient['query'],
  admit: (run: () => Promise<QueryResult<QueryResultRow>>) => Promise<QueryResult<QueryResultRow>>,
  denied: () => Error,
): PoolClient['query'] {
  function query<T extends Submittable>(stream: T): T
  function query<R extends unknown[] = unknown[], I = unknown[]>(config: QueryArrayConfig<I>, values?: QueryConfigValues<I>): Promise<QueryArrayResult<R>>
  function query<R extends QueryResultRow = QueryResultRow, I = unknown[]>(config: string | QueryConfig<I>, values?: QueryConfigValues<I>): Promise<QueryResult<R>>
  function query<R extends unknown[] = unknown[], I = unknown[]>(config: QueryArrayConfig<I>, callback: (err: Error, result: QueryArrayResult<R>) => void): void
  function query<R extends QueryResultRow = QueryResultRow, I = unknown[]>(config: string | QueryConfig<I>, callback: (err: Error, result: QueryResult<R>) => void): void
  function query<R extends QueryResultRow = QueryResultRow, I = unknown[]>(text: string, values: QueryConfigValues<I>, callback: (err: Error, result: QueryResult<R>) => void): void
  function query(config: string | QueryConfig<unknown[]> | Submittable, values?: unknown, callback?: unknown): unknown {
    if (callback !== undefined || typeof values === 'function'
      || typeof config !== 'string' && ('submit' in config || 'callback' in config || !('text' in config))
      || values !== undefined && !Array.isArray(values)) throw denied()
    const parameters: unknown[] | undefined = values
    return admit(() => raw(config, parameters))
  }
  return query
}
