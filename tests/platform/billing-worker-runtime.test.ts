// Runtime ordering/config tests only. Mocks stand at the existing SQL, SDK and
// provider boundaries; they are not native transport or engine qualification.
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest'
import { Effect } from 'effect'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createMailWorkerResources } from '../../src/platform/mail-runtime.server'
import type { relayBillingOnce } from '../../src/modules/billing/billing-relay.server'
import type { stopBillingRelay } from '../../src/modules/billing/billing-hatchet.server'

type OwnedOptions = Readonly<{ startup: { signal: AbortSignal; deadlineAt: number }; lifetimeSignal: AbortSignal; cleanupTimeoutMs: number }>
type NativeWorker = { start(): Promise<void>; stop(): Promise<void>; waitUntilReady(timeout: number): Promise<void> }
type WorkflowOptions = { workflows: readonly unknown[]; slots: number; handleKill: boolean }
type RuntimeObservation = {
  start: Mock<() => Promise<void>>; stop: Mock<() => Promise<void>>; ready: Mock<(timeout: number) => Promise<void>>;
  dispose: Mock<() => Promise<void>>; acquire: Mock<(name: string, options: WorkflowOptions) => Promise<NativeWorker>>;
  relay: Mock<typeof relayBillingOnce>; stopRelay: Mock<typeof stopBillingRelay>;
  ownerSignal: AbortSignal | undefined; lifecycle: OwnedOptions | undefined;
  pools: Array<{ login: string; max: number }>; released: string[];
  constructed: number; mailProviders: number; billingHandlers: number; mailTask: { kind: string }; billingTask: { kind: string };
}
const native = vi.hoisted((): RuntimeObservation => ({
  start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => Promise<void>>(), ready: vi.fn<(timeout: number) => Promise<void>>(),
  dispose: vi.fn<() => Promise<void>>(), acquire: vi.fn<(name: string, options: WorkflowOptions) => Promise<NativeWorker>>(),
  relay: vi.fn<typeof relayBillingOnce>(), stopRelay: vi.fn<typeof stopBillingRelay>(),
  ownerSignal: undefined,
  lifecycle: undefined,
  pools: [], released: [],
  constructed: 0, mailProviders: 0, billingHandlers: 0,
  mailTask: Object.freeze({ kind: 'auth-email-delivery' }), billingTask: Object.freeze({ kind: 'billing-reconciliation' }),
}))
vi.mock('../../src/modules/auth/mail-hatchet.server', () => ({
  createAuthMailHatchet: (_: unknown, __: string, owner: AbortSignal | OwnedOptions) => {
    native.constructed++
    native.ownerSignal = owner instanceof AbortSignal ? owner : owner.lifetimeSignal
    native.lifecycle = owner instanceof AbortSignal ? undefined : owner
    return {
      tenant: { get: async () => ({ version: 'V1' }) }, dispatcher: { getVersion: async () => 'v0.101.27' },
      getStartupInfo: async () => ({ tenantVersion: 'V1', engineVersion: 'v0.101.27' }),
      dispose: native.dispose, worker: native.acquire,
    }
  },
  createAuthMailTask: () => native.mailTask,
}))
vi.mock('../../src/platform/db/resources.server', () => ({
  acquireDatabase: (config: { max: number }, login: string) => Effect.acquireRelease(
    Effect.sync(() => {
      native.pools.push({ login, max: config.max })
      return {
        transactions: createTransactions({ async connect() { throw new Error('No SQL in runtime composition fixture') } },
          { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }),
        isReady: () => true, stop: () => { native.released.push(`${login}-stopped`) },
      }
    }),
    () => Effect.sync(() => { native.released.push(`${login}-released`) }),
  ),
}))
vi.mock('../../src/modules/auth/mail-store.server', () => ({ createMailStore: () => ({ purge: async () => {} }) }))
vi.mock('../../src/modules/auth/mail-relay.server', () => ({ relayAuthMailOnce: async () => {} }))
vi.mock('../../src/modules/auth/mail-worker.server', () => ({
  createAuthMailHandler: () => ({ handle: async () => ({ state: 'inert' }), stop: async () => {} }),
}))
vi.mock('../../src/modules/auth/plunk.server', () => ({
  createPlunkTransport: () => { native.mailProviders++; return { close: async () => {}, send: async () => { throw new Error('Unexpected mail effect') } } },
}))
vi.mock('../../src/modules/billing/store.server', () => ({ createBillingStore: () => ({}) }))
vi.mock('../../src/modules/billing/worker.server', () => ({
  createBillingHandler: () => { native.billingHandlers++; return { handle: async () => ({ state: 'deferred', commandCompleted: false }), stop: async () => {} } },
}))
vi.mock('../../src/modules/billing/billing-hatchet.server', () => ({
  createBillingTask: () => native.billingTask, stopBillingRelay: native.stopRelay,
}))
vi.mock('../../src/modules/billing/billing-relay.server', () => ({ relayBillingOnce: native.relay }))

const common = { NODE_ENV: 'test', APP_ORIGIN: 'https://sparra.example', DB_POOL_MAX: '2',
  HATCHET_CLIENT_TOKEN: 'synthetic', HATCHET_CLIENT_HOST_PORT: '127.0.0.1:1',
  HATCHET_CLIENT_API_URL: 'http://127.0.0.1:1', HATCHET_CLIENT_TLS_STRATEGY: 'none' }
const mail = { AUTH_MAIL_KEY_ID: 'k', AUTH_MAIL_KEYS_JSON: JSON.stringify({ k: Buffer.alloc(32, 1).toString('base64') }),
  AUTH_MAIL_PROJECT_ID: 'p', AUTH_MAIL_CREDENTIAL_ID: 'c', AUTH_MAIL_API_ORIGIN: 'https://example.test', AUTH_MAIL_PLUNK_SECRET: 'sk_synthetic',
  AUTH_MAIL_RELAY_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/mail', AUTH_MAIL_WORKER_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/mail' }
const billing = { STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox',
  BILLING_RELAY_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/billing', BILLING_WORKER_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/billing' }
type Resources = ReturnType<typeof createMailWorkerResources>
const resources: Resources[] = [], expectedUnsafe = new Set<Resources>(), releases: Array<() => void> = []
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function owned(env: Readonly<Record<string, string | undefined>>, events: string[] = []) {
  const value = createMailWorkerResources(env, 'unused', event => events.push(event))
  resources.push(value)
  return value
}
beforeEach(() => {
  native.pools.length = 0; native.released.length = 0
  native.constructed = 0; native.mailProviders = 0; native.billingHandlers = 0
  native.ownerSignal = undefined; native.lifecycle = undefined
  const started = barrier(); releases.push(started.resolve)
  native.start.mockReset().mockReturnValue(started.promise)
  native.ready.mockReset().mockResolvedValue()
  native.stop.mockReset().mockImplementation(async () => { started.resolve() })
  native.dispose.mockReset().mockImplementation(async () => { started.resolve() })
  native.acquire.mockReset().mockImplementation(async () => ({ start: native.start, stop: native.stop, waitUntilReady: native.ready }))
  native.relay.mockReset().mockResolvedValue('idle')
  native.stopRelay.mockReset().mockResolvedValue()
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const value of resources.splice(0)) {
    try { await value.dispose() } catch (error) { if (!expectedUnsafe.has(value)) throw error }
  }
  expectedUnsafe.clear()
})

test('billing-only runtime starts without mail credentials or provider construction and owns exactly two max1 logins', async () => {
  const value = owned({ ...common, ...billing })
  await value.ready()
  expect(native.acquire).toHaveBeenCalledWith('auth-email-worker', { workflows: [native.billingTask], slots: 1, handleKill: false })
  expect(native.pools).toEqual([{ login: 'billing_relay', max: 1 }, { login: 'billing_worker', max: 1 }])
  expect(native.mailProviders).toBe(0)
  expect(native.billingHandlers).toBe(1)
  await value.dispose()
})

test('combined runtime registers both tasks on the same worker within four max1 login pools', async () => {
  const value = owned({ ...common, ...mail, ...billing })
  await value.ready()
  expect(native.constructed).toBe(1)
  expect(native.acquire).toHaveBeenCalledTimes(1)
  expect(native.acquire).toHaveBeenCalledWith('auth-email-worker', { workflows: [native.mailTask, native.billingTask], slots: 1, handleKill: false })
  expect(native.pools).toEqual([
    { login: 'auth_mail_relay', max: 1 }, { login: 'auth_mail_worker', max: 1 },
    { login: 'billing_relay', max: 1 }, { login: 'billing_worker', max: 1 },
  ])
  await value.dispose()
})

test('partial Stripe is explicitly rejected while the existing complete mail capability remains usable', async () => {
  const events: string[] = [], value = owned({ ...common, ...mail, STRIPE_API_KEY: 'sk_test_fixture' }, events)
  await value.ready()
  expect(native.acquire).toHaveBeenCalledWith('auth-email-worker', { workflows: [native.mailTask], slots: 1, handleKill: false })
  expect(native.pools.map(pool => pool.login)).toEqual(['auth_mail_relay', 'auth_mail_worker'])
  expect(native.billingHandlers).toBe(0)
  expect(events).toContain('billing-config-rejected')
  await value.dispose()
})

test('partial mail is explicitly rejected while complete billing requires no invented mail binding', async () => {
  const events: string[] = [], value = owned({ ...common, ...billing, AUTH_MAIL_PROJECT_ID: 'partial' }, events)
  await value.ready()
  expect(native.acquire).toHaveBeenCalledWith('auth-email-worker', { workflows: [native.billingTask], slots: 1, handleKill: false })
  expect(native.mailProviders).toBe(0)
  expect(native.pools.map(pool => pool.login)).toEqual(['billing_relay', 'billing_worker'])
  expect(events).toContain('mail-config-rejected')
  await value.dispose()
})

test.each([{}, { STRIPE_API_KEY: 'sk_test_fixture' }, { AUTH_MAIL_PROJECT_ID: 'partial' }])('no valid capability refuses an empty worker before native or SQL acquisition %#', extra => {
  expect(() => owned({ ...common, ...extra })).toThrow()
  expect(native.constructed).toBe(0)
  expect(native.pools).toEqual([])
})

test('combined capabilities cannot expand the existing two-pool budget when DB_POOL_MAX is1', () => {
  expect(() => owned({ ...common, ...mail, ...billing, DB_POOL_MAX: '1' })).toThrow()
  expect(native.constructed).toBe(0)
  expect(native.pools).toEqual([])
})

test('rejected native stop is retained and never authorizes ordinary login-pool retirement', async () => {
  const value = owned({ ...common, ...mail })
  await value.ready()
  const settleStart = native.stop.getMockImplementation()
  native.stop.mockImplementation(async () => {
    await settleStart?.()
    throw new Error('Synthetic unsafe native stop')
  })
  expectedUnsafe.add(value)
  await expect(value.dispose()).rejects.toBeDefined()
  expect(value.hasFailed()).toBe(true)
  expect(native.released).toEqual([])
  await expect(value.dispose()).rejects.toBeDefined()
  expect(native.released).toEqual([])
})

test('rejected owned SDK disposal is retained even when native stop and handler joins fulfill', async () => {
  const value = owned({ ...common, ...mail })
  await value.ready()
  native.dispose.mockRejectedValue(new Error('Synthetic unsafe owned disposal'))
  expectedUnsafe.add(value)
  await expect(value.dispose()).rejects.toBeDefined()
  expect(value.hasFailed()).toBe(true)
  expect(native.released).toEqual([])
})

test('shutdown during held worker acquisition joins the late original before returning any SQL pools', async () => {
  const acquisition = barrier(), entered = barrier()
  releases.push(acquisition.resolve)
  native.acquire.mockImplementation(async () => {
    entered.resolve()
    await acquisition.promise
    return { start: native.start, stop: native.stop, waitUntilReady: native.ready }
  })
  const value = owned({ ...common, ...mail })
  const ready = value.ready().then(() => ({ state: 'ready' as const }), () => ({ state: 'rejected' as const }))
  await entered.promise
  let disposed = false
  const disposal = value.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(native.ownerSignal?.aborted).toBe(true)
  expect(native.released).toEqual([])
  expect(disposed).toBe(false)
  acquisition.resolve()
  await disposal
  expect(await ready).toEqual({ state: 'rejected' })
  expect(native.stop).toHaveBeenCalledTimes(1)
  expect(native.released).toContain('auth_mail_relay-released')
  expect(native.released).toContain('auth_mail_worker-released')
})

test('unproved relay REST closure stops admission immediately and joins current finalization without returning SQL', async () => {
  const entered = barrier(), finalization = barrier()
  releases.push(finalization.resolve)
  let markUnproven: (() => void) | undefined, relaySignal: AbortSignal | undefined, admissionClosed = false
  native.relay.mockImplementationOnce(async (_store, _task, signal, mark) => {
    markUnproven = mark; relaySignal = signal; entered.resolve()
    await finalization.promise
    return 'admission_unknown'
  })
  native.stopRelay.mockImplementation(async () => {
    admissionClosed = true
    throw new Error('Synthetic REST close remains unproven')
  })
  const value = owned({ ...common, ...billing }), ready = await value.ready()
  await entered.promise
  expectedUnsafe.add(value)
  try {
    if (!markUnproven) throw new Error('The real runtime did not supply a relay closure callback')
    markUnproven()
    expect(admissionClosed).toBe(true)
    expect(native.stopRelay).toHaveBeenCalledTimes(1)
    expect(native.lifecycle?.startup.signal.aborted).toBe(true)
    expect(native.ownerSignal?.aborted).toBe(true)
    expect(relaySignal?.aborted).toBe(true)
    expect(ready.isReady()).toBe(false)
    await ready.failure
    expect(value.hasFailed()).toBe(true)
    let disposed = false
    const disposal = value.dispose().then(() => { disposed = true; return 'fulfilled' }, () => { disposed = true; return 'rejected' })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(native.released).toEqual([])
    finalization.resolve()
    expect(await disposal).toBe('rejected')
    // The normal relay tick cannot claim or dispatch a second obligation.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(native.relay).toHaveBeenCalledTimes(1)
    await expect(value.dispose()).rejects.toBeDefined()
    expect(native.stopRelay).toHaveBeenCalledTimes(1)
    expect(native.released).toEqual([])
  } finally {
    finalization.resolve()
    await value.dispose().catch(() => {})
  }
})
