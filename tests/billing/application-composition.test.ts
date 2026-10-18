import { afterEach, expect, test, vi } from 'vitest'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationBilling } from '../../src/modules/billing/billing.server'
import { config, workspaceId, customer, termsA, monthlyPrice } from '../helpers/billing-fixtures'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import type { BillingWorkspaceLease } from '../../src/platform/db/auth-pg-lease.server'
import { billingCustomer } from '../../src/modules/billing/schema.server'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'

type Observation = { events: string[]; signals: AbortSignal[]; deadlines: number[]; mode: 'success' | 'held' | 'no-agreement' | 'concurrent';
  releaseClose?: () => void; holdClose: boolean; closeFailure: boolean }
const observed = vi.hoisted((): Observation => ({ events: [], signals: [], deadlines: [],
  mode: 'success', holdClose: false, closeFailure: false }))

vi.mock('../../src/modules/billing/stripe.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/billing/stripe.server')>()
  return { ...actual, createStripeBillingClient: (config: Parameters<typeof actual.createStripeBillingClient>[0], signal: AbortSignal, deadline: number) => {
    const index = observed.signals.length
    const native = observed.mode === 'concurrent' ? actual.createStripeBillingClient(config, signal, deadline) : undefined
    observed.events.push('client-created'); observed.signals.push(signal); observed.deadlines.push(deadline)
    return { ...native, close: async () => {
      observed.events.push('close-entered')
      if (observed.holdClose && (observed.mode !== 'concurrent' || index === 0)) await new Promise<void>(resolve => { observed.releaseClose = resolve })
      await native?.close()
      if (observed.closeFailure && (observed.mode !== 'concurrent' || index === 0)) throw new Error('synthetic-private-cleanup')
      observed.events.push('close-joined')
    } }
  } }
})
vi.mock('../../src/modules/billing/checkout.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/billing/checkout.server')>()
  return { ...actual, startCheckout: async (...args: Parameters<typeof actual.startCheckout>) => {
    const [,,,, selected, signal] = args
    if (!signal) throw new Error('Composition fixture requires its action signal')
    if (selected !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') throw new Response('Rejected', { status: 400 })
    if (observed.mode === 'no-agreement') throw new Response('Billing unavailable', { status: 503 })
    observed.events.push('action-entered')
    if (observed.mode === 'concurrent' && observed.signals.indexOf(signal) > 0) return actual.startCheckout(...args)
    if (observed.mode === 'held') {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
      observed.events.push('action-aborted')
      throw new Response('Billing unavailable', { status: 503 })
    }
    return { url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' }
  } }
})

const services: ReturnType<typeof createApplicationBilling>[] = []
function service(owner = createTransactions({ async connect() { throw new Error('Composition fixture must not open SQL') } },
  { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })) {
  const auth = { async requirePrincipal() { return { userId: 'fixture-user', sessionId: 'fixture-session', name: 'Fixture', email: 'fixture@example.test' } } }
  const billing = createApplicationBilling(owner, auth, config)
  services.push(billing); return billing
}
function request(signal = new AbortController().signal, deadline = Date.now() + 10000) {
  const value = new Request('https://sparra.example/billing', { method: 'POST', headers: { origin: 'https://sparra.example' }, signal })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: deadline })
  return value
}
async function stop(billing: ReturnType<typeof createApplicationBilling>) {
  await billing.stop()
}
const result = <A>(promise: Promise<A>) => promise.then(value => ({ state: 'fulfilled' as const, value }),
  error => ({ state: 'rejected' as const, status: error instanceof Response ? error.status : null }))

afterEach(async () => {
  observed.releaseClose?.()
  for (const billing of services.splice(0)) { try { await stop(billing) } catch (error) { if (!observed.closeFailure) throw error } }
  observed.events.length = 0; observed.signals.length = 0; observed.deadlines.length = 0
  observed.mode = 'success'; observed.holdClose = false; observed.releaseClose = undefined; observed.closeFailure = false
})

test('the action does not fulfill until its own financial transport has joined close', async () => {
  const billing = service(); observed.holdClose = true
  let settled = false
  const pending = result(billing.startBillingCheckout(request(), { workspaceId })).then(value => { settled = true; return value })
  try {
    await expect.poll(() => observed.events.includes('close-entered')).toBe(true)
    expect(settled).toBe(false)
    observed.releaseClose?.()
    expect(await pending).toEqual({ state: 'fulfilled', value: { url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' } })
    expect(observed.events).toEqual(['client-created', 'action-entered', 'close-entered', 'close-joined'])
  } finally { observed.releaseClose?.(); await pending }
})

test('request cancellation reaches the action owner and joins close before returning unavailable', async () => {
  const billing = service(), controller = new AbortController(); observed.mode = 'held'
  const pending = result(billing.startBillingCheckout(request(controller.signal), { workspaceId }))
  try {
    await expect.poll(() => observed.events.includes('action-entered')).toBe(true)
    controller.abort()
    expect(await pending).toEqual({ state: 'rejected', status: 503 })
    expect(observed.signals[0]?.aborted).toBe(true)
    expect(observed.events).toEqual(['client-created', 'action-entered', 'action-aborted', 'close-entered', 'close-joined'])
  } finally { controller.abort(); await pending }
})

test('the existing absolute auth deadline bounds the action and is passed unchanged to its financial client', async () => {
  const billing = service(), deadline = Date.now() + 100; observed.mode = 'held'
  const pending = result(billing.startBillingCheckout(request(undefined, deadline), { workspaceId }))
  expect(await pending).toEqual({ state: 'rejected', status: 503 })
  expect(observed.deadlines).toEqual([deadline])
  expect(observed.signals[0]?.aborted).toBe(true)
  expect(observed.events.at(-1)).toBe('close-joined')
})

test('runtime stop aborts and joins the active financial action before it resolves', async () => {
  const billing = service(); observed.mode = 'held'
  const pending = result(billing.startBillingCheckout(request(), { workspaceId }))
  try {
    await expect.poll(() => observed.events.includes('action-entered')).toBe(true)
    await stop(billing)
    expect(await pending).toEqual({ state: 'rejected', status: 503 })
    expect(observed.events.at(-1)).toBe('close-joined')
    expect(await result(billing.startBillingCheckout(request(), { workspaceId }))).toEqual({ state: 'rejected', status: 503 })
    expect(observed.signals).toHaveLength(1)
  } finally { await stop(billing); await pending }
})

test('a failed financial close returns unavailable and remains latched for runtime stop', async () => {
  const billing = service(); observed.closeFailure = true
  expect(await result(billing.startBillingCheckout(request(), { workspaceId }))).toEqual({ state: 'rejected', status: 503 })
  expect(await result(billing.startBillingCheckout(request(), { workspaceId }))).toEqual({ state: 'rejected', status: 503 })
  expect(observed.signals).toHaveLength(1)
  await expect(stop(billing)).rejects.toThrow('Billing transport cleanup unproven')
})

test('an unknown close aborts an already owned sibling waiting for its real Checkout snapshot before another provider read', async () => {
  const peer = await startStripeFinancialPeer()
  peer.setReply('/v1/prices/price_negotiatedA', { body: monthlyPrice() })
  let releaseSnapshot!: () => void, snapshotEntered!: () => void
  const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
  const entered = new Promise<void>(resolve => { snapshotEntered = resolve })
  const db = drizzle(async query => {
    if (query.includes('from "billing_customer"')) {
      const columns = Object.values(getTableColumns(billingCustomer))
      return { rows: [columns.map(column => {
        const field = Object.entries(getTableColumns(billingCustomer)).find(([, selected]) => selected === column)?.[0]
        if (!field || !Object.hasOwn(customer, field)) throw new Error('Unknown fixture customer column')
        const value: unknown = Object.getOwnPropertyDescriptor(customer, field)?.value
        return value instanceof Date ? value.toISOString() : value
      })] }
    }
    if (query.includes('from "billing_operation"')) return { rows: [] }
    if (query.includes('clock_timestamp')) return { rows: [[1790812800]] }
    if (query.includes('from "billing_agreed_terms"')) return { rows: [[termsA.id, termsA.workspaceId, termsA.environment,
      termsA.accountId, termsA.revision, termsA.monthlyPriceId, termsA.currency, termsA.monthlyUnitAmount]] }
    if (query.includes('billing_admit_checkout_v3')) return { rows: [[null]] }
    throw new Error('Unexpected Checkout fixture query')
  })
  const owner = createTransactions({ async connect() { throw new Error('No database connection in the SQL boundary fixture') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const scoped = vi.spyOn(owner, 'withBillingWorkspacePromise').mockImplementation(async (_options, _principal, selected, use) => {
    if (selected !== workspaceId) throw new Error('Unexpected fixture Workspace')
    snapshotEntered()
    await snapshot
    // SAFETY: pg-proxy runs the real Drizzle SELECT builders; only their query
    // execution is doubled. Financial SQL authority has separate native suites.
    const lease = { db, workspaceId } as BillingWorkspaceLease
    return use(lease)
  })
  observed.mode = 'concurrent'; observed.holdClose = true; observed.closeFailure = true
  const billing = service(owner)
  const a = result(billing.startBillingCheckout(request(), { workspaceId }))
  let b: ReturnType<typeof a.then> | undefined
  try {
    await expect.poll(() => observed.events.includes('close-entered')).toBe(true)
    b = result(billing.startBillingCheckout(request(), { workspaceId }))
    await entered
    expect(observed.signals).toHaveLength(2)
    expect(peer.requests()).toEqual([])
    observed.releaseClose?.()
    expect(await a).toEqual({ state: 'rejected', status: 503 })
    releaseSnapshot()
    expect(await b).toEqual({ state: 'rejected', status: 503 })
    expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual([])
    expect(observed.signals[1]?.aborted).toBe(true)
    await expect(billing.stop()).rejects.toThrow('Billing transport cleanup unproven')
  } finally {
    observed.releaseClose?.(); releaseSnapshot()
    await Promise.allSettled([a, b])
    await billing.stop().catch(() => {})
    scoped.mockRestore()
    await peer.close()
  }
})

test('runtime stop cancels and joins the positively owned webhook body before fulfilling', async () => {
  const billing = service(), socket = new Socket(), incoming = new IncomingMessage(socket)
  incoming.method = 'POST'
  const outgoing = new ServerResponse(incoming); outgoing.assignSocket(socket)
  const request = new Request('https://sparra.example/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'fixture-pending-body' } })
  Object.assign(request, { runtime: { name: 'node', node: { req: incoming, res: outgoing } } })
  Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  const pending = billing.receiveBillingWebhook(request)
  try {
    await expect.poll(() => incoming.listenerCount('readable') > 0).toBe(true)
    await billing.stop()
    expect(incoming.closed).toBe(true)
    expect(socket.closed).toBe(true)
    expect((await pending).status).toBe(503)
  } finally { incoming.destroy(); socket.destroy(); await pending }
})
