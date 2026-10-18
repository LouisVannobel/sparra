import { Schema } from 'effect'
import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import { V1TaskEventType, V1TaskStatus } from '@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.js'
import type { createAuthMailHandler, HandlerResult } from '../../src/modules/auth/mail-worker.server'

export const retryLabels = ['A', 'B', 'C', 'D', 'E'] as const
export type RetryLabel = typeof retryLabels[number]
export const deferredCodes = ['AUTH_MAIL_WORKER_STOPPING', 'AUTH_MAIL_OUTBOX_IN_FLIGHT', 'AUTH_MAIL_CAPACITY_BUSY', 'AUTH_MAIL_CLAIM_UNRESOLVED'] as const
export const retryCommandOperation = Schema.Literals(['begin', 'configure', 'admit', 'bind', 'release', 'release-lookup', 'cancel-A', 'history', 'shutdown'])
export const retryChildPhase = Schema.Literals(['run-details-request', 'task-events-request', 'identity-decoding', 'history-sanitization',
  'run-details-http-404', 'run-details-http-other', 'run-details-cancelled', 'run-details-timeout', 'run-details-transport', 'run-details-rejected',
  'run-details-aborted-before', 'run-details-aborted-after', 'run-details-budget-before', 'run-details-budget-after',
  'identity-shape', 'identity-tasks-empty', 'identity-task-count', 'identity-run-id-mismatch', 'identity-run-tenant-mismatch',
  'identity-task-id-mismatch', 'identity-task-run-mismatch', 'identity-task-tenant-mismatch'])
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
export type RetryParentFrame = { line: number; column: number }
export type RetryCommandDiagnostic = Pick<typeof commandReceipt.Type, 'op' | 'label' | 'ok' | 'phase'>
function retryParentFrame(sourceLine: string, ownedPath: string): RetryParentFrame | null {
  const frame = /^\s+at (?:[^()\r\n]+ \(([^()\r\n]+)\)|([^()\r\n]+))$/.exec(sourceLine.replaceAll('\\', '/'))
  if (!frame) return null
  const location = /^(.+):([1-9][0-9]{0,5}):([1-9][0-9]{0,5})$/.exec(frame[1] ?? frame[2])
  if (!location) return null
  const fileLocation = ownedPath.startsWith('/') ? `file://${ownedPath}` : `file:///${ownedPath}`
  if (![ownedPath, fileLocation].includes(location[1])) return null
  const line = Number(location[2]), column = Number(location[3])
  if (line > 100000 || column > 100000) return null
  return { line, column }
}
export function safeRetryParentFrames(input: unknown, ownedParentPath: string): RetryParentFrame[] {
  try {
    if (!(input instanceof Error)) return []
    const stack = input.stack, ownedPath = ownedParentPath.replaceAll('\\', '/')
    if (typeof stack !== 'string' || stack.length > 16384 || !/^(?:\/|[A-Za-z]:\/).+\/tests\/integration\/mail-retry-native\.test\.ts$/.test(ownedPath)) return []
    const frames: RetryParentFrame[] = []
    for (const sourceLine of stack.split(/\r?\n/)) {
      const frame = retryParentFrame(sourceLine, ownedPath)
      if (frame) frames.push(frame)
      if (frames.length === 4) break
    }
    return frames
  } catch { return [] }
}
export function safeRetryLastCommandReceipt(input: unknown): RetryCommandDiagnostic | null {
  try {
    const receipts: (typeof commandReceipt.Type)[] = []
    appendRetryCommandReceipt(receipts, input)
    const { op, label, ok, phase } = receipts[0]
    return phase === undefined ? { op, label, ok } : { op, label, ok, phase }
  } catch { return null }
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
const retryRun = Schema.Struct({ metadata: Schema.Struct({ id: uuid }), tenantId: uuid, status: Schema.Literals(Object.values(V1TaskStatus)) })
const retryTask = Schema.Struct({ taskExternalId: uuid, workflowRunExternalId: uuid, tenantId: uuid })
const retryRunDetails = Schema.Struct({ run: retryRun, tasks: Schema.Array(retryTask).check(Schema.isMinLength(1), Schema.isMaxLength(1)) })
export function safeRetryRunIdentity(input: unknown, expected: { runId: string; taskId: string; tenantId: string }) {
  try {
    const value = Schema.decodeUnknownSync(retryRunDetails)(input)
    if (value.run.metadata.id !== expected.runId || value.run.tenantId !== expected.tenantId
      || value.tasks[0].taskExternalId !== expected.taskId || value.tasks[0].workflowRunExternalId !== expected.runId || value.tasks[0].tenantId !== expected.tenantId) throw retryFixtureError()
    return { status: value.run.status }
  } catch { throw retryFixtureError() }
}
function retryIdentityRefusal(input: unknown, expected: Parameters<typeof safeRetryRunIdentity>[1]): typeof retryChildPhase.Type {
  try {
    const { run, tasks } = Schema.decodeUnknownSync(Schema.Struct({ run: retryRun, tasks: Schema.Unknown }))(input)
    if (!Array.isArray(tasks)) return 'identity-shape'
    if (tasks.length === 0) return 'identity-tasks-empty'
    if (tasks.length !== 1) return 'identity-task-count'
    const task = Schema.decodeUnknownSync(retryTask)(tasks[0])
    if (run.metadata.id !== expected.runId) return 'identity-run-id-mismatch'
    if (run.tenantId !== expected.tenantId) return 'identity-run-tenant-mismatch'
    if (task.taskExternalId !== expected.taskId) return 'identity-task-id-mismatch'
    if (task.workflowRunExternalId !== expected.runId) return 'identity-task-run-mismatch'
    if (task.tenantId !== expected.tenantId) return 'identity-task-tenant-mismatch'
    return 'identity-shape'
  } catch { return 'identity-shape' }
}
function decodeRetryHistoryIdentity(state: { data: unknown }, expected: Parameters<typeof safeRetryRunIdentity>[1],
  setPhase: (phase: typeof retryChildPhase.Type) => void) {
  setPhase('identity-decoding')
  try { return safeRetryRunIdentity(state.data, expected) }
  catch { setPhase(retryIdentityRefusal(state.data, expected)); throw retryFixtureError() }
}

function ownedEmptyRetryProjection(input: unknown, expected: { runId: string; tenantId: string }) {
  try {
    const { run, tasks } = Schema.decodeUnknownSync(Schema.Struct({ run: retryRun, tasks: Schema.Unknown }))(input)
    if (run.metadata.id !== expected.runId || run.tenantId !== expected.tenantId) return false
    return Array.isArray(tasks) && tasks.length === 0
  } catch { return false }
}
function pauseRetryProjection(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(retryFixtureError())
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, milliseconds)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
// Axios1.20.0 stores these scalar data fields on its error instance. Do not
// invoke isAxiosError/toJSON or inspect response/config/message/stack getters.
type RetryDiagnosticScalar = string | number | boolean | null | undefined
function ownDiagnosticValue(input: unknown, key: 'isAxiosError' | 'status' | 'code'): RetryDiagnosticScalar {
  if (typeof input !== 'object' || input === null) throw retryFixtureError()
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) throw retryFixtureError()
  const value: unknown = descriptor.value
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  throw retryFixtureError()
}
function runDetailsFailurePhase(input: unknown): typeof retryChildPhase.Type {
  try {
    if (typeof input !== 'object' || input === null) return 'run-details-rejected'
    const marker = ownDiagnosticValue(input, 'isAxiosError')
    const status = ownDiagnosticValue(input, 'status')
    const code = ownDiagnosticValue(input, 'code')
    if (marker !== true) return 'run-details-rejected'
    if (status === 404) return 'run-details-http-404'
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      && (status < 200 || status >= 300)) return 'run-details-http-other'
    switch (code) {
      case 'ERR_CANCELED': return 'run-details-cancelled'
      case 'ECONNABORTED':
      case 'ETIMEDOUT': return 'run-details-timeout'
      case 'ERR_NETWORK':
      case 'ECONNREFUSED':
      case 'ECONNRESET':
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
      case 'EPIPE': return 'run-details-transport'
      default: return 'run-details-rejected'
    }
  } catch { return 'run-details-rejected' }
}

export async function readRetryHistory(client: Pick<HatchetClient, 'api' | 'tenantId'>,
  value: { runId?: string; taskId?: string; deadlineAtMs?: number } | undefined,
  observed: <A>(call: (signal: AbortSignal, timeout: number) => Promise<A>) => Promise<A>,
  setPhase: (phase: typeof retryChildPhase.Type) => void) {
  if (!value?.runId) throw retryFixtureError()
  if (!value.taskId) { setPhase('identity-decoding'); throw retryFixtureError() }
  if (value.deadlineAtMs === undefined) throw retryFixtureError()
  const expected = { runId: value.runId, taskId: value.taskId, tenantId: client.tenantId }
  const budget = retryBudget(value.deadlineAtMs)
  budget.remaining(10000)
  setPhase('run-details-request')
  const decoded = await observed(async (signal, timeout) => {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 10000) throw retryFixtureError()
    function checkedAllowance(stage: 'before' | 'after', maximum: number) {
      if (signal.aborted) {
        setPhase(stage === 'before' ? 'run-details-aborted-before' : 'run-details-aborted-after')
        throw retryFixtureError()
      }
      try { return budget.remaining(maximum) }
      catch (error) {
        setPhase(stage === 'before' ? 'run-details-budget-before' : 'run-details-budget-after')
        throw error
      }
    }
    for (;;) {
      const requestTimeout = checkedAllowance('before', timeout)
      let state: Awaited<ReturnType<typeof client.api.v1WorkflowRunGet>>
      try {
        state = await client.api.v1WorkflowRunGet(expected.runId, { signal, timeout: requestTimeout, maxContentLength: 65536 })
      } catch (error) { setPhase(runDetailsFailurePhase(error)); throw error }
      checkedAllowance('after', 10000)
      if (!ownedEmptyRetryProjection(state.data, expected)) {
        const identity = decodeRetryHistoryIdentity(state, expected, setPhase)
        if (signal.aborted) throw retryFixtureError()
        budget.remaining(10000)
        return identity
      }
      setPhase('identity-tasks-empty')
      await pauseRetryProjection(signal, budget.remaining(50))
      if (signal.aborted) throw retryFixtureError()
      budget.remaining(10000)
      setPhase('run-details-request')
    }
  })
  budget.remaining(10000)
  setPhase('task-events-request')
  const events = await observed(async (signal, timeout) => {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 10000) throw retryFixtureError()
    if (signal.aborted) throw retryFixtureError()
    const response = await client.api.v1TaskEventList(expected.taskId, { limit: 100 }, { signal, timeout: budget.remaining(timeout), maxContentLength: 65536 })
    if (signal.aborted) throw retryFixtureError()
    budget.remaining(10000)
    setPhase('history-sanitization')
    const result = safeRetryHistory(response.data)
    if (signal.aborted) throw retryFixtureError()
    budget.remaining(10000)
    return result
  })
  budget.remaining(10000)
  return { status: decoded.status, events }
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
