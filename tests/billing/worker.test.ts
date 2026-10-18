import { afterEach, expect, test, vi } from 'vitest'
import { createBillingHandler } from '../../src/modules/billing/worker.server'
import type { BillingApplyDecision, BillingClaim, BillingEffectResult, BillingStore, VerifiedRiskFacts } from '../../src/modules/billing/store.server'
import { config, termsB } from '../helpers/billing-fixtures'
import { billingWorkerClaim, billingWorkerInput, installBillingReadReplies } from '../helpers/billing-worker-fixture'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'
import * as provider from '../helpers/billing-provider-fixtures'
import type Stripe from 'stripe'

const peers: Awaited<ReturnType<typeof startStripeFinancialPeer>>[] = []
const handlers: ReturnType<typeof createBillingHandler>[] = []
async function fixture(options: Parameters<typeof installBillingReadReplies>[1] = {}, holdTls = false) {
  const peer = await startStripeFinancialPeer({ holdTls }); peers.push(peer)
  installBillingReadReplies(peer, options)
  const decisions: BillingApplyDecision[] = [], risks: VerifiedRiskFacts[] = []
  const owner = {
    receive: vi.fn<BillingStore['receive']>().mockRejectedValue(new Error('Unexpected receive')),
    claimAdmission: vi.fn<BillingStore['claimAdmission']>().mockRejectedValue(new Error('Unexpected admission')),
    finalizeAdmission: vi.fn<BillingStore['finalizeAdmission']>().mockRejectedValue(new Error('Unexpected admission settlement')),
    claim: vi.fn<BillingStore['claim']>().mockImplementation(async () => billingWorkerClaim()),
    observe: vi.fn<BillingStore['observe']>().mockImplementation(async (_claim, lineage, input) => ({
      lineage, chargeIds: [...new Set(input.paymentEdges.map(edge => edge.chargeId))],
      riskRevisions: input.paymentEdges.map(edge => ({ chargeId: edge.chargeId, revision: 0 })),
      expectedAgreementVersion: 0, expectedCurrentAgreementId: null, manifestRevision: 1, manifestReady: true,
      paymentEdges: input.paymentEdges,
    })),
    apply: vi.fn<BillingStore['apply']>().mockImplementation(async (_claim, _observation, decision): Promise<BillingEffectResult> => {
      decisions.push(decision)
      return { targetDisposition: decision.kind === 'unresolved' ? 'unresolved' : 'applied', commandCompleted: decision.kind !== 'unresolved' }
    }),
    recordRisk: vi.fn<BillingStore['recordRisk']>().mockImplementation(async (_claim, _observation, facts): Promise<BillingEffectResult> => {
      risks.push(facts)
      return { targetDisposition: 'risk-recorded', commandCompleted: false }
    }),
  } satisfies BillingStore
  const handler = createBillingHandler(config, owner); handlers.push(handler)
  return { peer, owner, handler, decisions, risks, run: (signal = new AbortController().signal) => handler.handle(billingWorkerInput, signal) }
}
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.stop()
  for (const peer of peers.splice(0)) {
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
    expect(peer.requests().every(request => request.method === 'GET' && request.authorized
      && request.apiVersion === config.apiVersion && !request.accountHeader && !request.contextHeader)).toBe(true)
    await peer.close()
  }
})

test('worker proves the immutable operation A through real SDK reads after Price A archival and observes before granting', async () => {
  const f = await fixture()
  expect(termsB.revision).toBeGreaterThan(billingWorkerClaim().agreedTerms.revision)
  expect(await f.run()).toEqual({ state: 'applied', commandCompleted: true })
  expect(f.decisions).toEqual([{ kind: 'paid', proof: {
    invoiceId: 'in_fixture123', subscriptionId: 'sub_fixture123', customerId: 'cus_fixture', currency: 'eur', amount: 1500,
    periodStart: 1790812800, periodEnd: 1793491200, allocationIds: ['inpay_fixture123'], paymentIntentIds: ['pi_fixture123'], chargeIds: ['ch_fixture123'],
  } }])
  expect(f.owner.observe.mock.invocationCallOrder[0]).toBeLessThan(f.owner.apply.mock.invocationCallOrder[0]!)
})

test('worker cannot settle money or risk when the durable manifest is incomplete', async () => {
  const f = await fixture(), observe = f.owner.observe.getMockImplementation()!
  f.owner.observe.mockImplementation(async (...args) => ({ ...await observe(...args), manifestReady: false }))
  expect(await f.run()).toEqual({ state: 'deferred', commandCompleted: false })
  expect(f.owner.apply).not.toHaveBeenCalled(); expect(f.owner.recordRisk).not.toHaveBeenCalled()
})

test('off-Stripe funds cannot become a paid or unpaid grant through worker reconciliation', async () => {
  const f = await fixture({ invoice: { amount_paid_off_stripe: 1 } })
  expect((await f.run()).commandCompleted).toBe(false)
  expect(f.decisions).toEqual([{ kind: 'unresolved' }])
})

test('worker records an exact adverse fraud warning and preserves the held result before any paid settlement', async () => {
  const f = await fixture({ warning: true })
  f.owner.recordRisk.mockImplementation(async (_claim, _observation, facts) => {
    f.risks.push(facts); return { targetDisposition: 'held', commandCompleted: true }
  })
  expect(await f.run()).toEqual({ state: 'held', commandCompleted: true })
  expect(f.risks[0]?.earlyFraudWarnings).toEqual([{ riskId: 'issfr_fixture123', chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', actionable: true }])
  expect(f.owner.apply).not.toHaveBeenCalled()
})

test.each(['money', 'risk'] as const)('lost final %s COMMIT acknowledgement reenters persisted completion without another Stripe GET', async effect => {
  const f = await fixture(effect === 'risk' ? { warning: true } : {})
  const uncertain = async (): Promise<BillingEffectResult> => { throw new Error('Synthetic committed result acknowledgement lost') }
  if (effect === 'money') f.owner.apply.mockImplementation(uncertain)
  else f.owner.recordRisk.mockImplementation(uncertain)
  expect((await f.run()).commandCompleted).toBe(false)
  const reads = f.peer.requests().length
  f.owner.claim.mockResolvedValue({ input: billingWorkerInput, commandCompleted: true })
  expect(await f.run()).toEqual({ state: 'duplicate', commandCompleted: true })
  expect(f.peer.requests()).toHaveLength(reads)
})

test.each(['TLS', 'headers', 'body'] as const)('worker stop joins the admitted SDK %s obligation and its client socket before returning', async phase => {
  const f = await fixture(phase === 'TLS' ? {} : { holdInvoice: phase }, phase === 'TLS')
  const pending = f.run()
  try {
    await expect.poll(() => phase === 'TLS' ? f.peer.evidence().clientSockets > 0
      : f.peer.requests().some(request => request.path === '/v1/invoices/in_fixture123')).toBe(true)
    await f.handler.stop()
    expect(f.peer.evidence().clientSockets).toBe(0)
    expect((await pending).commandCompleted).toBe(false)
    const claims = f.owner.claim.mock.calls.length
    expect((await f.run()).commandCompleted).toBe(false)
    expect(f.owner.claim).toHaveBeenCalledTimes(claims)
  } finally { await f.handler.stop(); await pending }
})

test('null, malformed and preaborted jobs cannot begin supplier reads', async () => {
  const f = await fixture(); f.owner.claim.mockResolvedValue(null)
  expect((await f.run()).commandCompleted).toBe(false)
  const aborted = new AbortController(); aborted.abort()
  expect((await f.run(aborted.signal)).commandCompleted).toBe(false)
  expect((await f.handler.handle({ ...billingWorkerInput, eventId: 'evt_untrusted' }, new AbortController().signal)).commandCompleted).toBe(false)
  expect(f.owner.claim).toHaveBeenCalledTimes(1)
  expect(f.peer.requests()).toEqual([])
})

function claimEvent(event: Partial<BillingClaim['event']>, knownInvoiceIds: string[] = []): BillingClaim {
  const claim = billingWorkerClaim()
  return { ...claim, event: { ...claim.event, ...event }, knownInvoiceIds }
}

test('a stable unrelated customer adjustment does not replace captured-payment proof or prevent its grant', async () => {
  const f = await fixture()
  f.peer.setReply('/v1/customers/cus_fixture/balance_transactions?limit=100', { body: provider.list(
    '/v1/customers/cus_fixture/balance_transactions', [{
      id: 'cbtxn_unrelated', object: 'customer_balance_transaction', customer: 'cus_fixture', customer_account: null,
      currency: 'eur', livemode: false, type: 'adjustment', amount: -200, ending_balance: -200,
      created: 1793491300, invoice: null, checkout_session: null, credit_note: null,
    }]) })
  expect(await f.run()).toEqual({ state: 'applied', commandCompleted: true })
  expect(f.decisions).toEqual([{ kind: 'paid', proof: expect.objectContaining({
    amount: 1500, invoiceId: 'in_fixture123', allocationIds: ['inpay_fixture123'],
    paymentIntentIds: ['pi_fixture123'], chargeIds: ['ch_fixture123'],
  }) }])
  expect(f.peer.requests().some(request => request.path === '/v1/customers/cus_fixture/balance_transactions?limit=100')).toBe(true)
})

test.each([
  { status: 'open', amountPaid: null }, { status: 'canceled', amountPaid: null },
  { status: 'open', amountPaid: 0 }, { status: 'open', amountPaid: 1500 },
] as const)('$status InvoicePayment with amount_paid=$amountPaid cannot grant paid access without captured funds', async ({ status, amountPaid }) => {
  const f = await fixture({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 1500 } })
  f.owner.claim.mockResolvedValue(claimEvent({ type: 'invoice.payment_failed' }))
  f.peer.setReply('/v1/invoice_payments?invoice=in_fixture123&limit=100', { body: provider.list('/v1/invoice_payments', [{
    ...provider.allocation, status, amount_paid: amountPaid, is_default: status === 'open',
    status_transitions: { paid_at: null, canceled_at: status === 'canceled' ? 1790812802 : null },
  }]) })
  f.peer.setReply('/v1/payment_intents/pi_fixture123', { body: {
    ...provider.pi, status: status === 'canceled' ? 'canceled' : 'requires_payment_method', amount_received: 0, latest_charge: null,
  } })
  const result = await f.run()
  if (amountPaid === null) {
    expect(result).toEqual({ state: 'applied', commandCompleted: true })
    expect(f.decisions).toEqual([{ kind: 'observedNoGrant', evidence: expect.objectContaining({
      kind: 'unpaid-invoice', invoiceId: 'in_fixture123', status: 'open', amountDue: 1500,
      amountPaid: 0, amountRemaining: 1500, invoicePaymentIds: ['inpay_fixture123'],
    }) }])
  } else {
    expect(result).toEqual({ state: 'deferred', commandCompleted: false })
    expect(f.decisions).toEqual([{ kind: 'unresolved' }])
  }
  expect(f.owner.apply).toHaveBeenCalledTimes(1)
  expect(f.owner.recordRisk).not.toHaveBeenCalled()
  expect(f.peer.requests().some(request => request.path.startsWith('/v1/charges/'))).toBe(false)
})

test('a subscription update resolves its current invoice and still requires separate captured-payment proof', async () => {
  const f = await fixture()
  f.owner.claim.mockResolvedValue(claimEvent({
    type: 'customer.subscription.updated', objectType: 'subscription', objectId: 'sub_fixture123',
  }))
  expect(await f.run()).toEqual({ state: 'applied', commandCompleted: true })
  expect(f.decisions).toEqual([{ kind: 'paid', proof: expect.objectContaining({
    invoiceId: 'in_fixture123', amount: 1500, chargeIds: ['ch_fixture123'],
  }) }])
  expect(f.peer.requests().some(request => request.path === '/v1/subscriptions/sub_fixture123')).toBe(true)
  expect(f.peer.requests().some(request => request.path === '/v1/payment_intents/pi_fixture123')).toBe(true)
})

test('a subscription event cannot reconcile an invoice belonging to another customer', async () => {
  const f = await fixture({ invoice: { customer: 'cus_other' } })
  f.owner.claim.mockResolvedValue(claimEvent({
    type: 'customer.subscription.updated', objectType: 'subscription', objectId: 'sub_fixture123',
  }))
  expect(await f.run()).toEqual({ state: 'deferred', commandCompleted: false })
  expect(f.owner.observe).not.toHaveBeenCalled()
  expect(f.owner.apply).not.toHaveBeenCalled()
  expect(f.owner.recordRisk).not.toHaveBeenCalled()
  expect(f.peer.requests().map(request => `${request.method} ${request.path}`)).toEqual([
    'GET /v1/account', 'GET /v1/subscriptions/sub_fixture123', 'GET /v1/invoices/in_fixture123',
  ])
})

test('a refunded-charge event resolves its allocation and preserves the held risk result without a paid grant', async () => {
  const f = await fixture({ charge: { amount_refunded: 1500, refunded: true } })
  f.owner.claim.mockResolvedValue(claimEvent({
    type: 'charge.refunded', objectType: 'charge', objectId: 'ch_fixture123',
    references: { ...billingWorkerClaim().event.references, chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123' },
  }))
  const allocationPath = '/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_fixture123&limit=100'
  f.peer.setReply(allocationPath, { body: provider.list('/v1/invoice_payments', [provider.allocation]) })
  f.owner.recordRisk.mockImplementation(async (_claim, _observation, facts) => {
    f.risks.push(facts); return { targetDisposition: 'held', commandCompleted: true }
  })
  expect(await f.run()).toEqual({ state: 'held', commandCompleted: true })
  expect(f.risks).toEqual([{ chargeObservations: [{
    chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', customerId: 'cus_fixture', currency: 'eur',
    amountRefunded: 1500, refunded: true, disputed: false, stripeFraudReport: null, userFraudReport: null,
  }], disputes: [], earlyFraudWarnings: [] }])
  expect(f.owner.observe.mock.invocationCallOrder[0]).toBeLessThan(f.owner.recordRisk.mock.invocationCallOrder[0]!)
  expect(f.owner.apply).not.toHaveBeenCalled()
  expect(f.peer.requests().some(request => request.path === allocationPath)).toBe(true)
})

test('a fraud-warning event cannot silently discard a previously known invoice missing from its current allocations', async () => {
  const f = await fixture({ warning: true })
  f.owner.claim.mockResolvedValue(claimEvent({
    type: 'radar.early_fraud_warning.created', objectType: 'radar.early_fraud_warning', objectId: 'issfr_fixture123',
    references: { ...billingWorkerClaim().event.references, chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', riskId: 'issfr_fixture123' },
  }, ['in_historical']))
  const allocationPath = '/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_fixture123&limit=100'
  f.peer.setReply(allocationPath, {
    body: provider.list('/v1/invoice_payments', [provider.allocation]),
  })
  expect(await f.run()).toEqual({ state: 'deferred', commandCompleted: false })
  expect(f.owner.observe).not.toHaveBeenCalled()
  expect(f.owner.apply).not.toHaveBeenCalled()
  expect(f.owner.recordRisk).not.toHaveBeenCalled()
  expect(f.peer.requests().some(request => request.path === '/v1/radar/early_fraud_warnings/issfr_fixture123')).toBe(true)
  expect(f.peer.requests().some(request => request.path === allocationPath)).toBe(true)
})

const authorizedOutcome: Stripe.Charge.Outcome = {
  advice_code: null, network_advice_code: null, network_decline_code: null,
  network_status: 'approved_by_network', reason: null, risk_level: 'normal',
  seller_message: 'Synthetic authorized payment', type: 'authorized',
}

test.each([
  { label: 'normal authorization', riskLevel: 'normal', reason: null },
  { label: 'an unassessed custom allow rule', riskLevel: 'not_assessed', reason: 'rule' },
])('worker still requires and grants exact captured funds with $label', async ({ riskLevel, reason }) => {
  const f = await fixture()
  f.peer.setReply('/v1/charges/ch_fixture123', { body: { ...provider.charge,
    outcome: { ...authorizedOutcome, risk_level: riskLevel, reason },
  } })
  expect(await f.run()).toEqual({ state: 'applied', commandCompleted: true })
  expect(f.decisions).toEqual([{ kind: 'paid', proof: {
    invoiceId: 'in_fixture123', subscriptionId: 'sub_fixture123', customerId: 'cus_fixture', currency: 'eur', amount: 1500,
    periodStart: 1790812800, periodEnd: 1793491200, allocationIds: ['inpay_fixture123'],
    paymentIntentIds: ['pi_fixture123'], chargeIds: ['ch_fixture123'],
  } }])
  expect(f.peer.requests().filter(request => request.path === '/v1/charges/ch_fixture123').map(request => request.method))
    .toEqual(['GET', 'GET', 'GET'])
})

test.each([
  { label: 'an open Radar review', review: 'prv_fixture123', outcome: authorizedOutcome },
  { label: 'a manual-review outcome', review: null,
    outcome: { ...authorizedOutcome, type: 'manual_review', risk_level: 'elevated', reason: 'elevated_risk_level' } },
])('captured funds with $label cannot become a worker paid grant', async ({ review, outcome }) => {
  const f = await fixture()
  f.peer.setReply('/v1/charges/ch_fixture123', { body: { ...provider.charge, review, outcome } })
  expect(await f.run()).toEqual({ state: 'deferred', commandCompleted: false })
  expect(f.decisions).toEqual([{ kind: 'unresolved' }])
  expect(f.risks).toEqual([{ chargeObservations: [{
    chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', customerId: 'cus_fixture', currency: 'eur',
    amountRefunded: 0, refunded: false, disputed: false, stripeFraudReport: null, userFraudReport: null,
  }], disputes: [], earlyFraudWarnings: [] }])
})

test('a refused payment retaining its failed uncaptured Charge becomes an exact observation without a paid grant', async () => {
  const f = await fixture({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 1500 } })
  f.owner.claim.mockResolvedValue(claimEvent({ type: 'invoice.payment_failed' }))
  f.peer.setReply('/v1/invoice_payments?invoice=in_fixture123&limit=100', { body: provider.list('/v1/invoice_payments', [{
    ...provider.allocation, status: 'open', amount_paid: null, status_transitions: { paid_at: null, canceled_at: null },
  }]) })
  f.peer.setReply('/v1/payment_intents/pi_fixture123', { body: {
    ...provider.pi, status: 'requires_payment_method', amount_received: 0,
  } })
  f.peer.setReply('/v1/charges/ch_fixture123', { body: {
    ...provider.charge, status: 'failed', amount_captured: 0, captured: false, paid: false,
    outcome: { ...authorizedOutcome, type: 'issuer_declined', network_status: 'declined_by_network',
      reason: 'generic_decline', seller_message: 'Synthetic declined payment' },
  } })
  expect(await f.run()).toEqual({ state: 'applied', commandCompleted: true })
  expect(f.decisions).toEqual([{ kind: 'observedNoGrant', evidence: {
    kind: 'unpaid-invoice', invoiceId: 'in_fixture123', customerId: 'cus_fixture', subscriptionId: 'sub_fixture123',
    currency: 'eur', status: 'open', amountDue: 1500, amountPaid: 0, amountRemaining: 1500,
    periodStart: 1790812800, periodEnd: 1793491200, invoicePaymentIds: ['inpay_fixture123'],
    observationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  } }])
  expect(f.risks).toEqual([{ chargeObservations: [{
    chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', customerId: 'cus_fixture', currency: 'eur',
    amountRefunded: 0, refunded: false, disputed: false, stripeFraudReport: null, userFraudReport: null,
  }], disputes: [], earlyFraudWarnings: [] }])
  expect(f.owner.observe.mock.calls[0]?.[2].paymentEdges)
    .toEqual([{ chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', invoiceId: 'in_fixture123' }])
  expect(f.peer.requests().filter(request => request.path === '/v1/charges/ch_fixture123').map(request => request.method))
    .toEqual(['GET', 'GET', 'GET'])
  expect(f.owner.recordRisk.mock.invocationCallOrder[0]).toBeLessThan(f.owner.apply.mock.invocationCallOrder[0]!)
})

const listedDispute: Pick<Stripe.Dispute, 'id' | 'object' | 'livemode' | 'charge' | 'payment_intent' | 'currency' | 'status'> = {
  id: 'dp_fixture123', object: 'dispute', livemode: false, charge: 'ch_fixture123',
  payment_intent: 'pi_fixture123', currency: 'eur', status: 'needs_response',
}

test.each([
  { label: 'its owning PaymentIntent', paymentIntentId: 'pi_fixture123' },
  { label: 'a nullable PaymentIntent witness', paymentIntentId: null },
])('worker rereads a listed dispute with $label and records the current held facts before money settlement', async ({ paymentIntentId }) => {
  const f = await fixture({ charge: { disputed: true } })
  f.peer.setReply('/v1/disputes?charge=ch_fixture123&limit=100', { body: provider.list('/v1/disputes', [listedDispute]) })
  f.peer.setReply('/v1/disputes/dp_fixture123', { body: {
    ...listedDispute, payment_intent: paymentIntentId, status: 'under_review',
  } })
  f.owner.recordRisk.mockImplementation(async (_claim, _observation, facts) => {
    f.risks.push(facts); return { targetDisposition: 'held', commandCompleted: true }
  })
  expect(await f.run()).toEqual({ state: 'held', commandCompleted: true })
  expect(f.risks).toEqual([{ chargeObservations: [{
    chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', customerId: 'cus_fixture', currency: 'eur',
    amountRefunded: 0, refunded: false, disputed: true, stripeFraudReport: null, userFraudReport: null,
  }], disputes: [{ riskId: 'dp_fixture123', chargeId: 'ch_fixture123', paymentIntentId, status: 'under_review' }], earlyFraudWarnings: [] }])
  expect(f.decisions).toEqual([])
  expect(f.owner.apply).not.toHaveBeenCalled()
  expect(f.peer.requests().filter(request => request.path.startsWith('/v1/disputes')).map(request => `${request.method} ${request.path}`))
    .toEqual(['GET /v1/disputes?charge=ch_fixture123&limit=100', 'GET /v1/disputes/dp_fixture123'])
})

test.each([
  { label: 'another Charge', changes: { charge: 'ch_other' } },
  { label: 'another PaymentIntent', changes: { payment_intent: 'pi_other' } },
  { label: 'another currency', changes: { currency: 'usd' } },
])('worker defers when a listed dispute rereads as $label without recording risk or granting money', async ({ changes }) => {
  const f = await fixture({ charge: { disputed: true } })
  f.peer.setReply('/v1/disputes?charge=ch_fixture123&limit=100', { body: provider.list('/v1/disputes', [listedDispute]) })
  f.peer.setReply('/v1/disputes/dp_fixture123', { body: { ...listedDispute, ...changes } })
  expect(await f.run()).toEqual({ state: 'deferred', commandCompleted: false })
  expect(f.risks).toEqual([])
  expect(f.decisions).toEqual([])
  expect(f.owner.recordRisk).not.toHaveBeenCalled()
  expect(f.owner.apply).not.toHaveBeenCalled()
  expect(f.peer.requests().filter(request => request.path.startsWith('/v1/disputes')).map(request => `${request.method} ${request.path}`))
    .toEqual(['GET /v1/disputes?charge=ch_fixture123&limit=100', 'GET /v1/disputes/dp_fixture123'])
})
