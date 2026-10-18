// Handler closure semantics; actual transport evidence remains in the TLS peer tests.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createBillingHandler } from '../../src/modules/billing/worker.server'
import type { BillingClaim, BillingStore } from '../../src/modules/billing/store.server'
import { checkoutOperation, config, customer, termsA, workspaceId } from '../helpers/billing-fixtures'

const wire = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  created: 0,
  reads: 0,
}))
vi.mock('../../src/modules/billing/stripe-read.server', () => ({
  createStripeReadClient: () => {
    wire.created++
    return { close: wire.close }
  },
}))
vi.mock('../../src/modules/billing/lineage.server', () => ({
  resolveBillingEventInvoices: async () => {
    wire.reads++
    throw new Error('Synthetic business read unavailable')
  },
  proveBillingLineage: async () => { throw new Error('Unexpected lineage call') },
}))

const input = { outboxId: 'abababab-abab-4bab-8bab-abababababab', tenantId: workspaceId }
function claim(): BillingClaim {
  return {
    input, commandCompleted: false, fence: 1, deadlineAtMs: Date.now() + 30000,
    event: {
      id: 'evt_cleanup', type: 'invoice.paid', created: 1790812900,
      objectId: 'in_cleanup', objectType: 'invoice', projectionVersion: 1,
      environment: config.environment, accountId: config.accountId,
      references: { customerId: customer.stripeCustomerId, subscriptionId: null,
        paymentIntentId: null, chargeId: null, riskId: null },
    },
    operation: { ...checkoutOperation, apiVersion: config.apiVersion }, agreedTerms: termsA, customer,
    knownInvoiceIds: [], manifestRevision: 0, targetProgress: [],
  }
}
function store() {
  return {
    receive: vi.fn<BillingStore['receive']>().mockRejectedValue(new Error('Unexpected receive')),
    claimAdmission: vi.fn<BillingStore['claimAdmission']>().mockRejectedValue(new Error('Unexpected admission')),
    finalizeAdmission: vi.fn<BillingStore['finalizeAdmission']>().mockRejectedValue(new Error('Unexpected admission settlement')),
    claim: vi.fn<BillingStore['claim']>().mockImplementation(async () => claim()),
    observe: vi.fn<BillingStore['observe']>().mockRejectedValue(new Error('Unexpected observe')),
    apply: vi.fn<BillingStore['apply']>().mockRejectedValue(new Error('Unexpected apply')),
    recordRisk: vi.fn<BillingStore['recordRisk']>().mockRejectedValue(new Error('Unexpected risk')),
  } satisfies BillingStore
}
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type Handler = ReturnType<typeof createBillingHandler>
const handlers: Handler[] = []
const expectedUnsafe = new Set<Handler>()
const releaseHeld: Array<() => void> = []
function handler(owner: BillingStore) {
  const value = createBillingHandler(config, owner)
  handlers.push(value)
  return value
}
beforeEach(() => {
  wire.created = 0; wire.reads = 0
  wire.close.mockReset().mockResolvedValue()
})
afterEach(async () => {
  for (const release of releaseHeld.splice(0)) release()
  for (const value of handlers.splice(0)) {
    try { await value.stop() } catch (error) { if (!expectedUnsafe.has(value)) throw error }
  }
  expectedUnsafe.clear()
})

test('worker preserves a rejected read-client close after deferred business result and refuses another effect', async () => {
  const failure = new Error('Synthetic private close failure')
  wire.close.mockRejectedValue(failure)
  const owner = store(), value = handler(owner)
  expect(await value.handle(input, new AbortController().signal)).toEqual({ state: 'deferred', commandCompleted: false })
  expect(owner.claim).toHaveBeenCalledTimes(1)
  expect(wire.created).toBe(1)
  expect(wire.close).toHaveBeenCalledTimes(1)

  // This must precede stop(): a failed previous close itself bars new work.
  expect(await value.handle(input, new AbortController().signal)).toEqual({ state: 'deferred', commandCompleted: false })
  expect(owner.claim).toHaveBeenCalledTimes(1)
  expect(wire.created).toBe(1)
  expect(wire.reads).toBe(1)
  expectedUnsafe.add(value)
  await expect(value.stop()).rejects.toBeDefined()
  await expect(value.stop()).rejects.toBeDefined()
})

test('worker stop waits for the original held close and exposes its eventual rejection', async () => {
  const entered = barrier(), closing = barrier()
  releaseHeld.push(closing.resolve)
  wire.close.mockImplementation(async () => {
    entered.resolve()
    await closing.promise
    throw new Error('Synthetic close failed after stop')
  })
  const owner = store(), value = handler(owner)
  const pending = value.handle(input, new AbortController().signal)
  await entered.promise
  let stopped = false
  const stopping = value.stop().then(() => ({ status: 'fulfilled' as const }), () => ({ status: 'rejected' as const }))
    .then(result => { stopped = true; return result })
  await Promise.resolve()
  expect(stopped).toBe(false)
  closing.resolve()
  expect(await pending).toEqual({ state: 'deferred', commandCompleted: false })
  expectedUnsafe.add(value)
  expect(await stopping).toEqual({ status: 'rejected' })
  expect(owner.claim).toHaveBeenCalledTimes(1)
})

test('ordinary read failure with a successful close remains deferred and permits safe worker shutdown', async () => {
  const owner = store(), value = handler(owner)
  expect(await value.handle(input, new AbortController().signal)).toEqual({ state: 'deferred', commandCompleted: false })
  expect(wire.close).toHaveBeenCalledTimes(1)
  await expect(value.stop()).resolves.toBeUndefined()
  expect(owner.observe).not.toHaveBeenCalled()
  expect(owner.apply).not.toHaveBeenCalled()
  expect(owner.recordRisk).not.toHaveBeenCalled()
})
