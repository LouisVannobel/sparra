import { afterEach, expect, test } from 'vitest'
import { buildCheckoutParameters, createStripeBillingClient } from '../../src/modules/billing/stripe.server'
import { config } from '../helpers/billing-fixtures'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'

const clients: ReturnType<typeof createStripeBillingClient>[] = []
const peers: Awaited<ReturnType<typeof startStripeFinancialPeer>>[] = []
async function financialFixture() {
  const peer = await startStripeFinancialPeer(); peers.push(peer)
  const client = createStripeBillingClient(config, new AbortController().signal, Date.now() + 10000); clients.push(client)
  return { peer, client }
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const client of clients.splice(0)) await client.close().catch(error => { failures.push(error) })
  for (const peer of peers.splice(0)) await peer.close().catch(error => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, 'Stripe adapter rejection fixture did not retire')
})

const intent = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'cus_fixture',
  idempotencyKey: 'checkout:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', integrationIdentifier: 'template_ABCDEFGH',
  operationReference: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  terms: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', monthlyPriceId: 'price_negotiatedA', currency: 'eur', monthlyUnitAmount: 1500 } }

test('Checkout sends exactly its admitted Price, quantity one and explicit currency', () => {
  expect(buildCheckoutParameters(config, intent)).toEqual({ mode: 'subscription', ui_mode: 'hosted_page',
    customer: 'cus_fixture', client_reference_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    integration_identifier: 'template_ABCDEFGH', line_items: [{ price: 'price_negotiatedA', quantity: 1 }],
    currency: 'eur', subscription_data: { billing_mode: { type: 'flexible' } },
    success_url: 'https://sparra.example/billing?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://sparra.example/billing?checkout=cancelled' })
})
test.each([
  { ...intent.terms, monthlyPriceId: 'prod_wrong' }, { ...intent.terms, monthlyUnitAmount: 0 },
  { ...intent.terms, currency: 'EUR' }, { ...intent.terms, monthlyUnitAmount: Number.MAX_SAFE_INTEGER + 1 },
  { ...intent.terms, price_data: {} },
])('rejects malformed operation terms before constructing a provider request %#', terms => {
  expect(() => buildCheckoutParameters(config, { ...intent, terms })).toThrow()
})

test.each([
  { reason: 'another Customer', changes: { customer: 'cus_other' } },
  { reason: 'a foreign Checkout origin', changes: { url: 'https://checkout.stripe.com.evil.invalid/c/pay/cs_test_fixture' } },
])('the real Checkout adapter refuses $reason after exactly its admitted POST', async ({ changes }) => {
  const { peer, client } = await financialFixture()
  peer.setReply('/v1/checkout/sessions', { body: { id: 'cs_test_fixture', object: 'checkout.session', mode: 'subscription',
    livemode: false, customer: intent.customerId, client_reference_id: intent.operationReference, status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_test_fixture', expires_at: Math.floor(Date.now() / 1000) + 3600, ...changes } })
  await expect(client.createCheckout(intent)).rejects.toMatchObject({ name: 'StripeProviderError', message: 'Stripe provider outcome unknown' })
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account', 'POST /v1/checkout/sessions'])
  const sent = peer.requests()[1]!, body = new URLSearchParams(sent.body)
  expect(sent.idempotencyKey).toBe(intent.idempotencyKey)
  expect(body.get('client_reference_id')).toBe(intent.operationReference)
  expect(body.get('line_items[0][price]')).toBe(intent.terms.monthlyPriceId)
  expect(body.get('currency')).toBe(intent.terms.currency)
  await client.close()
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})

test('a malformed own Account response refuses Checkout before a Session POST', async () => {
  const { peer, client } = await financialFixture()
  peer.setReply('/v1/account', { body: { id: config.accountId, object: 'customer', email: 'synthetic-private-account@example.invalid' } })
  const error = await client.createCheckout(intent).then(() => null, failure => failure)
  expect(error).toMatchObject({ name: 'StripeProviderError', message: 'Stripe provider outcome unknown' })
  expect(String(error)).not.toContain('synthetic-private-account')
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account'])
  await client.close()
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})

test('invalid negotiated currency refuses Checkout before even verifying the provider Account', async () => {
  const { peer, client } = await financialFixture()
  await expect(client.createCheckout({ ...intent, terms: { ...intent.terms, currency: 'EUR' } })).rejects.toMatchObject({ name: 'StripeInputError' })
  expect(peer.requests()).toEqual([])
  await client.close()
  await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
})
