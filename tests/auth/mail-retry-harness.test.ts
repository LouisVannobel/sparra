// Ordinary protocol/ownership tests of the real harness. Public SQL/SDK/provider
// boundaries are doubled; these cases do not qualify the native I3 process.
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import dns from 'node:dns'
import type { Serializable } from 'node:child_process'
import type { createAuthMailHandler } from '../../src/modules/auth/mail-worker.server'
import type { RetryLabel, retryCommandOperation } from '../helpers/mail-retry-observation'

type Context = { workflowRunId(): string; taskRunId(): string; retryCount(): number; abortController: AbortController }
type Middleware = { before(input: unknown, context: Context): Promise<void>; after(output: unknown, context: Context, input: unknown): Promise<void> }
type RequestOptions = { signal: AbortSignal; timeout: number; maxContentLength?: number }
type Command = { op: typeof retryCommandOperation.Type; label?: RetryLabel; outboxId?: string; runId?: string; hookId?: string; deadlineAtMs?: number }
type Native = {
  acquired: string[]; released: string[]; paths: string[]
  acquisition(): Promise<void>
  middleware: Middleware | undefined
  handler: ReturnType<typeof createAuthMailHandler> | undefined
  start: Mock<() => Promise<void>>; stop: Mock<() => Promise<void>>; ready: Mock<() => Promise<void>>
  close: Mock<() => Promise<void>>; handlerStop: Mock<() => Promise<void>>
  handle: Mock<ReturnType<typeof createAuthMailHandler>['handle']>
  relay: Mock<(store: unknown, task: unknown, signal: AbortSignal) => Promise<string>>
  cancel: Mock<(tenant: string, body: { externalIds: string[] }, options: RequestOptions) => Promise<void>>
  details: Mock<(runId: string, options: RequestOptions) => Promise<{ status: number; data: unknown }>>
  events: Mock<(taskId: string, query: { limit: number }, options: RequestOptions) => Promise<{ data: unknown }>>
  tenant: Mock<() => Promise<{ data: { version: string } }>>
  version: Mock<() => Promise<{ version: string }>>
}
const native = vi.hoisted((): Native => ({
  acquired: [], released: [], paths: [],
  acquisition: async () => {},
  middleware: undefined,
  handler: undefined,
  start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => Promise<void>>(), ready: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(), handlerStop: vi.fn<() => Promise<void>>(),
  handle: vi.fn<ReturnType<typeof createAuthMailHandler>['handle']>(),
  relay: vi.fn<(store: unknown, task: unknown, signal: AbortSignal) => Promise<string>>(),
  cancel: vi.fn<(tenant: string, body: { externalIds: string[] }, options: RequestOptions) => Promise<void>>(),
  details: vi.fn<(runId: string, options: RequestOptions) => Promise<{ status: number; data: unknown }>>(),
  events: vi.fn<(taskId: string, query: { limit: number }, options: RequestOptions) => Promise<{ data: unknown }>>(),
  tenant: vi.fn<() => Promise<{ data: { version: string } }>>(),
  version: vi.fn<() => Promise<{ version: string }>>(),
}))
vi.mock('node:dns', () => ({ default: { lookup: vi.fn((...args: unknown[]) => {
  const callback = args.at(-1)
  if (typeof callback === 'function') callback(null, '127.0.0.1', 4)
}) } }))
vi.mock('../../src/platform/db/resources.server', async () => {
  const { Effect } = await import('effect')
  return { acquireDatabase: (_config: unknown, login: string) => Effect.acquireRelease(
    Effect.promise(async () => { native.acquired.push(login); await native.acquisition(); return { transactions: { login } } }),
    () => Effect.sync(() => { native.released.push(login) }),
  ) }
})
vi.mock('../../src/modules/auth/mail-store.server', () => ({ createMailStore: (transactions: unknown) => transactions }))
vi.mock('../../src/modules/auth/mail-worker.server', () => ({ createAuthMailHandler: () => ({ handle: native.handle, stop: native.handlerStop }) }))
vi.mock('../../src/modules/auth/plunk.server', () => ({ createPlunkTransport: () => ({ close: native.close }) }))
vi.mock('../../src/modules/auth/mail-relay.server', () => ({ relayAuthMailOnce: native.relay }))
vi.mock('../../src/modules/auth/mail-hatchet.server', () => ({
  createAuthMailHatchet: (_config: unknown, path: string) => {
    native.paths.push(path)
    const client = { tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', config: { retrier: { maxAttempts: 1 } },
      api: { tenantGet: native.tenant, v1TaskCancel: native.cancel, v1WorkflowRunGet: native.details, v1TaskEventList: native.events },
      dispatcher: { client: { getVersion: native.version } },
      withMiddleware: (middleware: Middleware) => { native.middleware = middleware; return client },
      worker: async () => ({ start: native.start, stop: native.stop, waitUntilReady: native.ready }),
    }
    return client
  },
  createAuthMailTask: (_client: unknown, handler: ReturnType<typeof createAuthMailHandler>) => {
    native.handler = handler
    return { taskDef: { retries: 4, backoff: { factor: 5, maxSeconds: 30 }, executionTimeout: '30s', scheduleTimeout: '10m' } }
  },
}))

const outbox = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', run = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const tenant = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', taskId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const foreign = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const env = { NODE_ENV: 'test', APP_ORIGIN: 'https://sparra.example', DB_POOL_MAX: '2',
  HATCHET_CLIENT_TOKEN: 'synthetic', HATCHET_CLIENT_HOST_PORT: '127.0.0.1:1',
  HATCHET_CLIENT_API_URL: 'http://127.0.0.1:1', HATCHET_CLIENT_TLS_STRATEGY: 'none',
  AUTH_MAIL_KEY_ID: 'k', AUTH_MAIL_KEYS_JSON: JSON.stringify({ k: Buffer.alloc(32, 1).toString('base64') }),
  AUTH_MAIL_PROJECT_ID: 'p', AUTH_MAIL_CREDENTIAL_ID: 'c', AUTH_MAIL_API_ORIGIN: 'https://example.test', AUTH_MAIL_PLUNK_SECRET: 'sk_synthetic',
  AUTH_MAIL_RELAY_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/mail', AUTH_MAIL_WORKER_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/mail' }
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
class Parent extends EventEmitter {
  env = env
  connected = true
  exitCode: NodeJS.Process['exitCode']
  messages: Serializable[] = []
  send(message: Serializable, callback?: (error: Error | null) => void) { this.messages.push(message); callback?.(null); return true }
  disconnect() { this.connected = false }
  command(value: unknown) { this.emit('message', value) }
}
const owners: { parent: Parent; done: Promise<void> }[] = [], releases: (() => void)[] = []
let originalLookup: typeof dns.lookup
let main: typeof import('../helpers/mail-retry-harness')['main']
function launch(parent = new Parent()) {
  const done = main(parent)
  owners.push({ parent, done })
  return { parent, done }
}
async function ready(parent: Parent) { await vi.waitFor(() => expect(parent.messages).toContainEqual(expect.objectContaining({ type: 'ready' }))) }
async function reply(parent: Parent, id: number, command: Command) {
  parent.command({ id, ...command })
  await vi.waitFor(() => expect(parent.messages).toContainEqual(expect.objectContaining({ type: 'reply', id })))
  return parent.messages.find(value => typeof value === 'object' && value !== null && 'id' in value && value.id === id)
}
async function begun() {
  const owner = launch(); await ready(owner.parent)
  expect(await reply(owner.parent, 1, { op: 'begin', deadlineAtMs: Date.now() + 60000 })).toEqual({ type: 'reply', id: 1, op: 'begin', label: null, ok: true, value: true })
  return owner
}
function context(retryCount = 0, workflowRunId = run, id = taskId): Context {
  return { workflowRunId: () => workflowRunId, taskRunId: () => id, retryCount: () => retryCount, abortController: new AbortController() }
}
function middleware() { if (!native.middleware) throw new Error('Missing owned middleware'); return native.middleware }
beforeEach(async () => {
  vi.clearAllMocks()
  native.acquired.length = 0; native.released.length = 0; native.paths.length = 0
  native.middleware = undefined; native.handler = undefined; native.acquisition = async () => {}
  originalLookup = dns.lookup
  const started = deferred(); releases.push(started.resolve)
  native.start.mockImplementation(() => started.promise)
  native.stop.mockImplementation(async () => { started.resolve() })
  native.ready.mockResolvedValue(); native.close.mockResolvedValue(); native.handlerStop.mockResolvedValue()
  native.handle.mockResolvedValue({ state: 'deferred', reason: 'capacity_busy' })
  native.relay.mockResolvedValue('idle'); native.cancel.mockResolvedValue()
  native.tenant.mockResolvedValue({ data: { version: 'V1' } }); native.version.mockResolvedValue({ version: 'v0.101.27' })
  native.details.mockResolvedValue({ status: 200, data: { run: { metadata: { id: run }, tenantId: tenant, status: 'CANCELLED' },
    tasks: [{ taskExternalId: taskId, workflowRunExternalId: run, tenantId: tenant }] } })
  native.events.mockResolvedValue({ data: { rows: [{ id: 7, taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0,
    errorMessage: 'private-provider-error', output: 'private-output' }], pagination: {} } })
  const harness = await import('../helpers/mail-retry-harness')
  main = harness.main
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try {
    for (const owner of owners.splice(0)) { owner.parent.command({ id: 999, op: 'shutdown' }); await owner.done }
    expect(dns.lookup).toBe(originalLookup)
  } finally {
    Object.defineProperty(dns, 'lookup', { value: originalLookup, configurable: true, writable: true })
    vi.restoreAllMocks(); vi.useRealTimers()
  }
})

test('import is inert and only the owned parent starts and stops resources, preserving a foreign listener', async () => {
  // An auto-start at import, or removing all parent listeners, breaks ownership.
  expect(native.acquired).toEqual([]); expect(native.paths).toEqual([])
  const parent = new Parent(), foreignListener = vi.fn(); parent.on('message', foreignListener)
  const owner = launch(parent); await ready(parent)
  expect(native.acquired).toEqual(['auth_mail_relay', 'auth_mail_worker'])
  expect(native.paths[0]).toMatch(/[\\/]tests[\\/]helpers[\\/]hatchet-empty\.yaml$/)
  parent.command({ id: 2, op: 'shutdown' }); await owner.done
  expect(parent.listeners('message')).toEqual([foreignListener]); expect(parent.connected).toBe(false)
  expect(native.released).toEqual(['auth_mail_worker', 'auth_mail_relay'])
  expect(parent.messages).toContainEqual({ type: 'stopped', nativeStartState: 'resolved', nativeStopState: 'resolved', pendingHooks: 0, commandsJoined: true })
})

test('unbegun malformed and expired commands cannot admit work or issue cancellation/history effects', async () => {
  const { parent } = launch(); await ready(parent)
  for (const [id, op] of [[1, 'admit'], [2, 'cancel-A'], [3, 'history']] as const) {
    expect(await reply(parent, id, { op, label: 'A' })).toEqual({ type: 'reply', id, op, label: 'A', ok: false })
  }
  parent.command({ id: 4, op: 'admit', secret: 'private-command' })
  expect(parent.messages).toContainEqual({ type: 'fatal' })
  await reply(parent, 5, { op: 'begin', deadlineAtMs: Date.now() - 1 })
  expect(await reply(parent, 6, { op: 'admit' })).toEqual({ type: 'reply', id: 6, op: 'admit', label: null, ok: false })
  expect(native.relay).not.toHaveBeenCalled(); expect(native.cancel).not.toHaveBeenCalled(); expect(native.details).not.toHaveBeenCalled()
  expect(JSON.stringify(parent.messages)).not.toContain('private')
})

test('configuration and binding retain their guards while admission uses its existing budget and exact signal', async () => {
  const { parent, done } = await begun()
  expect(await reply(parent, 2, { op: 'configure', label: 'A', outboxId: outbox })).toMatchObject({ ok: true })
  expect(await reply(parent, 3, { op: 'configure', label: 'A', outboxId: foreign })).toEqual({ type: 'reply', id: 3, op: 'configure', label: 'A', ok: false })
  expect(await reply(parent, 4, { op: 'bind', label: 'B', runId: run })).toMatchObject({ ok: false })
  expect(await reply(parent, 5, { op: 'bind', label: 'A', runId: run })).toMatchObject({ ok: true })
  expect(await reply(parent, 6, { op: 'bind', label: 'A', runId: foreign })).toMatchObject({ ok: false })
  expect(await reply(parent, 7, { op: 'admit' })).toEqual({ type: 'reply', id: 7, op: 'admit', label: null, ok: true, value: 'idle' })
  expect(native.relay).toHaveBeenCalledOnce()
  const signal = native.relay.mock.calls[0]![2]
  expect(native.relay.mock.calls[0]![0]).toEqual({ login: 'auth_mail_relay' }); expect(signal.aborted).toBe(false)
  parent.command({ op: 'shutdown' }); await done; expect(signal.aborted).toBe(true)
})

test('cancel-A requires its A binding, is one shot, and never exposes a provider rejection', async () => {
  const { parent } = await begun()
  await reply(parent, 2, { op: 'configure', label: 'A', outboxId: outbox })
  expect(await reply(parent, 3, { op: 'cancel-A', label: 'A' })).toMatchObject({ ok: false })
  await reply(parent, 4, { op: 'bind', label: 'A', runId: run })
  expect(await reply(parent, 5, { op: 'cancel-A', label: 'B' })).toMatchObject({ ok: false })
  native.cancel.mockRejectedValueOnce(new Error('private-provider-error'))
  expect(await reply(parent, 6, { op: 'cancel-A', label: 'A' })).toEqual({ type: 'reply', id: 6, op: 'cancel-A', label: 'A', ok: false })
  expect(await reply(parent, 7, { op: 'cancel-A', label: 'A' })).toMatchObject({ ok: false })
  expect(native.cancel).toHaveBeenCalledOnce()
  expect(native.cancel.mock.calls[0]).toEqual([tenant, { externalIds: [run] }, { signal: expect.any(AbortSignal), timeout: expect.any(Number) }])
  expect(JSON.stringify(parent.messages)).not.toContain('private')
})

test('real history keeps observed run/task correlation and sanitizes replies instead of returning provider payloads', async () => {
  const { parent } = await begun()
  await reply(parent, 2, { op: 'configure', label: 'A', outboxId: outbox })
  await middleware().before({ outboxId: outbox }, context())
  expect(await reply(parent, 3, { op: 'bind', label: 'A', runId: foreign })).toMatchObject({ ok: false })
  await reply(parent, 4, { op: 'bind', label: 'A', runId: run })
  await expect(middleware().before({ outboxId: outbox }, context(0, foreign))).rejects.toThrow('MAIL_RETRY_FIXTURE_REJECTED')
  expect(await reply(parent, 5, { op: 'history', label: 'A', deadlineAtMs: Date.now() + 10000 })).toEqual({ type: 'reply', id: 5, op: 'history', label: 'A', ok: true,
    value: { status: 'CANCELLED', events: [{ id: 7, taskId, timestamp: '2026-09-11T00:00:00Z', eventType: 'FAILED', retryCount: 0, attempt: null, code: null, unclassifiedError: true }] } })
  expect(native.details.mock.calls[0]).toEqual([run, { signal: expect.any(AbortSignal), timeout: expect.any(Number), maxContentLength: 65536 }])
  expect(native.events.mock.calls[0]).toEqual([taskId, { limit: 100 }, { signal: expect.any(AbortSignal), timeout: expect.any(Number), maxContentLength: 65536 }])
  await middleware().after({ state: 'held' }, context(), { outboxId: outbox })
  expect(parent.messages).toContainEqual({ type: 'outcome', label: 'A', runId: run, taskId, retryCount: 0, outcome: { state: 'held' } })
  await native.handler!.handle({ outboxId: outbox }, new AbortController().signal)
  expect(parent.messages).toContainEqual({ type: 'handler-settled', label: 'A', state: 'deferred', reason: 'capacity_busy' })
  expect(JSON.stringify(parent.messages)).not.toContain('private')
})

test('gated middleware and the retained DNS callback release only on their own commands or shutdown', async () => {
  const { parent, done } = await begun()
  await reply(parent, 2, { op: 'configure', label: 'A', outboxId: outbox })
  const lookup = vi.fn(); dns.lookup('example.test', lookup)
  expect(lookup).not.toHaveBeenCalled(); expect(parent.messages).toContainEqual({ type: 'lookup-held', label: 'A' })
  await reply(parent, 3, { op: 'release-lookup' }); expect(lookup).toHaveBeenCalledExactlyOnceWith(null, '127.0.0.1', 4)
  await reply(parent, 4, { op: 'release-lookup' }); expect(lookup).toHaveBeenCalledOnce()
  await reply(parent, 5, { op: 'configure', label: 'D', outboxId: foreign })
  const ctx = context(), hook = middleware().before({ outboxId: foreign }, ctx)
  let settled = false; void hook.then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  expect(await reply(parent, 6, { op: 'release', hookId: 'foreign-hook' })).toMatchObject({ ok: false })
  await reply(parent, 7, { op: 'release', hookId: `D:${taskId}:0` }); await hook; expect(settled).toBe(true)
  const pending = middleware().before({ outboxId: foreign }, ctx)
  parent.command({ op: 'shutdown' }); await pending; await done
  expect(ctx.abortController.signal.aborted).toBe(true)
})

test('shutdown during acquisition joins the acquired resource before final cleanup and prevents later startup', async () => {
  const acquired = deferred(); releases.push(acquired.resolve); native.acquisition = () => acquired.promise
  const { parent, done } = launch()
  await vi.waitFor(() => expect(native.acquired).toEqual(['auth_mail_relay']))
  parent.command({ op: 'shutdown' })
  let finished = false; void done.then(() => { finished = true })
  await Promise.resolve(); expect(finished).toBe(false); expect(native.released).toEqual([])
  acquired.resolve(); await done
  expect(native.acquired).toEqual(['auth_mail_relay']); expect(native.released).toEqual(['auth_mail_relay'])
  expect(native.paths).toEqual([]); expect(parent.exitCode).toBe(1)
})

test('shutdown aborts an owned history request and joins it without sending a late success or releasing stores early', async () => {
  const { parent, done } = await begun()
  await reply(parent, 2, { op: 'configure', label: 'A', outboxId: outbox })
  await middleware().before({ outboxId: outbox }, context()); await reply(parent, 3, { op: 'bind', label: 'A', runId: run })
  const pending = deferred(); releases.push(pending.resolve)
  const response = { status: 200, data: { run: { metadata: { id: run }, tenantId: tenant, status: 'CANCELLED' }, tasks: [{ taskExternalId: taskId, workflowRunExternalId: run, tenantId: tenant }] } }
  native.details.mockImplementationOnce(async () => { await pending.promise; return response })
  parent.command({ id: 4, op: 'history', label: 'A', deadlineAtMs: Date.now() + 10000 })
  await vi.waitFor(() => expect(native.details).toHaveBeenCalledOnce())
  const signal = native.details.mock.calls[0]![1].signal
  parent.command({ op: 'shutdown' }); expect(signal.aborted).toBe(true)
  expect(await reply(parent, 5, { op: 'admit' })).toEqual({ type: 'reply', id: 5, op: 'admit', label: null, ok: false })
  expect(native.relay).not.toHaveBeenCalled()
  await Promise.resolve(); expect(native.released).toEqual([]); expect(native.close).not.toHaveBeenCalled()
  pending.resolve(); await done
  expect(parent.messages).toContainEqual({ type: 'reply', id: 4, op: 'history', label: 'A', ok: false, phase: 'run-details-aborted-after' })
  expect(native.events).not.toHaveBeenCalled(); expect(native.released).toHaveLength(2)
})

test('native start and stop rejections preserve failure status through shutdown', async () => {
  const failed = deferred(); releases.push(failed.resolve); native.start.mockImplementation(() => failed.promise)
  const { parent, done } = launch(); await ready(parent)
  failed.reject(new Error('private-native-start'))
  await vi.waitFor(() => expect(parent.messages).toContainEqual({ type: 'fatal' }))
  native.stop.mockRejectedValueOnce(new Error('private-native-stop'))
  parent.command({ op: 'shutdown' }); await done
  expect(parent.exitCode).toBe(1)
  expect(parent.messages).toContainEqual({ type: 'stopped', nativeStartState: 'rejected', nativeStopState: 'rejected', pendingHooks: 0, commandsJoined: true })
  expect(JSON.stringify(parent.messages)).not.toContain('private')
})
