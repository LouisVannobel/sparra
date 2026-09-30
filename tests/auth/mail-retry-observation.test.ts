import { expect, test } from 'vitest'
import { Api } from '@hatchet-dev/typescript-sdk/clients/rest/generated/Api.js'
import { checkedRetryInterval, createRetryBarriers, expiryGate, retryBudget, safeRetryHistory, safeRetryOutcome, observeRetryHandler, safeRetryRunIdentity, safeRetryParentPhase, appendRetryCommandReceipt, readRetryHistory } from '../helpers/mail-retry-observation'

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
  const requests: unknown[] = [], phases: string[] = []
  const signals = [new AbortController().signal, new AbortController().signal]
  let observations = 0
  // Use the installed SDK's real request generation; only its network adapter is replaced.
  const client = { tenantId: identity.tenantId, api: new Api({ adapter: async config => {
    expect(config.signal).toBe(signals[requests.length])
    requests.push({ url: config.url, method: config.method, params: config.params,
      signal: config.signal, timeout: config.timeout, maxContentLength: config.maxContentLength })
    if (requests.length === failureAt) throw new Error('private-transport-error')
    return { status: 200, statusText: 'OK', headers: {}, config, data: requests.length === 1 ? runDetails : taskEvents }
  } }) }
  const observed: Parameters<typeof readRetryHistory>[2] = call => {
    const index = observations++
    return call(signals[index], [8123, 7123][index])
  }
  return { requests, phases, signals, read: (value: Parameters<typeof readRetryHistory>[1] = identity) =>
    readRetryHistory(client, value, observed, phase => { phases.push(phase) }) }
}
test('harness history uses the run ID for details and observed task ID for task events with owned request limits', async () => {
  const fixture = historyFixture()
  const result = await fixture.read()
  expect(fixture.requests).toEqual([
    { url: `/api/v1/stable/workflow-runs/${identity.runId}`, method: 'get', params: undefined, signal: fixture.signals[0], timeout: 8123, maxContentLength: 65536 },
    { url: `/api/v1/stable/tasks/${identity.taskId}/task-events`, method: 'get', params: { limit: 100 }, signal: fixture.signals[1], timeout: 7123, maxContentLength: 65536 },
  ])
  expect(result).toEqual({ status: 'CANCELLED', events: [{ id: 7, taskId: identity.taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, attempt: 1,
    code: 'AUTH_MAIL_CAPACITY_BUSY', unclassifiedError: false }] })
  expect(JSON.stringify(result).includes('private')).toBe(false)
})
test('harness history rejects a missing observed task ID before making a task-dependent request', async () => {
  const fixture = historyFixture()
  await expect(fixture.read({ runId: identity.runId })).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.phases.at(-1)).toBe('identity-decoding')
})
test('harness history preserves all run, task, workflow, tenant and single-task correlations', async () => {
  const task = published.tasks[0]
  for (const state of [
    { ...published, run: { ...published.run, metadata: { id: identity.taskId } } },
    { ...published, tasks: [{ ...task, taskExternalId: identity.runId }] },
    { ...published, tasks: [{ ...task, workflowRunExternalId: identity.taskId }] },
    { ...published, run: { ...published.run, tenantId: identity.runId } },
    { ...published, tasks: [{ ...task, tenantId: identity.runId }] },
    { ...published, tasks: [] }, { ...published, tasks: [task, task] },
  ]) {
    const fixture = historyFixture(state)
    await expect(fixture.read()).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
    expect(fixture.phases.at(-1)).toBe('identity-decoding')
  }
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
