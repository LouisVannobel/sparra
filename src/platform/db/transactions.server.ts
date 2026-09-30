import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Cause, Context, Effect, Exit } from 'effect'
import { DrizzleError, DrizzleQueryError } from 'drizzle-orm'
import { DatabaseError } from 'pg'
import type { PoolClient } from 'pg'
import { openAuthPgLease, PgTransactionError, type AuthPgLease, type AuthQueryDb, type PersonalWorkspaceLease } from './auth-pg-lease.server'
import type { AdmittedPrincipal } from '../../modules/auth/session.server'

export type AuthTxOptions = Readonly<{
  deadlineAtMs: number
  statementTimeoutMs: number
  cleanupTimeoutMs: number
  correlationId: string
  signal?: AbortSignal
}>
export type AuthTxLimits = Readonly<{ maxStatementTimeoutMs: number; maxCleanupTimeoutMs: number }>
type OwnedScope = {
  readonly owner: object
  readonly options: AuthTxOptions
  readonly lease: AuthPgLease
  readonly mode: Mode
  personal?: PersonalWorkspaceLease | null
  readonly signal: AbortSignal
  readonly stopped: Promise<void>
  readonly isClosed: () => boolean
  readonly finish: (decision: 'commit' | 'rollback') => Promise<'committed' | 'rolled-back'>
  readonly cancel: () => void
}
type Mode = { readonly kind: 'auth' } | { readonly kind: 'personal'; readonly principal: AdmittedPrincipal; readonly createIfMissing: boolean }
const authMode: Mode = { kind: 'auth' }
type Invocation = { readonly owner: object; readonly options: AuthTxOptions; readonly scope?: OwnedScope; readonly mode: Mode }
const CurrentScope = Context.Reference<OwnedScope | undefined>('app/pg/currentAuthScope', { defaultValue: () => undefined })
const promiseInvocation = new AsyncLocalStorage<Invocation>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const positive = (value: number) => Number.isSafeInteger(value) && value > 0

function failure(options?: AuthTxOptions) {
  return new PgTransactionError('query', 'unknown', options && uuid.test(options.correlationId) ? options.correlationId : randomUUID())
}
function sanitize<E>(error: E, options: AuthTxOptions): E | PgTransactionError {
  const databaseError = Cause.isUnknownError(error) ? error.cause : error
  if (databaseError instanceof DrizzleQueryError) {
    return databaseError.cause instanceof PgTransactionError
      ? new PgTransactionError(databaseError.cause.phase, databaseError.cause.outcome, options.correlationId)
      : failure(options)
  }
  if (databaseError instanceof DrizzleError || databaseError instanceof DatabaseError) return failure(options)
  return error
}
function sanitizeCause<E>(cause: Cause.Cause<E>, options: AuthTxOptions): Cause.Cause<E | PgTransactionError> {
  return Cause.fromReasons(cause.reasons.map(reason => {
    if (Cause.isFailReason(reason)) return Cause.makeFailReason(sanitize(reason.error, options))
    if (Cause.isDieReason(reason)) return Cause.makeDieReason(sanitize(reason.defect, options))
    return reason
  }))
}
function same(a: AuthTxOptions, b: AuthTxOptions) {
  return a.deadlineAtMs === b.deadlineAtMs && a.statementTimeoutMs === b.statementTimeoutMs
    && a.cleanupTimeoutMs === b.cleanupTimeoutMs && a.correlationId === b.correlationId && a.signal === b.signal
}
function sameMode(a: Mode, b: Mode) {
  return a.kind === 'auth' ? b.kind === 'auth' : b.kind === 'personal'
    && a.principal.userId === b.principal.userId && a.principal.sessionId === b.principal.sessionId && a.createIfMissing === b.createIfMissing
}

export function createTransactions(pool: { connect(): Promise<PoolClient> }, limits: AuthTxLimits) {
  const owner = {}
  if (!positive(limits.maxStatementTimeoutMs) || !positive(limits.maxCleanupTimeoutMs)) throw failure()
  const ceilings = { ...limits }

  function validate(options: AuthTxOptions, inherited?: Invocation, mode: Mode = authMode) {
    if (!positive(options.deadlineAtMs) || !positive(options.statementTimeoutMs) || !positive(options.cleanupTimeoutMs)
      || !uuid.test(options.correlationId) || options.deadlineAtMs <= Date.now() || options.signal?.aborted
      || mode.kind === 'personal' && (!mode.principal?.userId || !mode.principal.sessionId || typeof mode.createIfMissing !== 'boolean')
      || inherited && (inherited.owner !== owner || !same(inherited.options, options) || !sameMode(inherited.mode, mode) || inherited.scope?.isClosed())) throw failure(options)
  }
  function context(scope: OwnedScope): Invocation { return { owner: scope.owner, options: scope.options, scope, mode: scope.mode } }

  async function acquire(options: AuthTxOptions, mode: Mode): Promise<OwnedScope> {
    validate(options, undefined, mode)
    options = Object.freeze({ ...options })
    const controller = new AbortController()
    let wakeStopped = () => {}
    const stopped = new Promise<void>(resolve => { wakeStopped = resolve })
    let timer: ReturnType<typeof setTimeout> | undefined
    let lease: AuthPgLease | undefined
    let finalization: Promise<'committed' | 'rolled-back'> | undefined
    let closed = false
    function disarm() {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
    function finish(decision: 'commit' | 'rollback') {
      if (finalization) return finalization
      if (decision === 'commit' && (options.deadlineAtMs <= Date.now() || options.signal?.aborted)) {
        cancel()
        return finish('rollback')
      }
      closed = true
      if (!lease) return Promise.reject(failure(options))
      // Keep the actual recorded decision's Promise when cancellation races COMMIT.
      finalization = lease.finalize(decision).finally(disarm)
      return finalization
    }
    function cancel() {
      if (controller.signal.aborted) return
      controller.abort()
      wakeStopped()
      if (lease) void finish('rollback').catch(() => {})
    }
    function arm() {
      const remaining = options.deadlineAtMs - Date.now()
      if (remaining <= 0) cancel()
      else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647))
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    arm()
    try {
      const pending = pool.connect().then(client => {
        if (controller.signal.aborted) { client.release(true); throw failure(options) }
        return client
      })
      const client = await Promise.race([pending, stopped.then((): never => { throw failure(options) })])
      const remaining = options.deadlineAtMs - Date.now()
      if (controller.signal.aborted || remaining <= 0) { client.release(true); throw failure(options) }
      lease = await openAuthPgLease(client, {
        statementTimeoutMs: Math.min(options.statementTimeoutMs, ceilings.maxStatementTimeoutMs, remaining),
        cleanupTimeoutMs: Math.min(options.cleanupTimeoutMs, ceilings.maxCleanupTimeoutMs),
        correlationId: options.correlationId,
      })
      if (controller.signal.aborted) { await finish('rollback'); throw failure(options) }
      return { owner, options, lease, mode, signal: controller.signal, stopped, isClosed: () => closed, finish, cancel }
    } catch (error) {
      disarm()
      throw error instanceof PgTransactionError ? error : failure(options)
    }
  }

  async function initialize(scope: OwnedScope) {
    if (scope.mode.kind === 'personal' && scope.personal === undefined) scope.personal = await scope.lease.selectPersonalWorkspace(scope.mode.principal, scope.mode.createIfMissing)
  }
  async function withPromise<A>(options: AuthTxOptions, mode: Mode, call: (scope: OwnedScope) => Promise<A>): Promise<A> {
    const inherited = promiseInvocation.getStore()
    validate(options, inherited, mode)
    const scope = inherited?.scope ?? await acquire(options, mode)
    const root = !inherited?.scope
    try {
      const value = await Promise.race([
        promiseInvocation.run(context(scope), async () => { if (root) await initialize(scope); return call(scope) }),
        scope.stopped.then((): never => { throw failure(scope.options) }),
      ])
      if (root) {
        const outcome = await scope.finish('commit')
        if (outcome !== 'committed' || scope.signal.aborted) throw new PgTransactionError('finalize', outcome, scope.options.correlationId)
      }
      return value
    } catch (error) {
      await scope.finish('rollback')
      throw sanitize(error, scope.options)
    }
  }

  const withTransaction = Effect.fnUntraced(function*<A, E, R>(options: AuthTxOptions, mode: Mode, use: Effect.Effect<A, E, R>): Effect.fn.Return<A, E | PgTransactionError, R> {
    return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      const inherited = (yield* CurrentScope) ?? promiseInvocation.getStore()?.scope
      yield* Effect.try({ try: () => validate(options, inherited ? context(inherited) : promiseInvocation.getStore(), mode), catch: () => failure(options) })
      const scope = inherited ?? (yield* Effect.tryPromise({ try: () => acquire(options, mode), catch: () => failure(options) }))
      const root = inherited === undefined
      return yield* Effect.withFiber(fiber => {
        // A timer/AbortSignal is imperative; interrupt this existing fiber only.
        // Finalization also starts independently if user code masks interruption.
        const interrupt = () => fiber.interruptUnsafe()
        scope.signal.addEventListener('abort', interrupt, { once: true })
        if (scope.signal.aborted) interrupt()
        const initialized = root ? Effect.andThen(Effect.tryPromise({ try: () => initialize(scope), catch: () => failure(options) }), use) : use
        return restore(Effect.provideService(initialized, CurrentScope, scope)).pipe(
          Effect.catchCause(cause => Effect.failCause(sanitizeCause(cause, scope.options))),
          Effect.onExit(exit => Effect.tryPromise({
            try: async () => {
              try {
                if (Exit.isFailure(exit)) {
                  if (Cause.hasInterrupts(exit.cause)) scope.cancel()
                  await scope.finish('rollback')
                }
                else if (root) {
                  const outcome = await scope.finish('commit')
                  if (outcome !== 'committed' || scope.signal.aborted) throw new PgTransactionError('finalize', outcome, scope.options.correlationId)
                }
              } finally { scope.signal.removeEventListener('abort', interrupt) }
            },
            catch: error => error instanceof PgTransactionError ? error : failure(scope.options),
          })),
        )
      })
    }))
  })

  const invokePromise = Effect.fnUntraced(function*<A>(options: AuthTxOptions, kind: Mode['kind'], call: (signal: AbortSignal) => Promise<A>): Effect.fn.Return<A, unknown> {
    const scope = yield* CurrentScope
    if (!scope || scope.mode.kind !== kind) return yield* Effect.fail(failure(options))
    yield* Effect.try({ try: () => validate(options, context(scope), scope.mode), catch: () => failure(options) })
    return yield* Effect.uninterruptibleMask(restore => restore(Effect.tryPromise({
      try: () => promiseInvocation.run(context(scope), () => call(scope.signal)),
      catch: error => sanitize(error, scope.options),
    })).pipe(Effect.onInterrupt(() => Effect.tryPromise({
      try: async () => {
        scope.cancel()
        await scope.finish('rollback')
      },
      catch: error => error instanceof PgTransactionError ? error : failure(scope.options),
    }))))
  })
  function invocationOptions(): AuthTxOptions {
    const invocation = promiseInvocation.getStore()
    if (!invocation || invocation.owner !== owner) throw failure()
    validate(invocation.options, invocation)
    return invocation.options
  }
  function currentDb(): AuthQueryDb {
    const invocation = promiseInvocation.getStore()
    invocationOptions()
    if (!invocation?.scope) throw failure(invocation?.options)
    return invocation.scope.lease.db
  }
  async function runAuthInvocation<A>(options: AuthTxOptions, call: () => Promise<A>): Promise<A> {
    const inherited = promiseInvocation.getStore()
    validate(options, inherited)
    return promiseInvocation.run(inherited ?? { owner, options: Object.freeze({ ...options }), mode: authMode }, call)
  }
  function assertNoActiveAuthTransaction(): void {
    const inherited = promiseInvocation.getStore()
    if (inherited) {
      validate(inherited.options, inherited)
      if (inherited.scope) throw failure(inherited.options)
    }
  }
  function withAuthPromise<A>(options: AuthTxOptions, call: (lease: Pick<AuthPgLease, 'db' | 'resolveAdditionalPasskeyWorkspace'>) => Promise<A>) {
    return withPromise(options, authMode, scope => call({ db: scope.lease.db,
      resolveAdditionalPasskeyWorkspace: scope.lease.resolveAdditionalPasskeyWorkspace.bind(scope.lease) }))
  }
  function withPersonalWorkspacePromise<A>(options: AuthTxOptions, principal: AdmittedPrincipal, createIfMissing: boolean, call: (lease: PersonalWorkspaceLease | null) => Promise<A>) {
    return withPromise(options, { kind: 'personal', principal: Object.freeze({ ...principal }), createIfMissing }, scope => call(scope.personal ?? null))
  }
  const withAuthTransaction = <A, E, R>(options: AuthTxOptions, use: Effect.Effect<A, E, R>) => withTransaction(options, authMode, use)
  const withPersonalWorkspaceTransaction = <A, E, R>(options: AuthTxOptions, principal: AdmittedPrincipal, createIfMissing: boolean, use: Effect.Effect<A, E, R>) => withTransaction(options, { kind: 'personal', principal: Object.freeze({ ...principal }), createIfMissing }, use)
  const invokeAuthPromise = <A>(options: AuthTxOptions, call: (signal: AbortSignal) => Promise<A>) => invokePromise(options, 'auth', call)
  const invokePersonalWorkspacePromise = <A>(options: AuthTxOptions, call: (signal: AbortSignal) => Promise<A>) => invokePromise(options, 'personal', call)
  return { withAuthPromise, withAuthTransaction, invokeAuthPromise, currentDb, invocationOptions, runAuthInvocation, assertNoActiveAuthTransaction,
    withPersonalWorkspacePromise, withPersonalWorkspaceTransaction, invokePersonalWorkspacePromise }
}
export type AuthTransactions = ReturnType<typeof createTransactions>
