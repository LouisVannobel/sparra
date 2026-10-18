import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import Stripe from 'stripe'
import { Redacted } from 'effect'
import { expect, test } from 'vitest'
import { readStripeWebhook } from '../../src/modules/billing/webhook-body.server'
import { StripeWebhookError } from '../../src/modules/billing/stripe-webhook.server'
import { config } from '../helpers/billing-fixtures'

function payload() {
  return JSON.stringify({ id: 'evt_fixture', object: 'event', api_version: config.apiVersion,
    created: Math.floor(Date.now() / 1000), livemode: false, type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_fixture', object: 'checkout.session', customer: 'cus_fixture',
      subscription: 'sub_fixture', payment_intent: null } } })
}
function nativeRequest(raw = payload()) {
  const socket = new Socket(), incoming = new IncomingMessage(socket)
  incoming.method = 'POST'; incoming.complete = true
  const outgoing = new ServerResponse(incoming)
  outgoing.assignSocket(socket)
  incoming.push(Buffer.from(raw)); incoming.push(null)
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw,
    secret: Redacted.value(config.webhookSecret), timestamp: Math.floor(Date.now() / 1000) })
  const request = new Request('https://sparra.example/billing/webhook', {
    method: 'POST', headers: { 'Stripe-Signature': signature } })
  Object.assign(request, { runtime: { name: 'node', node: { req: incoming, res: outgoing } } })
  return { request, incoming, outgoing, socket }
}

test('accepts only the signed bytes from the owned IncomingMessage stream', async () => {
  const fixture = nativeRequest()
  try {
    await expect(readStripeWebhook(config, fixture.request, Date.now() + 10000)).resolves.toMatchObject({
      id: 'evt_fixture', objectId: 'cs_test_fixture', references: { customerId: 'cus_fixture', subscriptionId: 'sub_fixture' } })
    expect(fixture.request.bodyUsed).toBe(false)
  } finally { fixture.incoming.destroy(); fixture.socket.destroy() }
})

test.each(['plain', 'forged'] as const)('leaves the caller-owned WebStream untouched for a %s transport', async kind => {
  let reads = 0, cancellations = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(Buffer.from(payload())); controller.close() },
    cancel() { cancellations++ },
  }, { highWaterMark: 0 })
  const init = { method: 'POST', body, duplex: 'half' }
  const request = new Request('https://sparra.example/billing/webhook', init)
  if (kind === 'forged') Object.assign(request, { runtime: { name: 'node', node: { req: {}, res: {} } } })
  await expect(readStripeWebhook(config, request, Date.now() + 10000)).rejects.toThrow(StripeWebhookError)
  expect(request.bodyUsed).toBe(false)
  expect(request.body?.locked).toBe(false)
  expect(reads).toBe(0)
  expect(cancellations).toBe(0)
})

test.each(['request identity', 'socket identity', 'runtime name'] as const)(
  'refuses mismatched %s before destroying any unowned native transport', async kind => {
    const fixture = nativeRequest(), other = nativeRequest()
    if (kind === 'request identity') Object.assign(fixture.request, {
      runtime: { name: 'node', node: { req: fixture.incoming, res: other.outgoing } } })
    if (kind === 'socket identity') {
      fixture.outgoing.detachSocket(fixture.socket); other.outgoing.detachSocket(other.socket)
      fixture.outgoing.assignSocket(other.socket)
    }
    if (kind === 'runtime name') Object.assign(fixture.request, {
      runtime: { name: 'other', node: { req: fixture.incoming, res: fixture.outgoing } } })
    try {
      await expect(readStripeWebhook(config, fixture.request, Date.now() + 10000)).rejects.toThrow(StripeWebhookError)
      expect(fixture.incoming.destroyed).toBe(false)
      expect(fixture.socket.destroyed).toBe(false)
      expect(other.socket.destroyed).toBe(false)
    } finally { fixture.incoming.destroy(); fixture.socket.destroy(); other.incoming.destroy(); other.socket.destroy() }
  })

test.each(['oversize body', 'wrong method', 'expired deadline', 'bad signature'] as const)(
  'closes the positively owned native transport after %s', async kind => {
    const fixture = nativeRequest(kind === 'oversize body' ? 'x'.repeat(256 * 1024 + 1) : payload())
    if (kind === 'wrong method') fixture.incoming.method = 'GET'
    if (kind === 'bad signature') fixture.request.headers.set('Stripe-Signature', 'invalid')
    await expect(readStripeWebhook(config, fixture.request, kind === 'expired deadline' ? Date.now() - 1 : Date.now() + 10000))
      .rejects.toThrow(StripeWebhookError)
    expect(fixture.incoming.closed).toBe(true)
    expect(fixture.socket.closed).toBe(true)
  })
