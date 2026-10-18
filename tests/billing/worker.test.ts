import { afterEach, expect, test, vi } from 'vitest'
import { createBillingHandler } from '../../src/modules/billing/worker.server'
import type { BillingApplyDecision, BillingEffectResult, BillingStore, VerifiedRiskFacts } from '../../src/modules/billing/store.server'
import { config, termsB } from '../helpers/billing-fixtures'
import { billingWorkerClaim, billingWorkerInput, installBillingReadReplies } from '../helpers/billing-worker-fixture'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'

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
