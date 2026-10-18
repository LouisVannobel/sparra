import { expect, test, vi } from 'vitest'
import { Api } from '@hatchet-dev/typescript-sdk/clients/rest/generated/Api.js'
import { checkedRetryInterval, createRetryBarriers, expiryGate, retryBudget, safeRetryHistory, safeRetryOutcome, observeRetryHandler, safeRetryRunIdentity, safeRetryParentPhase, appendRetryCommandReceipt, readRetryHistory, safeRetryParentFrames as parentFailureFrames, safeRetryLastCommandReceipt as lastCommandFailure } from '../helpers/mail-retry-observation'

test('one absolute observation budget shrinks across calls and cannot restart after expiry', () => {
  let now = 10
  const budget = retryBudget(300010, () => now)
  expect(budget.remaining(10000)).toBe(10000)
  now = 299990; expect(budget.remaining(10000)).toBe(20)
  now = 300010; expect(() => budget.remaining(10000)).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
})
test('before barriers own each actual hook receipt and abort/release/join all cleanup paths', async () => {
  const barriers = createRetryBarriers(), first = new AbortController(), second = new AbortController()
  let done = 0
  const a = barriers.enter('a', first).then(() => { done++ })
  const b = barriers.enter('b', second).then(() => { done++ })
  expect(() => barriers.enter('a', new AbortController())).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect({ pending: barriers.pending(), done }).toEqual({ pending: 2, done: 0 })
  barriers.release('a'); await a; expect(barriers.pending()).toBe(1)
  await barriers.close(); await b
  expect(second.signal.aborted).toBe(true); expect(done).toBe(2); expect(barriers.pending()).toBe(0)
  const late = new AbortController(); await barriers.enter('late', late); expect(late.signal.aborted).toBe(true)
})
test('parent cancellation joins a before hook instead of leaving a hidden waiter', async () => {
  const barriers = createRetryBarriers(), parent = new AbortController()
  const hook = barriers.enter('e', parent)
  parent.abort(); await hook
  expect(barriers.pending()).toBe(0)
  await barriers.close()
})
test('concurrent cleanup callers receive the same joined barrier promise', async () => {
  const barriers = createRetryBarriers()
  const pending = barriers.enter('owned', new AbortController())
  const first = barriers.close(), second = barriers.close()
  expect(first === second).toBe(true)
  await first; await pending
  expect(barriers.pending()).toBe(0)
})
test('actual handler receipt remains pending after wrapper cancellation until its own promise settles', async () => {
  let release!: () => void, receipts = 0
  const pending = new Promise<void>(resolve => { release = resolve })
  const handler = observeRetryHandler({ handle: async () => { await pending; return { state: 'effect_unknown' as const } }, stop: async () => { await pending } }, () => { receipts++ })
  const controller = new AbortController()
  const actual = handler.handle({}, controller.signal)
  controller.abort(); await Promise.resolve()
  expect(receipts).toBe(0)
  release(); await actual
  expect(receipts).toBe(1)
})
const row = { taskId: '42', taskInsertedAt: '2026-09-11 00:00:00+00', taskRetryCount: 1, appRetryIndex: 1, factor: 5, cap: 30,
  lowerSeconds: '4.8', upperSeconds: '6.1', widthSeconds: '1.3', lowerClock: '2026-09-11 00:00:00+00', upperClock: '2026-09-11 00:00:01.3+00', retryAfter: '2026-09-11 00:00:06.1+00' }
test.each([[1, '4.8', '6.1', 5], [2, '24.8', '26.1', 25], [3, '29.8', '31.1', 30], [4, '29.8', '31.1', 30]] as const)('interval matches observed app retry index %s without using execution timestamps', (index, lower, upper, expected) => {
  expect(checkedRetryInterval([{ ...row, taskRetryCount: index, appRetryIndex: index, lowerSeconds: lower, upperSeconds: upper }]).expectedSeconds).toBe(expected)
})
test('ambiguous, too-wide, wrong-index/config and hostile intervals fail without echoing captures', () => {
  for (const rows of [[], [row, row], [{ ...row, widthSeconds: '3', lowerSeconds: '4', upperSeconds: '7' }], [{ ...row, appRetryIndex: 0 }], [{ ...row, factor: 2 }], [{ ...row, lowerSeconds: '1', upperSeconds: '2.3' }], [{ ...row, taskId: 'private-payload' }]]) {
    let message = ''
    try { checkedRetryInterval(rows) } catch (error) { message = error instanceof Error ? error.message : '' }
    expect(message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
  }
})
test('expiry milestones require actual before/after observations rather than planned native waits', () => {
  expect(expiryGate({ beforeExpiry: true, expired: false }, 'before-failure')).toBe(true)
  expect(expiryGate({ beforeExpiry: true, expired: false }, 'after-expiry')).toBe(false)
  expect(expiryGate({ beforeExpiry: false, expired: true }, 'after-expiry')).toBe(true)
  expect(expiryGate({ beforeExpiry: false, expired: true }, 'before-failure')).toBe(false)
})
test('history exposes only identifiers, counters, timestamps and known safe codes', () => {
  const rows = [{ id: 1, taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, errorMessage: 'private payload', input: { secret: 'hidden' }, output: 'private output' }]
  const safe = safeRetryHistory({ rows })
  expect(safe[0].unclassifiedError).toBe(true)
  expect(JSON.stringify(safe).includes('private') || JSON.stringify(safe).includes('hidden')).toBe(false)
  expect(safeRetryHistory({ rows: [{ ...rows[0], errorMessage: 'AUTH_MAIL_CLAIM_UNRESOLVED' }] })[0].code).toBe('AUTH_MAIL_CLAIM_UNRESOLVED')
  expect(() => safeRetryOutcome({ state: 'inert', secret: 'hidden' })).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
})
test('hostile event names and clock text never escape through supposedly safe observations', () => {
  expect(() => safeRetryHistory({ rows: [{ id: 1, taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timestamp: '2026-09-11T00:00:00Z', eventType: 'private-secret-value' }] })).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(() => checkedRetryInterval([{ ...row, lowerClock: 'private-secret-value' }])).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
})
test('published SDK JSON error envelope exposes only its exact allowlisted message, never its stack', () => {
  const event = { id: 1, taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0 }
  const known = safeRetryHistory({ rows: [{ ...event, errorMessage: JSON.stringify({ message: 'AUTH_MAIL_CLAIM_UNRESOLVED', stack: 'private-stack-content' }) }] })
  expect(known[0].code).toBe('AUTH_MAIL_CLAIM_UNRESOLVED')
  expect(JSON.stringify(known).includes('private')).toBe(false)
  for (const errorMessage of [JSON.stringify({ message: 'prefix AUTH_MAIL_CLAIM_UNRESOLVED' }), JSON.stringify({ message: 'AUTH_MAIL_CLAIM_UNRESOLVED', cause: 'private' }), 'AUTH_MAIL_CLAIM_UNRESOLVED\nprivate']) {
    expect(safeRetryHistory({ rows: [{ ...event, errorMessage }] })[0].unclassifiedError).toBe(true)
  }
})
const identity = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
const published = { run: { metadata: { id: identity.runId }, status: 'CANCELLED', tenantId: identity.tenantId, input: 'private-input', output: 'private-output' },
  tasks: [{ taskExternalId: identity.taskId, workflowRunExternalId: identity.runId, tenantId: identity.tenantId, errorMessage: 'private-error' }], taskEvents: [{ message: 'private-message' }] }
test('actual shared run decoder accepts published metadata/tasks with distinct identities and emits status only', () => {
  expect(safeRetryRunIdentity(published, identity)).toEqual({ status: 'CANCELLED' })
  expect(JSON.stringify(safeRetryRunIdentity(published, identity)).includes('private')).toBe(false)
})
test('run decoder rejects wrong run/task/binding/tenants and extra or missing tasks without echoing response data', () => {
  const task = published.tasks[0]
  for (const input of [
    { ...published, run: { ...published.run, metadata: { id: identity.taskId } } },
    { ...published, tasks: [{ ...task, taskExternalId: identity.runId }] },
    { ...published, tasks: [{ ...task, workflowRunExternalId: identity.taskId }] },
    { ...published, run: { ...published.run, tenantId: identity.runId } },
    { ...published, tasks: [{ ...task, tenantId: identity.runId }] },
    { ...published, tasks: [] }, { ...published, tasks: [task, task] },
    { ...published, run: { ...published.run, metadata: { id: 'private-run' } } },
  ]) expect(() => safeRetryRunIdentity(input, identity)).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
})
test('constant parent phases reject arbitrary data and preserve approved milestones', () => {
  expect(safeRetryParentPhase('a-sql-check-started')).toBe('a-sql-check-started')
  for (const value of ['private-stage', { phase: 'a-sql-check-started', secret: 'private' }]) expect(() => safeRetryParentPhase(value)).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
})
test('command receipts preserve closed successful and failed observations without raw command data', () => {
  const receipts: unknown[] = []
  appendRetryCommandReceipt(receipts, { id: 1, op: 'cancel-A', label: 'A', ok: true })
  appendRetryCommandReceipt(receipts, { id: 2, op: 'history', label: 'A', ok: false, phase: 'identity-decoding' })
  expect(receipts).toEqual([{ id: 1, op: 'cancel-A', label: 'A', ok: true }, { id: 2, op: 'history', label: 'A', ok: false, phase: 'identity-decoding' }])
  for (const value of [{ id: 3, op: 'private-op', label: 'A', ok: false }, { id: 3, op: 'history', label: 'unknown', ok: false },
    { id: 'private-id', op: 'history', label: 'A', ok: false }, { id: 3, op: 'history', label: 'A', ok: false, phase: 'private-stage' },
    { id: 3, op: 'history', label: 'A', ok: false, error: 'private-error' }]) expect(() => appendRetryCommandReceipt(receipts, value)).toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(receipts).toHaveLength(2)
  expect(JSON.stringify(receipts).includes('private')).toBe(false)
})

const taskEvent = { id: 7, taskId: identity.taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, attempt: 1,
  errorMessage: JSON.stringify({ message: 'AUTH_MAIL_CAPACITY_BUSY', stack: 'private-stack' }), output: 'private-output' }
function historyFixture(runDetails: unknown = published, taskEvents: unknown = { rows: [taskEvent], pagination: {} }, failureAt?: number) {
  const requests: unknown[] = [], phases: string[] = [], timeouts: number[] = []
  const signals = [new AbortController().signal, new AbortController().signal]
  let observations = 0
  // Use the installed SDK's real request generation; only its network adapter is replaced.
  const client = { tenantId: identity.tenantId, api: new Api({ adapter: async config => {
    expect(config.signal).toBe(signals[requests.length])
    requests.push({ url: config.url, method: config.method, params: config.params,
      signal: config.signal, timeout: config.timeout, maxContentLength: config.maxContentLength })
    if (typeof config.timeout !== 'number') throw new Error('MISSING_OWNED_TIMEOUT')
    timeouts.push(config.timeout)
    if (requests.length === failureAt) throw new Error('private-transport-error')
    return { status: 200, statusText: 'OK', headers: {}, config, data: requests.length === 1 ? runDetails : taskEvents }
  } }) }
  const observed: Parameters<typeof readRetryHistory>[2] = call => {
    const index = observations++
    return call(signals[index], [8123, 7123][index])
  }
  return { requests, phases, signals, timeouts, read: (value: Parameters<typeof readRetryHistory>[1] = identity) => {
    const commandValue = { ...value, deadlineAtMs: Date.now() + 10000 }
    return readRetryHistory(client, commandValue, observed, phase => { phases.push(phase) })
  } }
}
test('harness history uses the run ID for details and observed task ID for task events with owned request limits', async () => {
  const fixture = historyFixture()
  const result = await fixture.read()
  expect(fixture.requests).toEqual([
    { url: `/api/v1/stable/workflow-runs/${identity.runId}`, method: 'get', params: undefined, signal: fixture.signals[0], timeout: expect.any(Number), maxContentLength: 65536 },
    { url: `/api/v1/stable/tasks/${identity.taskId}/task-events`, method: 'get', params: { limit: 100 }, signal: fixture.signals[1], timeout: 7123, maxContentLength: 65536 },
  ])
  expect(fixture.timeouts[0]).toBeGreaterThan(0)
  expect(fixture.timeouts[0]).toBeLessThanOrEqual(8123)
  expect(result).toEqual({ status: 'CANCELLED', events: [{ id: 7, taskId: identity.taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, attempt: 1,
    code: 'AUTH_MAIL_CAPACITY_BUSY', unclassifiedError: false }] })
  expect(fixture.phases).toEqual(['run-details-request', 'identity-decoding', 'task-events-request', 'history-sanitization'])
  expect(JSON.stringify(result).includes('private')).toBe(false)
})
test('harness history rejects a missing observed task ID before making any request', async () => {
  const fixture = historyFixture()
  await expect(fixture.read({ runId: identity.runId })).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(fixture.requests).toHaveLength(0)
  expect(fixture.phases.at(-1)).toBe('identity-decoding')
})
test('harness history preserves all run, task, workflow, tenant and single-task correlations', async () => {
  const task = published.tasks[0]
  for (const [state, phase] of [
    [{ ...published, run: { ...published.run, metadata: { id: identity.taskId } } }, 'identity-run-id-mismatch'],
    [{ ...published, tasks: [{ ...task, taskExternalId: identity.runId }] }, 'identity-task-id-mismatch'],
    [{ ...published, tasks: [{ ...task, workflowRunExternalId: identity.taskId }] }, 'identity-task-run-mismatch'],
    [{ ...published, run: { ...published.run, tenantId: identity.runId } }, 'identity-run-tenant-mismatch'],
    [{ ...published, tasks: [{ ...task, tenantId: identity.runId }] }, 'identity-task-tenant-mismatch'],
    [{ ...published, tasks: [task, task] }, 'identity-task-count'],
  ] as const) {
    const fixture = historyFixture(state)
    await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.phases.at(-1)).toBe(phase)
    const receipts: unknown[] = []
    appendRetryCommandReceipt(receipts, { id: 1, op: 'history', label: 'B', ok: false, phase: fixture.phases.at(-1) })
    expect(receipts).toEqual([{ id: 1, op: 'history', label: 'B', ok: false, phase }])
    expect(JSON.stringify(receipts)).not.toMatch(/private|aaaaaaaa|bbbbbbbb|cccccccc|https/)
  }
})
// This fixture keeps the installed SDK's request/response path real. Only HTTP is controlled.
// Empty membership is never accepted; the details sequence exposes a later exact owned row.
function projectedHistoryFixture(details: readonly unknown[], timeout = 120, afterDetails: (count: number) => void | Promise<void> = () => {},
  options: { deadlineAtMs?: number; afterEvents?: () => void | Promise<void>; events?: unknown } = {}) {
  const requests: unknown[] = [], timeouts: number[] = [], eventTimeouts: number[] = [], phases: string[] = []
  const controllers = [new AbortController(), new AbortController()]
  const commandValue = { ...identity, deadlineAtMs: options.deadlineAtMs ?? Date.now() + timeout }
  let observations = 0, detailsRead = 0
  const client = { tenantId: identity.tenantId, api: new Api({ adapter: async config => {
    const isDetails = config.url === `/api/v1/stable/workflow-runs/${identity.runId}`
    expect(config.method).toBe('get')
    expect(config.signal).toBe(controllers[isDetails ? 0 : 1].signal)
    expect(config.maxContentLength).toBe(65536)
    if (typeof config.timeout !== 'number') throw new Error('MISSING_OWNED_TIMEOUT')
    expect(config.timeout).toBeGreaterThan(0)
    expect(Number.isInteger(config.timeout)).toBe(true)
    expect(config.timeout).toBeLessThanOrEqual(isDetails ? timeout : 7123)
    if (isDetails) timeouts.push(config.timeout)
    requests.push({ url: config.url, params: config.params, signal: config.signal })
    if (isDetails) {
      const data = details[detailsRead++]
      await afterDetails(detailsRead)
      return { status: 200, statusText: 'OK', headers: {}, config, data }
    }
    eventTimeouts.push(config.timeout)
    await options.afterEvents?.()
    return { status: 200, statusText: 'OK', headers: {}, config, data: options.events ?? { rows: [taskEvent], pagination: {} } }
  } }) }
  const observed: Parameters<typeof readRetryHistory>[2] = call => {
    const index = observations++
    return call(controllers[index].signal, index === 0 ? timeout : 7123)
  }
  return { requests, timeouts, eventTimeouts, phases, controllers, commandValue, client, observationCount: () => observations,
    read: () => readRetryHistory(client, commandValue, observed, phase => { phases.push(phase) }) }
}
test('history waits for exact owned OLAP membership inside one shrinking request owner before reading task events', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([{ ...published, tasks: [] }, { ...published, tasks: [] }, published])
    const outcome = fixture.read().then(value => value, error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toEqual({ status: 'CANCELLED', events: [{ id: 7, taskId: identity.taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, attempt: 1,
      code: 'AUTH_MAIL_CAPACITY_BUSY', unclassifiedError: false }] })
    expect(fixture.requests).toEqual([
      { url: `/api/v1/stable/workflow-runs/${identity.runId}`, params: undefined, signal: fixture.controllers[0].signal },
      { url: `/api/v1/stable/workflow-runs/${identity.runId}`, params: undefined, signal: fixture.controllers[0].signal },
      { url: `/api/v1/stable/workflow-runs/${identity.runId}`, params: undefined, signal: fixture.controllers[0].signal },
      { url: `/api/v1/stable/tasks/${identity.taskId}/task-events`, params: { limit: 100 }, signal: fixture.controllers[1].signal },
    ])
    expect(fixture.timeouts[1]).toBeLessThan(fixture.timeouts[0])
    expect(fixture.timeouts[2]).toBeLessThan(fixture.timeouts[1])
    expect(fixture.observationCount()).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('delayed history delivery consumes the parent deadline and gives events only its short global remainder', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([published], 120, () => {}, { deadlineAtMs: 1025 })
    vi.setSystemTime(1020) // Time spent delivering the already-created command must not restart its budget.
    const result = await fixture.read()
    expect(result.status).toBe('CANCELLED')
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.timeouts[0]).toBeGreaterThan(0)
    expect(fixture.timeouts[0]).toBeLessThanOrEqual(5)
    expect(fixture.eventTimeouts[0]).toBeGreaterThan(0)
    expect(fixture.eventTimeouts[0]).toBeLessThanOrEqual(5)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('a history command delivered at its parent deadline admits no details or events request', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([published], 120, () => {}, { deadlineAtMs: 1025 })
    vi.setSystemTime(1025)
    await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.requests).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('membership appearing near the parent deadline cannot give events a fresh allowance', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([{ ...published, tasks: [] }, published], 120,
      count => { if (count === 2) vi.setSystemTime(1115) })
    const outcome = fixture.read().then(value => value, error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ status: 'CANCELLED' })
    expect(fixture.timeouts).toHaveLength(2)
    expect(fixture.eventTimeouts).toHaveLength(1)
    expect(fixture.eventTimeouts[0]).toBeGreaterThan(0)
    expect(fixture.eventTimeouts[0]).toBeLessThanOrEqual(5)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('history keeps the expected run task and tenant captured before the first awaited details response', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([{ ...published, tasks: [] }, published], 120, count => {
      if (count === 1) {
        fixture.commandValue.runId = identity.taskId
        fixture.commandValue.taskId = identity.runId
        fixture.client.tenantId = identity.runId
      }
    })
    const outcome = fixture.read().then(value => value, error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ status: 'CANCELLED' })
    expect(fixture.requests).toEqual([
      { url: `/api/v1/stable/workflow-runs/${identity.runId}`, params: undefined, signal: fixture.controllers[0].signal },
      { url: `/api/v1/stable/workflow-runs/${identity.runId}`, params: undefined, signal: fixture.controllers[0].signal },
      { url: `/api/v1/stable/tasks/${identity.taskId}/task-events`, params: { limit: 100 }, signal: fixture.controllers[1].signal },
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('an events response at the parent deadline cannot succeed even when the abort timer has not fired', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([published], 120, () => {},
      { deadlineAtMs: 1025, afterEvents: () => { vi.setSystemTime(1025) } })
    await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.controllers[1].signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('crossing the parent deadline during event sanitization cannot publish accepted history', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const eventData = { get rows() { vi.setSystemTime(1025); return [taskEvent] }, pagination: {} }
    const fixture = projectedHistoryFixture([published], 120, () => {},
      { deadlineAtMs: 1025, afterEvents: () => { vi.setSystemTime(1024) }, events: eventData })
    await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.phases.at(-1)).toBe('history-sanitization')
    expect(fixture.requests).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test.each(['details', 'events'] as const)('shutdown during the in-flight %s request joins its actual adapter promise without another request', async stage => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    const fixture = projectedHistoryFixture([published], 120, () => stage === 'details' ? held : undefined,
      { afterEvents: () => stage === 'events' ? held : undefined })
    let settled = false
    const outcome = fixture.read().then(value => { settled = true; return value }, error => { settled = true; return error })
    await vi.advanceTimersByTimeAsync(0)
    const requestCount = stage === 'details' ? 1 : 2
    expect(fixture.requests).toHaveLength(requestCount)
    fixture.controllers[stage === 'details' ? 0 : 1].abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    release()
    const failure: unknown = await outcome
    expect(failure).toBeInstanceOf(Error)
    expect(fixture.requests).toHaveLength(requestCount)
    expect(vi.getTimerCount()).toBe(0)
  } finally { release(); vi.useRealTimers() }
})
test('missing or invalid parent history deadlines are refused before the installed SDK admits HTTP', async () => {
  const requests: unknown[] = []
  const controller = new AbortController()
  const client = { tenantId: identity.tenantId, api: new Api({ adapter: async config => {
    requests.push(config.url)
    return { status: 200, statusText: 'OK', headers: {}, config, data: published }
  } }) }
  const observed: Parameters<typeof readRetryHistory>[2] = call => call(controller.signal, 10000)
  for (const deadlineAtMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const commandValue = { ...identity, deadlineAtMs }
    await expect(readRetryHistory(client, commandValue, observed, () => {})).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(requests).toHaveLength(0)
  }
})
test('repeated owned empty projections share one deadline instead of restarting a budget for each GET', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const empty = { ...published, tasks: [] }
    const fixture = projectedHistoryFixture([empty, empty, empty, published])
    const outcome = fixture.read().catch(error => error)
    await vi.advanceTimersByTimeAsync(120)
    const failure: unknown = await outcome
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.timeouts).toHaveLength(3)
    expect(fixture.timeouts[1]).toBeLessThan(fixture.timeouts[0])
    expect(fixture.timeouts[2]).toBeLessThan(fixture.timeouts[1])
    expect(fixture.requests).toHaveLength(3)
    expect(fixture.observationCount()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('owned empty membership remains a refusal at the original deadline without a new request or task-event admission', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([{ ...published, tasks: [] }, published], 25)
    const outcome = fixture.read().catch(error => error)
    await vi.advanceTimersByTimeAsync(25)
    const failure: unknown = await outcome
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
    expect(Date.now()).toBe(1025)
    expect(fixture.phases.at(-1)).toBe('identity-tasks-empty')
    expect(fixture.requests).toEqual([{ url: `/api/v1/stable/workflow-runs/${identity.runId}`, params: undefined, signal: fixture.controllers[0].signal }])
    expect(fixture.observationCount()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('empty membership with a foreign or malformed run cannot enter the owned projection wait', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    for (const run of [
      { ...published.run, metadata: { id: identity.taskId } },
      { ...published.run, tenantId: identity.runId },
      { ...published.run, metadata: { id: 'private-run' } },
      { ...published.run, tenantId: 'private-tenant' },
      { ...published.run, status: 'private-status' },
    ]) {
      const fixture = projectedHistoryFixture([{ ...published, run, tasks: [] }, published])
      const outcome = fixture.read().catch(error => error)
      await vi.runAllTimersAsync()
      const failure: unknown = await outcome
      expect(failure).toBeInstanceOf(Error)
      expect(failure instanceof Error && failure.message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
      expect(fixture.timeouts).toHaveLength(1)
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.eventTimeouts).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  } finally { vi.useRealTimers() }
})
test('a later foreign, malformed or multiple-task projection never becomes pending or accepted', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    for (const tasks of [
      [{ ...published.tasks[0], taskExternalId: identity.runId }],
      [{ ...published.tasks[0], workflowRunExternalId: identity.taskId }],
      [{ ...published.tasks[0], tenantId: identity.runId }],
      [published.tasks[0], published.tasks[0]], 'private-tasks', [{ private: 'private-task' }],
    ]) {
      const fixture = projectedHistoryFixture([{ ...published, tasks: [] }, { ...published, tasks }, published])
      const outcome = fixture.read().catch(error => error)
      await vi.runAllTimersAsync()
      const failure: unknown = await outcome
      expect(failure).toBeInstanceOf(Error)
      expect(failure instanceof Error && failure.message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
      expect(fixture.timeouts).toHaveLength(2)
      expect(fixture.requests).toHaveLength(2)
      expect(fixture.eventTimeouts).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  } finally { vi.useRealTimers() }
})
test('shutdown aborts and joins the owned projection delay without another GET or event request', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([{ ...published, tasks: [] }, published])
    const outcome = fixture.read().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    fixture.controllers[0].abort()
    const failure: unknown = await outcome
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.observationCount()).toBe(1)
  } finally { vi.useRealTimers() }
})
test('a pre-aborted owner admits no request and a response at its deadline cannot be accepted', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const aborted = projectedHistoryFixture([published])
    aborted.controllers[0].abort()
    await expect(aborted.read()).rejects.toBeInstanceOf(Error)
    expect(aborted.requests).toHaveLength(0)
    const expired = projectedHistoryFixture([published], 25, () => { vi.setSystemTime(1025) })
    await expect(expired.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(expired.requests).toHaveLength(1)
    expect(expired.observationCount()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('a response delivered after owner cancellation cannot admit task events or return history', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  try {
    const fixture = projectedHistoryFixture([published], 120, () => { fixture.controllers[0].abort() })
    await expect(fixture.read()).rejects.toBeInstanceOf(Error)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.observationCount()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
test('harness history reduces malformed and hostile identity data to one finite shape refusal without raw fallback', async () => {
  const hostile = Object.defineProperty({}, 'run', { get() { throw new Error('private-identity-access https://private.invalid') } })
  for (const state of [null, { run: undefined }, 'private-raw-identity', hostile, { ...published, tasks: 'private-tasks' },
    { ...published, run: { ...published.run, metadata: { id: 'private-run' } } },
    { ...published, run: { ...published.run, status: 'private-status' } },
    { ...published, tasks: [{ ...published.tasks[0], taskExternalId: 'private-task' }] },
  ]) {
    const fixture = historyFixture(state)
    const failure: unknown = await fixture.read().catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.phases.at(-1)).toBe('identity-shape')
    expect(fixture.requests).toHaveLength(1)
    const receipts: unknown[] = []
    appendRetryCommandReceipt(receipts, { id: 1, op: 'history', label: 'B', ok: false, phase: fixture.phases.at(-1) })
    expect(receipts).toEqual([{ id: 1, op: 'history', label: 'B', ok: false, phase: 'identity-shape' }])
    expect(JSON.stringify(receipts)).not.toMatch(/private|aaaaaaaa|bbbbbbbb|cccccccc|https/)
  }
})
test('harness history reports cardinality before binding and emits no details for a rejected multi-task response', async () => {
  const fixture = historyFixture({ ...published, run: { ...published.run, tenantId: identity.runId },
    tasks: [published.tasks[0], { private: 'private-unknown-task https://private.invalid' }] })
  await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(fixture.phases.at(-1)).toBe('identity-task-count')
  expect(fixture.requests).toHaveLength(1)
})
test('harness history rejects 100 task-event rows despite empty pagination metadata', async () => {
  const fixture = historyFixture(published, { rows: Array.from({ length: 100 }, (_, id) => ({ ...taskEvent, id })), pagination: {} })
  await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(fixture.phases.at(-1)).toBe('history-sanitization')
})
test('harness history preserves 99 task-event rows as grouped evidence without claiming an execution count', async () => {
  const fixture = historyFixture(published, { rows: Array.from({ length: 99 }, (_, id) => ({ ...taskEvent, id })), pagination: {} })
  const result = await fixture.read()
  expect(result.events).toHaveLength(99)
  expect(result.events[98]).toEqual({ id: 98, taskId: identity.taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, attempt: 1,
    code: 'AUTH_MAIL_CAPACITY_BUSY', unclassifiedError: false })
})
test('harness history does not manufacture missing or unrelated native evidence', async () => {
  expect((await historyFixture(published, { rows: [], pagination: {} }).read()).events).toEqual([])
  const unrelated = await historyFixture(published, { rows: [{ ...taskEvent, taskId: identity.runId, eventType: 'QUEUED', errorMessage: undefined }] }).read()
  expect(unrelated.events[0]).toMatchObject({ taskId: identity.runId, eventType: 'QUEUED', code: null })
  const missingRetry = await historyFixture(published, { rows: [{ ...taskEvent, retryCount: undefined, attempt: undefined }] }).read()
  expect(missingRetry.events[0]).toMatchObject({ retryCount: null, attempt: null })
  const unclassified = await historyFixture(published, { rows: [{ ...taskEvent, errorMessage: 'private-error' }] }).read()
  expect(unclassified.events[0]).toMatchObject({ code: null, unclassifiedError: true })
  expect(JSON.stringify(unclassified).includes('private')).toBe(false)
})
test('harness history failures keep request and decoder phases closed without recording transport details', async () => {
  for (const [fixture, phase] of [
    [historyFixture(published, {}, 1), 'run-details-request'],
    [historyFixture(published, {}, 2), 'task-events-request'],
    [historyFixture(published, { rows: [{ ...taskEvent, eventType: 'private-event' }] }), 'history-sanitization'],
    [historyFixture(published, { rows: [taskEvent], pagination: { next_page: 1 } }), 'history-sanitization'],
  ] as const) {
    await expect(fixture.read()).rejects.toBeInstanceOf(Error)
    expect(fixture.phases.at(-1)).toBe(phase)
    const receipts: unknown[] = []
    appendRetryCommandReceipt(receipts, { id: 1, op: 'history', label: 'B', ok: false, phase: fixture.phases.at(-1) })
    expect(receipts).toEqual([{ id: 1, op: 'history', label: 'B', ok: false, phase }])
    expect(JSON.stringify(receipts).includes('private')).toBe(false)
  }
})
// These fixtures qualify diagnostic privacy/shape only; they do not reproduce native I3.
const ownedRetryParent = '/owned/project/tests/integration/mail-retry-native.test.ts'
function stackFailure(stack: unknown): Error {
  const error = new Error('private-message-token')
  Object.defineProperty(error, 'stack', { value: stack, configurable: true })
  return error
}
test('parent failure frames expose only numeric coordinates for the exact owned parent path', () => {
  const result = parentFailureFrames(stackFailure(`Error: private-message-token
    at requireFact (${ownedRetryParent}:159:65)
    at async history (file://${ownedRetryParent}:288:9)
    at ${ownedRetryParent}:331:8
    at foreign (/foreign/project/tests/integration/mail-retry-native.test.ts:123:4)
    at foreign (/owned/project/tests/helpers/mail-retry-observation.ts:1:2)
    at remote (https://private.example${ownedRetryParent}:3:4)`), ownedRetryParent)
  expect(result).toEqual([{ line: 159, column: 65 }, { line: 288, column: 9 }, { line: 331, column: 8 }])
  expect(JSON.stringify(result)).not.toMatch(/private|owned|foreign|https|Error|stack|message|token/)
})
test('parent failure frames support exact Windows paths without disclosing a drive or file URL', () => {
  const owned = 'C:\\owned\\project\\tests\\integration\\mail-retry-native.test.ts'
  expect(parentFailureFrames(stackFailure(`Error: private
    at body (${owned}:285:17)
    at async body (file:///C:/owned/project/tests/integration/mail-retry-native.test.ts:287:5)`), owned)).toEqual([
    { line: 285, column: 17 }, { line: 287, column: 5 },
  ])
})
test('parent failure frames cap output at four and reject zero, fractional, negative and oversized coordinates', () => {
  const invalid = ['0:1', '1:0', '-1:1', '1:-1', '1.5:2', '1:2.5', '100001:1', '1:100001', '9999999999999999:1']
  const stack = ['Error: private', ...invalid.map(pair => `    at body (${ownedRetryParent}:${pair})`),
    ...[1, 2, 3, 100000, 5].map(line => `    at body (${ownedRetryParent}:${line}:100000)`)].join('\n')
  expect(parentFailureFrames(stackFailure(stack), ownedRetryParent)).toEqual([
    { line: 1, column: 100000 }, { line: 2, column: 100000 }, { line: 3, column: 100000 }, { line: 100000, column: 100000 },
  ])
})
test('parent failure frames reject oversized stack input and malformed or foreign frames without raw fallback', () => {
  const valid = `    at body (${ownedRetryParent}:159:65)`
  for (const input of [undefined, null, 'private', { stack: `Error: private\n${valid}` }, stackFailure(undefined), stackFailure(42),
    stackFailure('x'.repeat(16385)), stackFailure(`Error: private\n${'x'.repeat(16384)}\n${valid}`),
    stackFailure(`Error: private\n${ownedRetryParent}:1:2\n    not-at (${ownedRetryParent}:3:4)\n    at foreign (/foreign.ts:1:2)`),
    stackFailure(`Error: private\n    at body (${ownedRetryParent}.private:1:2)`),
  ]) expect(parentFailureFrames(input, ownedRetryParent)).toEqual([])
  expect(parentFailureFrames(stackFailure(`Error: private\n${valid}`), '/foreign.ts')).toEqual([])
})
test('parent failure projection never inspects error name, message or cause and safely contains a throwing stack getter', () => {
  const error = stackFailure(`Error: private\n    at body (${ownedRetryParent}:288:9)`)
  for (const key of ['name', 'message', 'cause']) Object.defineProperty(error, key, { get() { throw new Error('private-access') } })
  expect(parentFailureFrames(error, ownedRetryParent)).toEqual([{ line: 288, column: 9 }])
  const hostile = new Error()
  Object.defineProperty(hostile, 'stack', { get() { throw new Error('private-stack-access') } })
  expect(parentFailureFrames(hostile, ownedRetryParent)).toEqual([])
})
test('last completed command diagnostic reuses strict finite receipt validation and omits its ID', () => {
  expect(lastCommandFailure({ id: 17, op: 'history', label: 'E', ok: false, phase: 'identity-decoding' })).toEqual({ op: 'history', label: 'E', ok: false, phase: 'identity-decoding' })
  expect(lastCommandFailure({ id: 18, op: 'release', label: 'E', ok: true })).toEqual({ op: 'release', label: 'E', ok: true })
  expect(lastCommandFailure({ id: 19, op: 'admit', label: null, ok: true })).toEqual({ op: 'admit', label: null, ok: true })
})
test('last completed command diagnostic returns null for absent, malformed, extra or hostile input without raw fallback', () => {
  const valid = { id: 17, op: 'history', label: 'E', ok: false }
  const hostile = Object.defineProperty({}, 'id', { get() { throw new Error('private-access') } })
  for (const input of [undefined, null, 'private', hostile, { ...valid, id: 0 }, { ...valid, id: 'private-id' },
    { ...valid, op: 'private-op' }, { ...valid, label: 'private-label' }, { ...valid, ok: 'private' },
    { ...valid, phase: 'private-phase' }, { ...valid, ok: true, phase: 'identity-decoding' },
    { ...valid, op: 'release', phase: 'identity-decoding' }, { ...valid, value: 'private-value' }, { ...valid, error: 'private-error' },
  ]) expect(lastCommandFailure(input)).toBeNull()
})
