import { Effect, Exit, Schema, Scope } from 'effect'
import { fileURLToPath } from 'node:url'
import dns from 'node:dns'
import { HATCHET_VERSION } from '@hatchet-dev/typescript-sdk/version.js'
import { readMailWorkerConfig } from '../../src/platform/mail-runtime.server'
import { acquireDatabase } from '../../src/platform/db/resources.server'
import { createMailStore } from '../../src/modules/auth/mail-store.server'
import { createAuthMailHandler } from '../../src/modules/auth/mail-worker.server'
import { createAuthMailTask, createAuthMailHatchet } from '../../src/modules/auth/mail-hatchet.server'
import { relayAuthMailOnce } from '../../src/modules/auth/mail-relay.server'
import { createPlunkTransport } from '../../src/modules/auth/plunk.server'
import { createRetryBarriers, retryBudget, retryFixtureError, retryLabels, safeRetryOutcome, readRetryHistory, observeRetryHandler, retryChildPhase, retryCommandOperation, type RetryLabel } from './mail-retry-observation'

const uuid = Schema.String.check(Schema.isUUID())
const commandSchema = Schema.Struct({ id: Schema.Int, op: retryCommandOperation,
  label: Schema.optional(Schema.Literals(retryLabels)), outboxId: Schema.optional(uuid), runId: Schema.optional(uuid), hookId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))), deadlineAtMs: Schema.optional(Schema.Number) })
const jobSchema = Schema.Struct({ outboxId: uuid })
type Case = { outboxId: string; runId?: string; observedRunId?: string; taskId?: string }

async function main() {
  if (!process.send) throw retryFixtureError()
  const config = readMailWorkerConfig(process.env)
  const scope = Effect.runSync(Scope.make())
  const cases = new Map<RetryLabel, Case>()
  const barriers = createRetryBarriers()
  const admission = new AbortController()
  const requests = new Set<AbortController>()
  const ownedCommands = new Set<Promise<void>>()
  const originalLookup = dns.lookup
  let holdLookup = false, closing = false, ready = false, cancellationUsed = false
  let releaseLookup = () => {}
  let budget: ReturnType<typeof retryBudget> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let worker: Awaited<ReturnType<ReturnType<typeof createAuthMailHatchet>['worker']>> | undefined
  let nativeStarted: Promise<void> | undefined
  let nativeStartState: 'pending' | 'resolved' | 'rejected' = 'pending'
  let nativeStopState: 'not-started' | 'resolved' | 'rejected' = 'not-started'
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  let startupDone!: () => void
  const startupSettled = new Promise<void>(resolve => { startupDone = resolve })
  let cleanup: Promise<void> | undefined
  function emit(event: object) {
    if (process.connected) process.send?.(event, () => {})
  }
  function findLabel(input: unknown) {
    const { outboxId } = Schema.decodeUnknownSync(jobSchema)(input, { onExcessProperty: 'error' })
    const entry = [...cases.entries()].find(([, value]) => value.outboxId === outboxId)
    if (!entry) throw retryFixtureError()
    return entry
  }
  async function observed<A>(call: (signal: AbortSignal, timeout: number) => Promise<A>) {
    if (closing) throw retryFixtureError()
    const timeout = budget ? budget.remaining(10000) : 10000
    const controller = new AbortController()
    requests.add(controller)
    const timer = setTimeout(() => controller.abort(), timeout)
    try { return await call(controller.signal, timeout) }
    finally { clearTimeout(timer); requests.delete(controller) }
  }
  function shutdown() {
    if (cleanup) return cleanup
    closing = true
    admission.abort()
    void handler?.stop()
    void barriers.close()
    for (const request of requests) request.abort()
    releaseLookup()
    emit({ type: 'closing' })
    cleanup = (async () => {
      await startupSettled
      const handlers = handler?.stop() ?? Promise.resolve()
      const hooks = barriers.close()
      const stop = worker ? worker.stop().then(() => { nativeStopState = 'resolved' }, () => { nativeStopState = 'rejected' }) : Promise.resolve()
      await Promise.all([handlers, hooks, stop, nativeStarted ?? Promise.resolve()])
      await Promise.all([...ownedCommands])
      await transport?.close()
      Object.defineProperty(dns, 'lookup', { value: originalLookup, configurable: true, writable: true })
      await Effect.runPromise(Scope.close(scope, Exit.void))
      emit({ type: 'stopped', nativeStartState, nativeStopState, pendingHooks: barriers.pending(), commandsJoined: true })
      if (nativeStartState === 'rejected' || nativeStopState === 'rejected') process.exitCode = 1
      finish()
    })().catch(() => { emit({ type: 'fatal' }); process.exitCode = 1; finish() })
    return cleanup
  }
  const earlyShutdown = (raw: unknown) => {
    if (typeof raw === 'object' && raw !== null && 'op' in raw && raw.op === 'shutdown') void shutdown()
  }
  process.on('message', earlyShutdown)
  try {
    const relayDb = await Effect.runPromise(Scope.provide(acquireDatabase(config.relay, 'auth_mail_relay'), scope))
    if (closing) throw retryFixtureError()
    const workerDb = await Effect.runPromise(Scope.provide(acquireDatabase(config.worker, 'auth_mail_worker'), scope))
    if (closing) throw retryFixtureError()
    const relayStore = createMailStore(relayDb.transactions)
    transport = createPlunkTransport(config.binding)
    handler = observeRetryHandler(createAuthMailHandler(createMailStore(workerDb.transactions), config.envelope, transport), (input, result) => {
      const [label] = findLabel(input)
      // This receipt follows the real owned handle promise, not cancellable SDK after middleware.
      emit({ type: 'handler-settled', label, state: result.state,
        reason: result.state === 'deferred' ? result.reason : null })
    })
    const client = createAuthMailHatchet(config.hatchet, fileURLToPath(new URL('./hatchet-empty.yaml', import.meta.url))).withMiddleware({
      before: async (input, context) => {
        const [label, value] = findLabel(input)
        const runId = Schema.decodeUnknownSync(uuid)(context.workflowRunId())
        const taskId = Schema.decodeUnknownSync(uuid)(context.taskRunId())
        const retryCount = Schema.decodeUnknownSync(Schema.Int)(context.retryCount())
        if (value.runId && value.runId !== runId || value.observedRunId && value.observedRunId !== runId || value.taskId && value.taskId !== taskId) throw retryFixtureError()
        value.observedRunId = runId; value.taskId = taskId
        const hookId = `${label}:${taskId}:${retryCount}`
        const gated = label === 'D' || label === 'E' || label === 'C' && retryCount === 0 || label === 'B' && retryCount > 0
        const hook = gated ? barriers.enter(hookId, context.abortController) : Promise.resolve()
        emit({ type: 'before', label, outboxId: value.outboxId, runId, taskId, retryCount, hookId, gated })
        await hook
        // undefined leaves the exact job input unchanged. SDK checks abort next.
      },
      after: async (output, context, input) => {
        const [label] = findLabel(input)
        emit({ type: 'outcome', label, runId: context.workflowRunId(), taskId: context.taskRunId(), retryCount: context.retryCount(), outcome: safeRetryOutcome(output) })
      },
    })
    Object.defineProperty(dns, 'lookup', { configurable: true, writable: true, value: (...args: unknown[]) => {
      const callback = args.at(-1)
      if (!holdLookup || args[0] !== new URL(config.binding.apiOrigin).hostname || typeof callback !== 'function') return Reflect.apply(originalLookup, dns, args)
      holdLookup = false
      const wrapped = (...values: unknown[]) => {
        releaseLookup = () => { releaseLookup = () => {}; Reflect.apply(callback, undefined, values); emit({ type: 'lookup-returned', label: 'A' }) }
        if (closing) releaseLookup()
        else emit({ type: 'lookup-held', label: 'A' })
      }
      return Reflect.apply(originalLookup, dns, [...args.slice(0, -1), wrapped])
    } })
    if (HATCHET_VERSION !== '1.28.2') throw retryFixtureError()
    const tenant = await observed((signal, timeout) => client.api.tenantGet(client.tenantId, { signal, timeout }))
    const version = await observed(signal => client.dispatcher.client.getVersion({}, { signal }))
    if (tenant.data.version !== 'V1' || version.version !== 'v0.101.27') throw retryFixtureError()
    const task = createAuthMailTask(client, handler)
    if (closing) throw retryFixtureError()
    worker = await client.worker('auth-email-retry-qualification', { workflows: [task], slots: 1, handleKill: false })
    nativeStarted = worker.start().then(() => { nativeStartState = 'resolved'; if (!closing) emit({ type: 'fatal' }) }, () => { nativeStartState = 'rejected'; if (!closing) emit({ type: 'fatal' }) })
    await worker.waitUntilReady(20000)
    if (closing) throw retryFixtureError()
    ready = true
    startupDone()
    const onMessage = (raw: unknown) => {
      let message: typeof commandSchema.Type
      try { message = Schema.decodeUnknownSync(commandSchema)(raw, { onExcessProperty: 'error' }) }
      catch { emit({ type: 'fatal' }); return }
      if (message.op === 'shutdown') return
      const current = (async () => {
        let phase: typeof retryChildPhase.Type | undefined
        const respond = (ok: boolean, value?: unknown) => emit({ type: 'reply', id: message.id, op: message.op, label: message.label ?? null, ok,
          ...(value !== undefined ? { value } : {}), ...(!ok && phase ? { phase } : {}) })
        try {
          if (closing || !ready) throw retryFixtureError()
          if (message.op === 'begin') {
            if (budget || message.deadlineAtMs === undefined) throw retryFixtureError()
            budget = retryBudget(message.deadlineAtMs)
            respond(true, true); return
          }
          if (!budget) throw retryFixtureError()
          budget.remaining(10000)
          const value = message.label ? cases.get(message.label) : undefined
          let result: unknown = true
          switch (message.op) {
            case 'configure':
              if (!message.label || !message.outboxId || cases.has(message.label) || cases.size >= 5) throw retryFixtureError()
              cases.set(message.label, { outboxId: message.outboxId }); if (message.label === 'A') holdLookup = true
              break
            case 'admit': result = await relayAuthMailOnce(relayStore, task, admission.signal); break
            case 'bind':
              if (!value || !message.runId || value.runId || value.observedRunId && value.observedRunId !== message.runId) throw retryFixtureError()
              value.runId = message.runId; break
            case 'release': if (!message.hookId) throw retryFixtureError(); barriers.release(message.hookId); break
            case 'release-lookup': releaseLookup(); break
            case 'cancel-A':
              if (cancellationUsed || message.label !== 'A' || !value?.runId) throw retryFixtureError()
              cancellationUsed = true
              await observed((signal, timeout) => client.api.v1TaskCancel(client.tenantId, { externalIds: [value.runId!] }, { signal, timeout })); break
            case 'history': {
              result = await readRetryHistory(client, value, observed, current => { phase = current }); break
            }
          }
          respond(true, result)
        } catch { respond(false) }
      })()
      ownedCommands.add(current)
      void current.finally(() => ownedCommands.delete(current))
    }
    process.on('message', onMessage)
    emit({ type: 'ready', sdk: HATCHET_VERSION, engine: version.version, tenantId: client.tenantId,
      policy: { retries: task.taskDef.retries, factor: task.taskDef.backoff?.factor, cap: task.taskDef.backoff?.maxSeconds, execution: task.taskDef.executionTimeout, schedule: task.taskDef.scheduleTimeout, ttl: 600000, clientAttempts: client.config.retrier?.maxAttempts } })
    await finished
    process.removeListener('message', onMessage)
  } catch { startupDone(); emit({ type: 'fatal' }); process.exitCode = 1; await shutdown() }
  finally { process.removeListener('message', earlyShutdown); if (process.connected) process.disconnect?.() }
}

void main().catch(() => { process.exitCode = 1; if (process.connected) { process.send?.({ type: 'fatal' }); process.disconnect?.() } })
