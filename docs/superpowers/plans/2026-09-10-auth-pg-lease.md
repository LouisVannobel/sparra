# Authentication PostgreSQL Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. The application root/schedule is adopted. Execute only this bounded source task after storage review closure.

**Goal:** Implement the real guarded PostgreSQL transaction lease consumed by the next Better Auth coordinator, preserving Drizzle builders and explicit physical ownership.

**Architecture:** One private checked-out PoolClient, one FIFO and one lifecycle state machine. A distinct permanently invalidatable client proxy binds real Drizzle queries to each lease; initialization precedes handle exposure and finalization closes admission before draining/revoking/releasing. Drizzle is configured with the existing four auth tables and confined to the next auth coordinator; higher-level Effect/Promise participation and actual auth issuance follow as separate consumers.

**Tech Stack:** Existing exact pg8.23.0/@types/pg8.23.1, Drizzle0.45.2, Effect4.0.0-rc.111, TypeScript7.0.2 and Vitest4.1.11; no additional dependencies or runtime servers.

**Spec:** docs/design/BOILERPLATE_DESIGN.md §8.5, limited here to the physical auth-global lease; .superpowers/sdd/auth-workspace/pg-boundary-contract.md supplies pinned-source entry evidence, not prior implementation.

## Global Constraints

- No Docker/WSL/service start, database connection, migration application, existing DB/credential use, provider call, .env read/write, remote/push/deployment/infra/CI change. Docker operator permission is pending.
- One code writer, TDD and independent spec/quality review. No broad casts, any, new package, generic repository, fake runtime database, imported PREP machinery or second physical ownership implementation.
- The real checked-out PoolClient stays closure-private. No raw client/connection/release/end/native Drizzle transaction escapes to the consumer, and no temporary replacement of client.query on the pool's original object.
- PostgreSQL READ COMMITTED is the sole baseline isolation. The first SQL after BEGIN sets the zero UUID tenant sentinel transaction-locally. No auth handle exists before initialization succeeds; auth-global has no tenant store or authority-selection API.
- Finalization closes admission synchronously, settles previously admitted operations in FIFO order, permanently invalidates their handles, then performs COMMIT/ROLLBACK. A rejected query Promise alone does not prove the pg wire cycle ended.
- Successful release requires fresh idle evidence and no ambiguous/in-flight work. Ambiguous BEGIN/COMMIT/ROLLBACK, unknown/non-idle status, transport failure or exhausted cleanup budget destroys the PoolClient using its real release(true) operation exactly once.
- No real database enforcement/transaction/PgBouncer/session/provider acceptance is claimed by scripted unit tests. Full-template gates and tenant/Effect/Promise/runtime consumers remain required but are not fabricated in this source unit.

## Task 1: Auth-global physical lease with real Drizzle query builders

**Files:**

- Add src/platform/db/auth-pg-lease.server.ts: lease initialization, query admission/draining and physical finalization.
- Add src/platform/db/guarded-pg-query.server.ts only if needed to keep overload/protocol adaptation separate from lifecycle; it must have the lease as its immediate consumer and must not become a general database framework.
- Add tests/platform/db/auth-pg-lease.test.ts and tests/platform/db/pg-client-fixture.ts (test-only scripted pg client fixture).
- Modify README.md to state the exact source capability and live-proof limits.
- Do not change package/lock, auth schema/migration, web lifecycle/config or public routes.

**Interfaces:** Consume the real PoolClient and authSchema from src/modules/auth/schema.server.ts. Produce this confined source API for the next coordinator; do not export raw SQL/query or a native transaction method:

```ts
import type { PoolClient } from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { authSchema } from '../../modules/auth/schema.server'

export type AuthQueryDb = Pick<
  NodePgDatabase<typeof authSchema>,
  'select' | 'insert' | 'update' | 'delete'
>
export type AuthPgLeaseOptions = Readonly<{
  statementTimeoutMs: number
  cleanupTimeoutMs: number
  correlationId: string
}>
export type TransactionOutcome = 'not-started' | 'rolled-back' | 'committed' | 'unknown'
export type TransactionPhase = 'initialize' | 'query' | 'finalize'
export class PgTransactionError extends Error {
  readonly phase: TransactionPhase
  readonly outcome: TransactionOutcome
  readonly correlationId: string
  constructor(phase: TransactionPhase, outcome: TransactionOutcome, correlationId: string)
}
export interface AuthPgLease {
  readonly db: AuthQueryDb
  finalize(decision: 'commit' | 'rollback'): Promise<'committed' | 'rolled-back'>
}
export function openAuthPgLease(
  client: PoolClient,
  options: AuthPgLeaseOptions,
): Promise<AuthPgLease>
```

Ownership transfers to openAuthPgLease at invocation, including initialization failure. It never releases twice and never lets its caller release the client. It does not acquire a pool or start a process. The next higher-level coordinator will validate configuration before checkout, acquire under interruption masking and call this API; it will not duplicate this physical state machine. No nested-transaction API exists on this lease.

- [ ] **Step 1: Write behavior tests against a typed, explicitly scripted pg test fixture.** The fixture belongs under tests, not runtime. Prefer augmenting a real unconnected pg.Client with a typed release spy and controlled query/protocol behavior; it may not connect, listen on a socket or assert an object as PoolClient. Type-check any overload implementation against PoolClient['query']. Record actual chronological events and independently asserted literal SQL/result expectations, not a mirror of production descriptors.

The concrete cases are:

1. BEGIN READ COMMITTED, then sentinel, isolation assertion and positive statement timeout; only then a real Drizzle select builder can execute. Wrong isolation or missing/null initial/completion status fails before consumer SQL and destroys as required.
2. Two real Drizzle queries started concurrently dispatch one at a time in admitted order. Hold the first behind a test-owned deferred completion; the second is not sent early.
3. A pg query rejection before ReadyForQuery does not advance the next SQL/cleanup. Deliver the fresh wire completion explicitly; aborted status makes the lease terminal and later admitted business work fails without dispatch.
4. finalize closes admission immediately, waits for already-admitted work, invalidates before the control statement, and rejects a previously constructed/extracted builder after finalization and after the physical fixture is reused for a new lease.
5. The consumer cannot access connection/release/end/$client/native transaction; callback/Submittable/stream forms are denied synchronously rather than enqueued. Real Drizzle object and array row modes still work.
6. COMMIT command plus fresh I and no ambiguity resolves committed; CommandComplete ROLLBACK with I resolves rolled-back. Missing fresh ReadyForQuery, ambiguous/failed BEGIN/COMMIT/ROLLBACK, error/end/stream close or cleanup deadline destroys exactly once and never reports committed from idle alone.
7. A caller catching a business query failure cannot subsequently commit a PostgreSQL-aborted transaction. Concurrent/repeated finalize calls must not send multiple terminal commands or release more than once; the same decision joins its existing completion, a conflicting decision rejects.
8. Cleanup has its own positive finite budget. On expiration it destroys the underlying client/wait, clears timers/listeners and settles; it must not merely return from Promise.race while the connection remains reusable.
9. Options are finite positive safe integers; correlationId is a UUID-shaped local correlation value, never SQL/DSN/error text. Invalid options cause no SQL and cannot leak an owned checkout. If the supplied correlationId is invalid, generate a fresh node:crypto randomUUID for the error instead of retaining the invalid value. Lease-created guard/initialization/finalization errors expose only fixed text, phase, outcome and correlationId; no raw SQL/value/driver message/cause retained by those errors. Real Drizzle builders subsequently wrap business-query failures in native DrizzleQueryError containing query/params: keep that wrapper internal and unlogged, document the exact limitation, and require sanitization at the next owner boundary rather than replacing/patching real builders.

Representative real-builder test shape (fixture methods are test-owned controls, not production API):

```ts
const lease = await openAuthPgLease(fixture.client, {
  statementTimeoutMs: 500, cleanupTimeoutMs: 100,
  correlationId: '3efaf2ac-d41e-43e9-aebe-f446bc233bb0',
})
const first = lease.db.select({ id: user.id }).from(user).execute()
const second = lease.db.select({ id: user.id }).from(user).execute()
await fixture.firstBusinessDispatch
expect(fixture.businessDispatchCount()).toBe(1)
fixture.completeFirstBusinessQuery()
await Promise.all([first, second])
expect(fixture.businessDispatchCount()).toBe(2)
expect(await lease.finalize('commit')).toBe('committed')
```

- [ ] **Step 2: Observe missing-feature RED.** Run pnpm exec vitest run tests/platform/db/auth-pg-lease.test.ts --maxWorkers=1; record the genuine missing-module or missing-behavior failure before production code. Compile the exact query overloads without weakening source types; report an incompatible pinned API with a minimal failing typecheck rather than asserting through it.

- [ ] **Step 3: Implement initialization and the private typed query boundary.** Use the existing public pg getTransactionStatus method and query result command; keep one small pinned internal ReadyForQuery observer with unknown + structural narrowing, attached before dispatch. A monotonically increasing completion epoch identifies fresh wire completion, especially after ErrorResponse. Observe raw error/end/stream closure with no credential/log output; any uncertainty is terminal. Do not use private _activeQuery/_queryable as asserted truth.

The exact control SQL sequence is:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED
SELECT set_config('app.tenant_id', $1, true)
SELECT current_setting('transaction_isolation') AS isolation
SELECT set_config('statement_timeout', $1, true)
```

Sentinel parameter is the literal 00000000-0000-0000-0000-000000000000; assert the returned isolation is exactly read committed. Timeout parameter is the validated millisecond count with ms suffix. Initialization itself has the independent cleanup budget so an unconfigured statement_timeout cannot hang forever. No handle exists before all initialization statements complete with fresh T. No helper for prepared statement names, consumer control SQL or session-level app.* changes is added. Drizzle still accepts SQL fragments: its schema generic is not a table allowlist or SQL security sandbox. This confined internal lease must not be exported as an arbitrary application database service; the next real auth adapter uses the inspected four-table query paths, and tenant stores/static SQL policy arrive with their actual consumers.

Bind a distinct Proxy.revocable<PoolClient> to the checked-out client and use drizzle({ client: guardedClient, schema: authSchema }). The proxy get trap returns unknown and only exposes the checked query path needed by pinned Drizzle; deny raw escape members and reflective descriptors/mutations that would expose or change the private connection/release/query state. Retain permanent lease-state checks in extracted functions, and do not spread a Drizzle instance. This prevents stale-handle/raw-client mistakes, not arbitrary malicious JavaScript running in the same process. Expose exact bound select/insert/update/delete methods while keeping the complete Drizzle object private. No as PoolClient, any, broad function assertion or Parameters<PoolClient['query']> shortcut.

Implement pg's Promise object/array row-mode overloads with generic QueryResultRow/unknown[]/QueryConfig/QueryArrayConfig/QueryConfigValues. Preserve config and values. The unused callback and Submittable overloads are declared only to satisfy the real type boundary and throw synchronously; no opaque execution is admitted. FIFO admission is synchronous, owned by this module, never delegated to pg's internal queue.

- [ ] **Step 4: Implement finalization and bounded disposal.** Close admission before the first await; drain in admitted order, mark aborted/failed business work terminal, invalidate stores/proxy, then dispatch only the private control SQL. Use one recorded finalization Promise and exact-once release guard. Result classification follows command + fresh status + zero outstanding work, not error absence or I alone. Normal committed/rolled-back completion releases only after clean I; every ambiguous path destroys using release(true), removes observers/timers and rejects a small PgTransactionError with no raw cause. No retry is provided. The next coordinator must preserve committed/unknown no-replay semantics.

Run each focused case as implemented, including rejection-before-ReadyForQuery and repeated/conflicting-finalization cases. Where a fixture cannot reproduce pg behavior, label it scripted and leave the concrete live gate open; do not add a fake proof claim or a large TCP simulation platform.

- [ ] **Step 5: Verify, document and commit.** Run focused tests, normative pnpm typecheck, production pnpm build then the full pnpm test suite, git diff --check, and inspect allowed paths. Verify no runtime client/server or env operation occurred and no handles/listeners/timers remain after the test fixture's completion. README records real Drizzle-on-guarded-client source behavior while explicitly retaining live PostgreSQL/PgBouncer/wire/Effect-interruption/BetterAuth/session/RLS gates. Commit only durable allowed files, write the exact RED/GREEN/commands/results/commit/limits to the ignored report, then stop for an independent task review. No subagents or Oracle from the implementer.

## Coverage boundary

This task implements §8.5's physical auth-global ownership/initialization/query/finalization subset. It intentionally does not claim pool checkout/lifecycle integration, Effect current-fiber interruption, Promise async-local nested participation, BetterAuth CRUD delegation, tenant authority/RLS, runtime durability attestation, or disposable live database/wire acceptance. Those are concrete next consumers/gates, not placeholders supplied by this module. No new acceptance document/framework is needed.
