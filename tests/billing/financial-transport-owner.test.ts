import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createStripeBillingClient } from '../../src/modules/billing/stripe.server'
import { config } from '../helpers/billing-fixtures'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'

const clients: ReturnType<typeof createStripeBillingClient>[] = []
const peers: Awaited<ReturnType<typeof startStripeFinancialPeer>>[] = []
function refuseGlobalFetch() { return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Use the pinned undici fetch transport') }) }
let globalFetch: ReturnType<typeof refuseGlobalFetch>
beforeEach(() => { globalFetch = refuseGlobalFetch() })
function owned(signal: AbortSignal, deadlineAtMs = Date.now() + 10000) {
  const client = createStripeBillingClient(config, signal, deadlineAtMs)
  clients.push(client)
  return client
}
async function closeClient(client: ReturnType<typeof createStripeBillingClient>) {
  await client.close()
}
async function fixture(options?: Parameters<typeof startStripeFinancialPeer>[0]) {
  const peer = await startStripeFinancialPeer(options); peers.push(peer); return peer
}
const customer = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', idempotencyKey: 'customer:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
const checkout = { ...customer, customerId: 'cus_fixture', idempotencyKey: 'checkout:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  integrationIdentifier: 'template_ABCDEFGH', operationReference: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  terms: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', monthlyPriceId: 'price_negotiatedA', currency: 'eur', monthlyUnitAmount: 1500 } }
const outcome = <A>(promise: Promise<A>) => promise.then(value => ({ state: 'fulfilled' as const, value }), () => ({ state: 'rejected' as const }))

afterEach(async () => {
  const failures: unknown[] = []
  for (const client of clients.splice(0)) { try { await closeClient(client) } catch (error) { failures.push(error) } }
  for (const peer of peers.splice(0)) { try { await peer.close() } catch (error) { failures.push(error) } }
  try { expect(globalFetch).not.toHaveBeenCalled() } finally { globalFetch.mockRestore() }
  if (failures.length) throw new AggregateError(failures, 'Owned Stripe fixture teardown failed')
})

test('financial construction is inert; its first effect verifies the own key account before one native POST', async () => {
  const peer = await fixture(), client = owned(new AbortController().signal)
  expect(peer.requests()).toEqual([])
  const result = await outcome(client.createCustomer(customer))
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account', 'POST /v1/customers'])
  expect(result).toEqual({ state: 'fulfilled', value: { id: 'cus_fixture' } })
  expect(peer.requests()).toEqual([
    expect.objectContaining({ authorized: true, apiVersion: '2026-09-30.endive', accountHeader: false, contextHeader: false }),
    expect.objectContaining({ authorized: true, apiVersion: '2026-09-30.endive', accountHeader: false, contextHeader: false,
      idempotencyKey: 'customer:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  ])
  expect(new URLSearchParams(peer.requests()[1]!.body).get('metadata[workspace_id]')).toBe(customer.workspaceId)
  expect('close' in client && typeof client.close === 'function').toBe(true)
  await closeClient(client)
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})

test('a different own-key account refuses the effect without exposing Account data', async () => {
  const peer = await fixture()
  peer.setReply('/v1/account', { body: { id: 'acct_other', object: 'account', email: 'synthetic-private-account@example.invalid' } })
  const client = owned(new AbortController().signal)
  const result = await client.createCustomer(customer).then(() => ({ state: 'fulfilled' }), error => ({ state: 'rejected', message: String(error) }))
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account'])
  expect(result).toMatchObject({ state: 'rejected' })
  expect(JSON.stringify(result)).not.toContain('synthetic-private-account')
  await closeClient(client)
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})

test.each(['Price', 'Checkout', 'cancellation'] as const)('the native %s method verifies identity and retains its exact SDK request', async method => {
  const peer = await fixture(), client = owned(new AbortController().signal)
  const path = method === 'Price' ? '/v1/prices/price_negotiatedA' : method === 'Checkout' ? '/v1/checkout/sessions' : '/v1/subscriptions/sub_fixture'
  peer.setReply(path, { body: method === 'Price' ? { id: 'price_negotiatedA', object: 'price', livemode: false }
    : method === 'Checkout' ? { id: 'cs_test_fixture', object: 'checkout.session', mode: 'subscription', livemode: false,
      customer: 'cus_fixture', client_reference_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'open',
      url: 'https://checkout.stripe.com/c/pay/cs_test_fixture', expires_at: Math.floor(Date.now() / 1000) + 3600 }
      : { id: 'sub_fixture', object: 'subscription', customer: 'cus_fixture', customer_account: null, livemode: false, cancel_at_period_end: true } })
  const result = await outcome<unknown>(method === 'Price' ? client.retrievePrice('price_negotiatedA') : method === 'Checkout' ? client.createCheckout(checkout)
    : client.cancelSubscriptionAtPeriodEnd({ customerId: 'cus_fixture', subscriptionId: 'sub_fixture', idempotencyKey: 'cancel:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))
  expect(result.state).toBe('fulfilled')
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account', `${method === 'Price' ? 'GET' : 'POST'} ${path}`])
  const sent = peer.requests()[1]!, body = new URLSearchParams(sent.body)
  expect(sent.accountHeader || sent.contextHeader).toBe(false)
  if (method === 'Checkout') {
    expect(body.get('line_items[0][price]')).toBe('price_negotiatedA')
    expect(body.get('line_items[0][quantity]')).toBe('1')
    expect(body.get('currency')).toBe('eur')
    expect(body.get('client_reference_id')).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(sent.idempotencyKey).toBe('checkout:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  } else if (method === 'cancellation') {
    expect([...body]).toEqual([['cancel_at_period_end', 'true']])
    expect(sent.idempotencyKey).toBe('cancel:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  }
  await closeClient(client)
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})

test('an account redirect is refused without a financial effect or a followed destination', async () => {
  const peer = await fixture(), client = owned(new AbortController().signal)
  peer.setReply('/v1/account', { status: 302, location: 'https://example.invalid/private-destination' })
  expect(await outcome(client.createCustomer(customer))).toEqual({ state: 'rejected' })
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account'])
  await closeClient(client)
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})

test.each(['headers', 'body'] as const)('request abort during financial %s joins the SDK and sockets before close resolves', async hold => {
  const peer = await fixture(), controller = new AbortController(), client = owned(controller.signal)
  peer.setReply('/v1/customers', { hold })
  const pending = outcome(client.createCustomer(customer))
  try {
    await expect.poll(() => peer.requests().some(request => request.method === 'POST')).toBe(true)
    controller.abort()
    expect(await pending).toEqual({ state: 'rejected' })
    await closeClient(client)
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
    expect(peer.requests().filter(request => request.method === 'POST')).toHaveLength(1)
  } finally { controller.abort(); await pending; await closeClient(client) }
})

test('the absolute action deadline owns a held response body instead of renewing a stage timeout', async () => {
  const peer = await fixture(), client = owned(new AbortController().signal, Date.now() + 1500)
  peer.setReply('/v1/customers', { hold: 'body' })
  const started = performance.now(), result = await outcome(client.createCustomer(customer))
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account', 'POST /v1/customers'])
  expect(result).toEqual({ state: 'rejected' })
  expect(performance.now() - started).toBeLessThan(4000)
  await closeClient(client)
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
}, 10000)

test('abort during TLS acquisition joins the connector socket without any provider request', async () => {
  const peer = await fixture({ holdTls: true }), controller = new AbortController(), client = owned(controller.signal)
  const pending = outcome(client.createCustomer(customer))
  try {
    await expect.poll(() => peer.evidence().clientSockets).toBe(1)
    controller.abort()
    expect(await pending).toEqual({ state: 'rejected' })
    await closeClient(client)
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
    expect(peer.requests()).toEqual([])
  } finally { controller.abort(); await pending; await closeClient(client) }
})

test('closed connection after one POST remains unknown and never causes SDK retransmission', async () => {
  const peer = await fixture(), client = owned(new AbortController().signal)
  peer.setReply('/v1/customers', { closeBeforeHeaders: true })
  const result = await outcome(client.createCustomer(customer))
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account', 'POST /v1/customers'])
  expect(result).toEqual({ state: 'rejected' })
  await closeClient(client)
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})
