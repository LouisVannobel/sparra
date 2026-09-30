import { Schema } from 'effect'
import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import { V1TaskEventType, V1TaskStatus } from '@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.js'
import type { createAuthMailHandler, HandlerResult } from '../../src/modules/auth/mail-worker.server'

export const retryLabels = ['A', 'B', 'C', 'D', 'E'] as const
export type RetryLabel = typeof retryLabels[number]
export const deferredCodes = ['AUTH_MAIL_WORKER_STOPPING', 'AUTH_MAIL_OUTBOX_IN_FLIGHT', 'AUTH_MAIL_CAPACITY_BUSY', 'AUTH_MAIL_CLAIM_UNRESOLVED'] as const
export const retryCommandOperation = Schema.Literals(['begin', 'configure', 'admit', 'bind', 'release', 'release-lookup', 'cancel-A', 'history', 'shutdown'])
export const retryChildPhase = Schema.Literals(['run-details-request', 'task-events-request', 'identity-decoding', 'history-sanitization'])
const retryParentPhase = Schema.Literals(['a-sql-check-started', 'a-sql-check-completed', 'a-cancel-started', 'a-cancel-completed', 'a-first-history-started', 'a-first-history-completed'])
const commandReceipt = Schema.Struct({ id: Schema.Int, op: retryCommandOperation, label: Schema.NullOr(Schema.Literals(retryLabels)), ok: Schema.Boolean, phase: Schema.optional(retryChildPhase) })
export function safeRetryParentPhase(input: unknown) {
  try { return Schema.decodeUnknownSync(retryParentPhase)(input) }
  catch { throw retryFixtureError() }
}
export function appendRetryCommandReceipt(receipts: unknown[], input: unknown) {
  try {
    const value = Schema.decodeUnknownSync(commandReceipt)(input, { onExcessProperty: 'error' })
    if (value.id < 1 || value.phase !== undefined && (value.ok || value.op !== 'history')) throw retryFixtureError()
    receipts.push(value)
  } catch { throw retryFixtureError() }
}
export function retryFixtureError() { return new Error('MAIL_RETRY_FIXTURE_REJECTED') }
export function observeRetryHandler(handler: ReturnType<typeof createAuthMailHandler>, settled: (input: unknown, result: HandlerResult) => void): ReturnType<typeof createAuthMailHandler> {
  return { stop: handler.stop, async handle(input, signal) {
    const result = await handler.handle(input, signal)
    settled(input, result)
    return result
  } }
}

export function retryBudget(deadlineAtMs: number, now: () => number = Date.now) {
  if (!Number.isFinite(deadlineAtMs)) throw retryFixtureError()
  return Object.freeze({ deadlineAtMs, remaining(maximum: number) {
    const remaining = Math.floor(deadlineAtMs - now())
    if (remaining <= 0 || !Number.isInteger(maximum) || maximum <= 0) throw retryFixtureError()
    return Math.min(remaining, maximum)
  } })
}

export function createRetryBarriers() {
  let closed = false
  let closing: Promise<void> | undefined
  const entries = new Map<string, { controller: AbortController; release(): void; done: Promise<void> }>()
  function enter(id: string, controller: AbortController) {
    if (closed || controller.signal.aborted) { controller.abort(); return Promise.resolve() }
    if (entries.has(id) || entries.size >= 5) throw retryFixtureError()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const aborted = () => release()
    controller.signal.addEventListener('abort', aborted, { once: true })
    const done = pending.finally(() => { controller.signal.removeEventListener('abort', aborted); entries.delete(id) })
    entries.set(id, { controller, release, done })
    return done
  }
  function release(id: string) { const entry = entries.get(id); if (!entry) throw retryFixtureError(); entry.release() }
  function close() {
    if (closing) return closing
    closed = true
    const owned = [...entries.values()]
    for (const entry of owned) { entry.controller.abort(); entry.release() }
    closing = Promise.all(owned.map(entry => entry.done)).then(() => {})
    return closing
  }
  return { enter, release, close, pending: () => entries.size }
}

const decimal = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/))
const timestamp = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d{4}-\d\d-\d\d[T ][0-9:.]+(?:Z|[+-][0-9:]+)$/))
const interval = Schema.Struct({
  taskId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)), taskInsertedAt: timestamp,
  taskRetryCount: Schema.Int, appRetryIndex: Schema.Int, factor: Schema.Number, cap: Schema.Int,
  lowerSeconds: decimal, upperSeconds: decimal, widthSeconds: decimal,
  lowerClock: timestamp, upperClock: timestamp, retryAfter: timestamp,
})
export function checkedRetryInterval(rows: unknown) {
  try {
    const [value] = Schema.decodeUnknownSync(Schema.Array(interval).check(Schema.isMinLength(1), Schema.isMaxLength(1)))(rows)
    const lower = Number(value.lowerSeconds), upper = Number(value.upperSeconds), width = Number(value.widthSeconds)
    const expected = [5, 25, 30, 30][value.appRetryIndex - 1]
    if (value.factor !== 5 || value.cap !== 30 || expected === undefined || value.taskRetryCount < value.appRetryIndex
      || ![lower, upper, width].every(Number.isFinite) || width < 0 || width >= 3 || lower > expected || upper < expected
      || Math.abs(upper - lower - width) > 0.000001) throw retryFixtureError()
    return { ...value, expectedSeconds: expected }
  } catch { throw retryFixtureError() }
}

export function expiryGate(row: unknown, phase: 'before-failure' | 'after-expiry') {
  try {
    const value = Schema.decodeUnknownSync(Schema.Struct({ beforeExpiry: Schema.Boolean, expired: Schema.Boolean }))(row)
    return phase === 'before-failure' ? value.beforeExpiry && !value.expired : value.expired && !value.beforeExpiry
  } catch { throw retryFixtureError() }
}

const uuid = Schema.String.check(Schema.isUUID())
export function safeRetryRunIdentity(input: unknown, expected: { runId: string; taskId: string; tenantId: string }) {
  try {
    const value = Schema.decodeUnknownSync(Schema.Struct({ run: Schema.Struct({ metadata: Schema.Struct({ id: uuid }), tenantId: uuid, status: Schema.Literals(Object.values(V1TaskStatus)) }),
      tasks: Schema.Array(Schema.Struct({ taskExternalId: uuid, workflowRunExternalId: uuid, tenantId: uuid })).check(Schema.isMinLength(1), Schema.isMaxLength(1)) }))(input)
    if (value.run.metadata.id !== expected.runId || value.run.tenantId !== expected.tenantId
      || value.tasks[0].taskExternalId !== expected.taskId || value.tasks[0].workflowRunExternalId !== expected.runId || value.tasks[0].tenantId !== expected.tenantId) throw retryFixtureError()
    return { status: value.run.status }
  } catch { throw retryFixtureError() }
}
export async function readRetryHistory(client: Pick<HatchetClient, 'api' | 'tenantId'>,
  value: { runId?: string; taskId?: string } | undefined,
  observed: <A>(call: (signal: AbortSignal, timeout: number) => Promise<A>) => Promise<A>,
  setPhase: (phase: typeof retryChildPhase.Type) => void) {
  if (!value?.runId) throw retryFixtureError()
  setPhase('run-details-request')
  const state = await observed((signal, timeout) => client.api.v1WorkflowRunGet(value.runId!, { signal, timeout, maxContentLength: 65536 }))
  setPhase('identity-decoding')
  if (!value.taskId) throw retryFixtureError()
  const observedTaskId = value.taskId
  setPhase('task-events-request')
  const events = await observed((signal, timeout) => client.api.v1TaskEventList(observedTaskId, { limit: 100 }, { signal, timeout, maxContentLength: 65536 }))
  setPhase('identity-decoding')
  const decoded = safeRetryRunIdentity(state.data, { runId: value.runId, taskId: observedTaskId, tenantId: client.tenantId })
  setPhase('history-sanitization')
  return { status: decoded.status, events: safeRetryHistory(events.data) }
}
const historyRow = Schema.Struct({ id: Schema.Int, taskId: uuid, timestamp, eventType: Schema.Literals(Object.values(V1TaskEventType)),
  retryCount: Schema.optional(Schema.Int), attempt: Schema.optional(Schema.Int), errorMessage: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))) })
function errorCode(raw: string | undefined) {
  const exact = deferredCodes.find(code => raw === code || raw === `Error: ${code}`)
  if (exact || !raw) return exact
  try {
    // SDK1.28.2 getStepActionEvent serializes {message,stack}; the release's
    // dispatcher forwards EventPayload and REST returns ErrorMessage unchanged.
    // Decode only that shape, then discard stack before creating any observation.
    return Schema.decodeUnknownSync(Schema.Struct({ message: Schema.Literals(deferredCodes),
      stack: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))) }))(JSON.parse(raw), { onExcessProperty: 'error' }).message
  } catch { return undefined }
}
export function safeRetryHistory(input: unknown) {
  try {
    const value = Schema.decodeUnknownSync(Schema.Struct({ rows: Schema.Array(historyRow).check(Schema.isMaxLength(100)),
      pagination: Schema.optional(Schema.Struct({ next_page: Schema.optional(Schema.Int) })) }))(input)
    // The task endpoint applies LIMIT 100 but returns empty pagination metadata.
    if (value.rows.length === 100) throw retryFixtureError()
    if (value.pagination?.next_page !== undefined && value.pagination.next_page !== 0) throw retryFixtureError()
    return value.rows.map(row => {
      const code = errorCode(row.errorMessage)
      return { id: row.id, taskId: row.taskId, timestamp: row.timestamp, eventType: row.eventType,
        retryCount: row.retryCount ?? null, attempt: row.attempt ?? null, code: code ?? null,
        unclassifiedError: !!row.errorMessage && code === undefined }
    })
  } catch { throw retryFixtureError() }
}

export function safeRetryOutcome(input: unknown) {
  try {
    return Schema.decodeUnknownSync(Schema.Struct({ state: Schema.Literals(['inert', 'cancelled', 'held', 'effect_unknown', 'plunk_queued']),
      queuedEvidence: Schema.optional(Schema.Literals(['response_200', 'duplicate_409'])), emailId: Schema.optional(Schema.NullOr(uuid)) }))(input, { onExcessProperty: 'error' })
  } catch { throw retryFixtureError() }
}
