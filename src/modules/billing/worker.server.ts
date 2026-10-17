import type Stripe from 'stripe'
import { Schema } from 'effect'
import type { StripeConfig } from './stripe-config.server'
import { createStripeReadClient, type StripeReadClient } from './stripe-read.server'
import { proveBillingLineage, resolveBillingEventInvoices, type ObservedBillingLineage } from './lineage.server'
import { BillingMonetaryError, provePaidMonthlyInvoice, proveUnpaidMonthlyInvoice } from './reconcile.server'
import { classifyBillingEvent } from './events.server'
import { billingUuid, decodeBilling, riskFactsSchema } from './billing-agreement.server'
import type { BillingStore, BillingClaim, BillingObservation, BillingApplyDecision, BillingEffectResult,
  ObservedChargeBinding, VerifiedRiskFacts } from './store.server'

type Result = Readonly<{ state: 'applied' | 'duplicate' | 'held' | 'stale' | 'deferred'; commandCompleted: boolean }>
const deferred: Result = Object.freeze({ state: 'deferred', commandCompleted: false })
const jobSchema = Schema.Struct({ outboxId: billingUuid, tenantId: billingUuid })
const ids = { invoice: /^in_[A-Za-z0-9]+$/, intent: /^pi_[A-Za-z0-9]+$/, charge: /^ch_[A-Za-z0-9]+$/ }
function fail(): never { throw new Error('Billing reconciliation unavailable') }
function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null
}
async function pages<T extends { id: string }>(read: (cursor?: string) => Promise<{ object: 'list'; data: T[]; has_more: boolean }>): Promise<T[]> {
  const all: T[] = [], seen = new Set<string>()
  let cursor: string | undefined
  for (let count = 0; count < 5; count++) {
    const page = await read(cursor)
    if (page.object !== 'list' || !Array.isArray(page.data) || page.data.length > 100
      || typeof page.has_more !== 'boolean' || page.has_more && page.data.length === 0) fail()
    for (const value of page.data) {
      if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 255 || seen.has(value.id)) fail()
      seen.add(value.id); all.push(value)
    }
    if (!page.has_more) return all
    cursor = page.data.at(-1)!.id
  }
  return fail()
}
function checkIntent(pi: Stripe.PaymentIntent, id: string, lineage: ObservedBillingLineage) {
  if (pi.id !== id || pi.object !== 'payment_intent' || pi.livemode !== (lineage.environment === 'live')
    || idOf(pi.customer) !== lineage.customerId || pi.currency !== lineage.boundInvoice.currency) fail()
}
function checkCharge(charge: Stripe.Charge, id: string, pi: string, lineage: ObservedBillingLineage) {
  if (charge.id !== id || charge.object !== 'charge' || charge.livemode !== (lineage.environment === 'live')
    || idOf(charge.customer) !== lineage.customerId || idOf(charge.payment_intent) !== pi
    || charge.currency !== lineage.boundInvoice.currency) fail()
}
async function invoiceIntents(client: StripeReadClient, lineage: ObservedBillingLineage): Promise<Set<string>> {
  const allocations = await pages(cursor => client.listInvoicePayments(lineage.invoiceId, cursor))
  const intents = new Set<string>()
  for (const allocation of allocations) {
    const pi = idOf(allocation.payment?.payment_intent)
    if (allocation.object !== 'invoice_payment' || allocation.livemode !== (lineage.environment === 'live')
      || idOf(allocation.invoice) !== lineage.invoiceId || allocation.currency !== lineage.boundInvoice.currency
      || allocation.payment?.type !== 'payment_intent' || !pi || !ids.intent.test(pi)
      || allocation.payment.charge != null || allocation.payment.payment_record != null) fail()
    intents.add(pi)
  }
  return intents
}
async function discoverEdges(client: StripeReadClient, claim: BillingClaim, lineage: ObservedBillingLineage): Promise<ObservedChargeBinding[]> {
  const edges = new Map<string, ObservedChargeBinding>()
  for (const piId of await invoiceIntents(client, lineage)) {
    const pi = await client.retrievePaymentIntent(piId)
    checkIntent(pi, piId, lineage)
    const charges = new Set<string>()
    if (pi.latest_charge !== null) {
      const charge = idOf(pi.latest_charge)
      if (!charge || !ids.charge.test(charge)) fail()
      charges.add(charge)
    }
    // The original risk Charge can precede the PI's current latest Charge.
    // Its exact object and allocation ownership must still be established.
    if (claim.event.references.chargeId !== null) {
      const original = await client.retrieveCharge(claim.event.references.chargeId)
      if (idOf(original.payment_intent) === piId) charges.add(original.id)
    }
    for (const chargeId of charges) {
      const charge = await client.retrieveCharge(chargeId)
      checkCharge(charge, chargeId, piId, lineage)
      edges.set(`${chargeId}/${piId}`, { chargeId, paymentIntentId: piId, invoiceId: lineage.invoiceId })
      if (edges.size > 500) fail()
    }
  }
  return [...edges.values()].sort((a, b) => a.chargeId.localeCompare(b.chargeId) || a.paymentIntentId.localeCompare(b.paymentIntentId))
}
async function readRiskFacts(client: StripeReadClient, observation: BillingObservation): Promise<VerifiedRiskFacts> {
  const { lineage } = observation
  const currentIntents = await invoiceIntents(client, lineage)
  const charges: unknown[] = [], disputes: unknown[] = [], warnings: unknown[] = []
  for (const chargeId of observation.chargeIds) {
    const charge = await client.retrieveCharge(chargeId)
    const piId = idOf(charge.payment_intent)
    if (!piId || !currentIntents.has(piId) || !observation.paymentEdges.some(edge => edge.invoiceId === lineage.invoiceId
      && edge.chargeId === chargeId && edge.paymentIntentId === piId)) fail()
    checkCharge(charge, chargeId, piId, lineage)
    const pi = await client.retrievePaymentIntent(piId)
    checkIntent(pi, piId, lineage)
    charges.push({ chargeId, paymentIntentId: piId, customerId: lineage.customerId, currency: charge.currency,
      amountRefunded: charge.amount_refunded, refunded: charge.refunded, disputed: charge.disputed,
      stripeFraudReport: charge.fraud_details?.stripe_report ?? null, userFraudReport: charge.fraud_details?.user_report ?? null })
    for (const listed of await pages(cursor => client.listDisputes(chargeId, cursor))) {
      const risk = await client.retrieveDispute(listed.id)
      const riskPi = idOf(risk.payment_intent)
      if (risk.id !== listed.id || risk.object !== 'dispute' || risk.livemode !== (lineage.environment === 'live')
        || idOf(risk.charge) !== chargeId || riskPi !== null && riskPi !== piId || risk.currency !== lineage.boundInvoice.currency) fail()
      disputes.push({ riskId: risk.id, chargeId, paymentIntentId: riskPi, status: risk.status })
      if (disputes.length > 500) fail()
    }
    for (const listed of await pages(cursor => client.listEarlyFraudWarnings(chargeId, cursor))) {
      const risk = await client.retrieveEarlyFraudWarning(listed.id)
      const riskPi = idOf(risk.payment_intent)
      if (risk.id !== listed.id || risk.object !== 'radar.early_fraud_warning' || risk.livemode !== (lineage.environment === 'live')
        || idOf(risk.charge) !== chargeId || riskPi !== null && riskPi !== piId) fail()
      warnings.push({ riskId: risk.id, chargeId, paymentIntentId: riskPi, actionable: risk.actionable })
      if (warnings.length > 500) fail()
    }
  }
  return decodeBilling(riskFactsSchema, { chargeObservations: charges, disputes, earlyFraudWarnings: warnings })
}
async function monetaryDecision(config: StripeConfig, client: StripeReadClient,
  lineage: ObservedBillingLineage): Promise<BillingApplyDecision> {
  try { return { kind: 'paid', proof: await provePaidMonthlyInvoice(config, client, lineage.boundInvoice) } }
  catch (error) { if (!(error instanceof BillingMonetaryError)) throw error }
  try { return { kind: 'observedNoGrant', evidence: await proveUnpaidMonthlyInvoice(config, client, lineage.boundInvoice) } }
  catch (error) { if (!(error instanceof BillingMonetaryError)) throw error }
  return { kind: 'unresolved' }
}
function sameObservation(a: BillingObservation, b: BillingObservation) {
  return a.manifestRevision === b.manifestRevision && b.manifestReady
    && a.expectedAgreementVersion === b.expectedAgreementVersion && a.expectedCurrentAgreementId === b.expectedCurrentAgreementId
    && JSON.stringify(a.paymentEdges) === JSON.stringify(b.paymentEdges) && JSON.stringify(a.riskRevisions) === JSON.stringify(b.riskRevisions)
}

export function createBillingHandler(config: StripeConfig, store: BillingStore) {
  let stopped = false, active: { cancel: AbortController; promise: Promise<Result> } | null = null
  let stopping: Promise<void> | undefined
  function handle(input: unknown, signal: AbortSignal): Promise<Result> {
    if (stopped || active !== null || signal.aborted) return Promise.resolve(deferred)
    let job: typeof jobSchema.Type
    try { job = decodeBilling(jobSchema, input) } catch { return Promise.resolve(deferred) }
    const cancel = new AbortController(), onAbort = () => cancel.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let deadline = Date.now() + 30000, timer = setTimeout(onAbort, 30000)
    let client: StripeReadClient | undefined
    const check = () => { if (cancel.signal.aborted || Date.now() >= deadline) fail() }
    async function run(): Promise<Result> {
      const progress: { state: Result['state'] } = { state: 'deferred' }
      function result(value: BillingEffectResult): Result {
        switch (value.targetDisposition) {
          case 'held': progress.state = 'held'; break
          case 'stale': progress.state = 'stale'; break
          case 'applied': case 'observed-no-grant': if (progress.state !== 'held') progress.state = 'applied'; break
          case 'risk-recorded': if (value.commandCompleted && progress.state !== 'held') progress.state = 'applied'; break
          case 'duplicate': if (progress.state !== 'held' && progress.state !== 'applied') progress.state = 'duplicate'; break
          case 'incomplete': case 'unresolved': if (progress.state !== 'held') progress.state = 'deferred'; break
        }
        return { state: progress.state, commandCompleted: value.commandCompleted }
      }
      try {
        check()
        const claim = await store.claim(job, cancel.signal)
        check()
        if (!claim) return deferred
        if (claim.input.outboxId !== job.outboxId || claim.input.tenantId !== job.tenantId) fail()
        if (claim.commandCompleted) return { state: 'duplicate', commandCompleted: true }
        deadline = Math.min(deadline, claim.deadlineAtMs)
        clearTimeout(timer); timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()))
        check()
        client = createStripeReadClient(config, cancel.signal, deadline)
        const candidates = [...new Set(await resolveBillingEventInvoices(config, client, claim.event, claim.knownInvoiceIds))].sort()
        if (candidates.length === 0 || candidates.length > 500 || candidates.some(id => !ids.invoice.test(id))) fail()
        const targets: Array<{ lineage: ObservedBillingLineage; edges: ObservedChargeBinding[]; observation: BillingObservation }> = []
        let edgeCount = 0
        // Establish the entire candidate envelope before any monetary/risk
        // settlement. Every observe transaction ends before the next GET.
        for (const invoiceId of candidates) {
          check()
          const proven = await proveBillingLineage(config, client, claim.operation, claim.customer, invoiceId)
          // The positive lineage retains the original Checkout catalog. The
          // SQL period identity carries a fee only for its first period.
          const lineage: ObservedBillingLineage = proven.boundInvoice.firstPeriod === false
            ? Object.freeze({ ...proven, boundInvoice: Object.freeze({ ...proven.boundInvoice, onboarding: null }) }) : proven
          const edges = await discoverEdges(client, claim, lineage)
          edgeCount += edges.length
          if (edgeCount > 500) fail()
          check()
          const observation = await store.observe(claim, lineage, { candidateInvoiceIds: candidates, paymentEdges: edges }, cancel.signal)
          targets.push({ lineage, edges, observation })
        }
        if (!targets.at(-1)?.observation.manifestReady) return deferred
        const kind = classifyBillingEvent(claim.event).kind
        const riskOnly = kind === 'charge' || kind === 'dispute' || kind === 'early_fraud_warning'
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index]!
          check()
          let observation = targets.length === 1 ? target.observation
            : await store.observe(claim, target.lineage, { candidateInvoiceIds: candidates, paymentEdges: target.edges }, cancel.signal)
          if (!observation.manifestReady) return { state: 'deferred', commandCompleted: false }
          const monetary = !riskOnly || claim.targetProgress.some(progress => progress.invoiceId === target.lineage.invoiceId && progress.requiresMonetary)
          let settled = false
          // A new risk observation can itself revise the SQL manifest. A
          // second fresh pass settles that revision; continuing churn defers.
          for (let pass = 0; pass < 2; pass++) {
            check()
            const decision = monetary ? await monetaryDecision(config, client, observation.lineage) : null
            if (observation.chargeIds.length > 0) {
              const facts = await readRiskFacts(client, observation)
              check()
              const recorded = await store.recordRisk(claim, observation, facts, cancel.signal)
              check()
              const status = result(recorded)
              if (recorded.commandCompleted || ['stale', 'incomplete', 'unresolved'].includes(recorded.targetDisposition)) return status
              if (!monetary) { settled = true; break }
              check()
              const fresh = await store.observe(claim, target.lineage,
                { candidateInvoiceIds: candidates, paymentEdges: target.edges }, cancel.signal)
              if (!sameObservation(observation, fresh)) { observation = fresh; continue }
              observation = fresh
            } else if (!monetary) fail()
            check()
            if (decision === null) fail()
            const applied = await store.apply(claim, observation, decision, cancel.signal)
            check()
            const status = result(applied)
            if (applied.commandCompleted || ['stale', 'incomplete', 'unresolved'].includes(applied.targetDisposition)) return status
            settled = true; break
          }
          if (!settled) return { state: progress.state === 'held' ? 'held' : 'stale', commandCompleted: false }
        }
        return { state: progress.state, commandCompleted: false }
      } catch { return { state: progress.state === 'held' ? 'held' : 'deferred', commandCompleted: false } }
      finally {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort)
        await client?.close()
      }
    }
    const promise = run().catch(() => deferred)
    active = { cancel, promise }
    void promise.then(() => { active = null })
    return promise
  }
  function stop(): Promise<void> {
    stopped = true
    active?.cancel.abort()
    return stopping ??= (async () => { await active?.promise })()
  }
  return Object.freeze({ handle, stop })
}
