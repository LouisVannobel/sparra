import { afterEach, expect, test, vi } from 'vitest'
import { Effect } from 'effect'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createMailWorkerResources } from '../../src/platform/mail-runtime.server'

const native = vi.hoisted(() => ({ start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => Promise<void>>(), ready: vi.fn<() => Promise<void>>(), signal: undefined as AbortSignal | undefined, released: [] as string[] }))
vi.mock('../../src/modules/auth/mail-hatchet.server', () => ({
  createAuthMailHatchet: (_: unknown, __: string, signal: AbortSignal) => {
    native.signal = signal
    return { tenant: { get: async () => ({ version: 'V1' }) }, dispatcher: { getVersion: async () => 'v0.101.27' }, worker: async () => ({ start: native.start, stop: native.stop, waitUntilReady: native.ready }) }
  }, createAuthMailTask: () => ({}),
}))
vi.mock('../../src/platform/db/resources.server', () => ({ acquireDatabase: (_: unknown, login: string) => Effect.acquireRelease(
  Effect.sync(() => ({ transactions: createTransactions({ async connect() { throw new Error('No SQL in composition fixture') } }, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), isReady: () => true, stop: () => native.released.push(`${login}-stopped`) })),
  () => Effect.sync(() => { native.released.push(`${login}-released`) }),
) }))
vi.mock('../../src/modules/auth/mail-relay.server', () => ({ relayAuthMailOnce: async () => {} }))
vi.mock('../../src/modules/auth/mail-store.server', () => ({ createMailStore: () => ({ purge: async () => {} }) }))

function barrier() { let resolve!: () => void, reject!: (e: unknown) => void; const promise = new Promise<void>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const env = { NODE_ENV: 'test', AUTH_MAIL_KEY_ID: 'k', AUTH_MAIL_KEYS_JSON: JSON.stringify({ k: Buffer.alloc(32, 1).toString('base64') }), AUTH_MAIL_PROJECT_ID: 'p', AUTH_MAIL_CREDENTIAL_ID: 'c', AUTH_MAIL_API_ORIGIN: 'https://example.test', AUTH_MAIL_PLUNK_SECRET: 'sk_synthetic', HATCHET_CLIENT_TOKEN: 'synthetic', HATCHET_CLIENT_HOST_PORT: '127.0.0.1:1', HATCHET_CLIENT_API_URL: 'http://127.0.0.1:1', HATCHET_CLIENT_TLS_STRATEGY: 'none', AUTH_MAIL_RELAY_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/fixture', AUTH_MAIL_WORKER_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/fixture' }
afterEach(() => { vi.resetAllMocks(); native.released.length = 0; native.signal = undefined })

test.each(['resolved', 'cancelled', 'failed'] as const)('dispose latches cancellation before stop and retains native %s outcome through all joins', async outcome => {
  const started = barrier(), stopEntered = barrier(), stopReleased = barrier(), events: string[] = []
  native.start.mockReturnValue(started.promise); native.ready.mockResolvedValue()
  let cancelledBeforeStop = false
  native.stop.mockImplementation(async () => { cancelledBeforeStop = native.signal?.aborted === true; stopEntered.resolve(); await stopReleased.promise })
  const resources = createMailWorkerResources(env, 'unused', event => events.push(event))
  await resources.ready()
  const disposal = resources.dispose()
  try {
    await stopEntered.promise
    expect(cancelledBeforeStop).toBe(true)
    expect(native.released).toEqual([])
    if (outcome === 'resolved') started.resolve()
    else started.reject(outcome === 'cancelled' ? new DOMException('synthetic', 'AbortError') : new Error('synthetic upstream secret'))
    stopReleased.resolve(); await disposal
    expect(resources.hasFailed()).toBe(outcome === 'failed')
    expect(events).toContain(`native-start-${outcome}`)
    expect(events).toEqual(expect.arrayContaining(['native-start-completed', 'native-stop-completed', 'handlers-stopped', 'relay-stopped']))
    expect(native.released).toEqual(['auth_mail_relay-stopped', 'auth_mail_worker-stopped', 'auth_mail_worker-released', 'auth_mail_relay-released'])
  } finally { started.resolve(); stopReleased.resolve(); await disposal }
})

test('scope failure invokes native finalizer before ready catch calls exported dispose', async () => {
  const started = barrier(), events: string[] = []
  native.start.mockReturnValue(started.promise); native.ready.mockRejectedValue(new Error('synthetic readiness failure'))
  let cancelledBeforeStop = false
  native.stop.mockImplementation(async () => { cancelledBeforeStop = native.signal?.aborted === true; started.resolve() })
  const resources = createMailWorkerResources(env, 'unused', event => events.push(event))
  await expect(resources.ready()).rejects.toThrow('Auth mail worker unavailable')
  expect(cancelledBeforeStop).toBe(true)
  expect(events).toContain('native-start-resolved')
  expect(native.released).toContain('auth_mail_worker-released')
})

test.each(['AbortError', 'Error', 'resolved'] as const)('unexpected native %s before stop remains failure after disposal', async kind => {
  const started = barrier()
  native.start.mockReturnValue(started.promise); native.ready.mockResolvedValue(); native.stop.mockResolvedValue()
  const resources = createMailWorkerResources(env, 'unused')
  const ready = await resources.ready()
  if (kind === 'resolved') started.resolve()
  else { const error = new Error('synthetic'); error.name = kind; started.reject(error) }
  await ready.failure
  await resources.dispose()
  expect(resources.hasFailed()).toBe(true)
})
