import Stripe from 'stripe'
import { Redacted, type Schema } from 'effect'
import { afterEach, expect, test, vi } from 'vitest'
import { classifyBillingEvent } from '../../src/modules/billing/events.server'
import { createStripeReadClient } from '../../src/modules/billing/stripe-read.server'
import { StripeWebhookError, verifyStripeWebhook } from '../../src/modules/billing/stripe-webhook.server'
import { createBillingHandler } from '../../src/modules/billing/worker.server'
import type { BillingClaim, BillingStore, VerifiedRiskFacts } from '../../src/modules/billing/store.server'
import { config } from '../helpers/billing-fixtures'
import { billingWorkerClaim, billingWorkerInput, installBillingReadReplies } from '../helpers/billing-worker-fixture'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'
import * as provider from '../helpers/billing-provider-fixtures'

const nowMs = 1_800_000_000_000
const prefixes = ['dp', 'du'] as const
const dispute = (id: string) => ({ id, object: 'dispute', livemode: false, charge: 'ch_fixture123',
  payment_intent: 'pi_fixture123', currency: 'eur', status: 'needs_response' })
function signedDispute(id: string, type = 'charge.dispute.created', objectChanges: Schema.JsonObject = {}, changes: Schema.JsonObject = {}) {
  const payload = JSON.stringify({ id: 'evt_disputeNamespace', object: 'event', api_version: config.apiVersion,
    livemode: false, created: nowMs / 1000, type, data: { object: { ...dispute(id), ...objectChanges } }, ...changes })
  return { raw: Buffer.from(payload), signature: Stripe.webhooks.generateTestHeaderString({ payload,
    secret: Redacted.value(config.webhookSecret), timestamp: nowMs / 1000 }) }
}

test.each(prefixes)('signed %s Dispute projects its exact trigger references and classifies as risk', prefix => {
  for (const type of ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed']) {
    const signed = signedDispute(`${prefix}_fixture123`, type)
    const event = verifyStripeWebhook(config, signed.raw, signed.signature, nowMs)
    expect(event).toEqual({ id: 'evt_disputeNamespace', type, created: nowMs / 1000,
      objectId: `${prefix}_fixture123`, objectType: 'dispute', projectionVersion: 1,
      environment: 'sandbox', accountId: 'acct_fixture', references: { customerId: null,
        subscriptionId: null, paymentIntentId: 'pi_fixture123', chargeId: 'ch_fixture123', riskId: `${prefix}_fixture123` } })
    expect(classifyBillingEvent(event)).toEqual({ kind: 'dispute', id: `${prefix}_fixture123` })
  }
})

const rejectedSigned: ReadonlyArray<{ reason: string; id: string; object: Schema.JsonObject; envelope: Schema.JsonObject }> = [
  { reason: 'unknown namespace', id: 'dx_fixture123', object: {}, envelope: {} },
  { reason: 'wrong object', id: 'du_fixture123', object: { object: 'charge' }, envelope: {} },
  { reason: 'wrong object environment', id: 'du_fixture123', object: { livemode: true }, envelope: {} },
  { reason: 'missing Charge', id: 'du_fixture123', object: { charge: null }, envelope: {} },
  { reason: 'wrong PaymentIntent namespace', id: 'du_fixture123', object: { payment_intent: 'ch_fixture123' }, envelope: {} },
  { reason: 'wrong event environment', id: 'du_fixture123', object: {}, envelope: { livemode: true } },
  { reason: 'connected account', id: 'du_fixture123', object: {}, envelope: { account: 'acct_other' } },
]
test.each(rejectedSigned)('documented Dispute namespace retains signed webhook rejection for $reason', ({ id, object, envelope }) => {
  const signed = signedDispute(id, 'charge.dispute.created', object, envelope)
  expect(() => verifyStripeWebhook(config, signed.raw, signed.signature, nowMs)).toThrow(StripeWebhookError)
})

test('du Dispute still requires the exact signed raw bytes', () => {
  const signed = signedDispute('du_fixture123')
  expect(() => verifyStripeWebhook(config, Buffer.concat([Buffer.from(' '), signed.raw]), signed.signature, nowMs)).toThrow(StripeWebhookError)
})

const peers: Awaited<ReturnType<typeof startStripeFinancialPeer>>[] = []
const clients: ReturnType<typeof createStripeReadClient>[] = []
const handlers: ReturnType<typeof createBillingHandler>[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const handler of handlers.splice(0)) await handler.stop().catch(error => { failures.push(error) })
  for (const client of clients.splice(0)) await client.close().catch(error => { failures.push(error) })
  for (const peer of peers.splice(0)) {
    try {
      await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
      expect(peer.requests().every(request => request.method === 'GET' && request.authorized
        && request.apiVersion === config.apiVersion && !request.accountHeader && !request.contextHeader)).toBe(true)
    } catch (error) { failures.push(error) }
    await peer.close().catch(error => { failures.push(error) })
  }
  if (failures.length) throw new AggregateError(failures, 'Dispute namespace fixture retirement failed')
})
async function readFixture() {
  const peer = await startStripeFinancialPeer(); peers.push(peer)
  const client = createStripeReadClient(config, new AbortController().signal, Date.now() + 10000); clients.push(client)
  return { peer, client }
}

test.each(prefixes)('real SDK retrieves %s Dispute and sends its exact list continuation cursor', async prefix => {
  const { peer, client } = await readFixture(), id = `${prefix}_fixture123`
  peer.setReply(`/v1/disputes/${id}`, { body: dispute(id) })
  peer.setReply(`/v1/disputes?charge=ch_fixture123&limit=100&starting_after=${id}`, {
    body: provider.list('/v1/disputes', [dispute(`${prefix}_next123`)]) })
  expect((await client.retrieveDispute(id)).id).toBe(id)
  expect((await client.listDisputes('ch_fixture123', id)).data.map(row => row.id)).toEqual([`${prefix}_next123`])
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual([
    'GET /v1/account', `GET /v1/disputes/${id}`, `GET /v1/disputes?charge=ch_fixture123&limit=100&starting_after=${id}`,
  ])
})

test.each(['retrieve', 'cursor'] as const)('unknown Dispute %s is refused before any Dispute I/O', async method => {
  const { peer, client } = await readFixture()
  const read = method === 'retrieve' ? client.retrieveDispute('dx_fixture123') : client.listDisputes('ch_fixture123', 'dx_fixture123')
  await expect(read).rejects.toMatchObject({ name: 'StripeProviderError' })
  expect(peer.requests().map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/account'])
})

test.each([
  { reason: 'foreign namespace', changes: { id: 'dx_fixture123' } },
  { reason: 'wrong object', changes: { object: 'charge' } },
  { reason: 'wrong environment', changes: { livemode: true } },
  { reason: 'foreign Charge', changes: { charge: 'ch_other' } },
  { reason: 'wrong PaymentIntent type', changes: { payment_intent: { id: 'pi_fixture123', object: 'charge' } } },
])('du list keeps provider rejection for $reason', async ({ changes }) => {
  const { peer, client } = await readFixture()
  peer.setReply('/v1/disputes?charge=ch_fixture123&limit=100', {
    body: provider.list('/v1/disputes', [{ ...dispute('du_fixture123'), ...changes }]) })
  await expect(client.listDisputes('ch_fixture123')).rejects.toMatchObject({ name: 'StripeProviderError' })
})

test.each(prefixes)('public worker records %s Dispute as held risk without applying a monetary decision', async prefix => {
  const peer = await startStripeFinancialPeer(); peers.push(peer)
  installBillingReadReplies(peer, { charge: { disputed: true } })
  const id = `${prefix}_fixture123`, facts: VerifiedRiskFacts[] = []
  peer.setReply(`/v1/disputes/${id}`, { body: dispute(id) })
  peer.setReply('/v1/disputes?charge=ch_fixture123&limit=100', { body: provider.list('/v1/disputes', [dispute(id)]) })
  peer.setReply('/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_fixture123&limit=100', {
    body: provider.list('/v1/invoice_payments', [provider.allocation]) })
  const baseline = billingWorkerClaim()
  const claim: BillingClaim = { ...baseline, event: { ...baseline.event, type: 'charge.dispute.created', objectId: id, objectType: 'dispute',
    references: { customerId: null, subscriptionId: null, paymentIntentId: 'pi_fixture123', chargeId: 'ch_fixture123', riskId: id } } }
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected monetary or admission effect') }
  const owner = {
    receive: unexpected, claimAdmission: unexpected, finalizeAdmission: unexpected,
    claim: vi.fn<BillingStore['claim']>().mockResolvedValue(claim),
    observe: vi.fn<BillingStore['observe']>().mockImplementation(async (_claim, lineage, input) => ({
      lineage, chargeIds: ['ch_fixture123'], riskRevisions: [{ chargeId: 'ch_fixture123', revision: 1 }],
      expectedAgreementVersion: 0, expectedCurrentAgreementId: null, manifestRevision: 1, manifestReady: true,
      paymentEdges: input.paymentEdges,
    })),
    apply: vi.fn<BillingStore['apply']>().mockImplementation(unexpected),
    recordRisk: vi.fn<BillingStore['recordRisk']>().mockImplementation(async (_claim, _observation, current) => {
      facts.push(current); return { targetDisposition: 'held', commandCompleted: true }
    }),
  } satisfies BillingStore
  const handler = createBillingHandler(config, owner); handlers.push(handler)
  expect(await handler.handle(billingWorkerInput, new AbortController().signal)).toEqual({ state: 'held', commandCompleted: true })
  expect(facts).toEqual([{ chargeObservations: [{ chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123',
    customerId: 'cus_fixture', currency: 'eur', amountRefunded: 0, refunded: false, disputed: true,
    stripeFraudReport: null, userFraudReport: null }], disputes: [{ riskId: id, chargeId: 'ch_fixture123',
    paymentIntentId: 'pi_fixture123', status: 'needs_response' }], earlyFraudWarnings: [] }])
  expect(owner.apply).not.toHaveBeenCalled()
})
