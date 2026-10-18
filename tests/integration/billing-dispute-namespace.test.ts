import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { seedBillingWorker, billingWorkerClaim } from '../helpers/billing-worker-fixture'
import { config, operationId, termsA, workspaceId } from '../helpers/billing-fixtures'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createBillingStore, type VerifiedRiskFacts } from '../../src/modules/billing/store.server'
import type { ObservedBillingLineage } from '../../src/modules/billing/lineage.server'
import type { VerifiedStripeEvent } from '../../src/modules/billing/stripe-webhook.server'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let runtimePool: Pool, workerPool: Pool
let ingress: ReturnType<typeof createBillingStore>, worker: ReturnType<typeof createBillingStore>
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  const urls = await seedBillingWorker(stores)
  runtimePool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
  workerPool = new Pool({ connectionString: urls.worker, max: 1 })
  runtimePool.on('error', () => {}); workerPool.on('error', () => {})
  ingress = createBillingStore(createTransactions(runtimePool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }))
  worker = createBillingStore(createTransactions(workerPool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }))
}, 180000)
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => runtimePool?.end(), () => workerPool?.end(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  expect(stores.evidence.unrelatedUnchanged).toBe(true)
  expect(stores.evidence.inventoryDelta).toEqual([])
  if (failures.length) throw new AggregateError(failures, 'Dispute SQL fixture retirement failed')
}, 30000)

test('native SQL receipt authority independently admits du and refuses unknown namespace or inconsistent risk references', async () => {
  const event: VerifiedStripeEvent = { ...billingWorkerClaim().event, id: 'evt_disputeSqlDu',
    type: 'charge.dispute.created', objectType: 'dispute', objectId: 'du_nativeSql',
    references: { customerId: null, subscriptionId: null, chargeId: 'ch_disputeSql', paymentIntentId: 'pi_disputeSql', riskId: 'du_nativeSql' } }
  // Call the granted function directly so the application codec cannot mask a SQL regression.
  const receive = (value: VerifiedStripeEvent) => runtimePool.query<{ result: { status: string } }>(
    'SELECT app_private.billing_receive_event($1::jsonb) AS result', [JSON.stringify(value)])
  for (const rejected of [
    { ...event, id: 'evt_disputeSqlUnknown', objectId: 'dx_nativeSql', references: { ...event.references, riskId: 'dx_nativeSql' } },
    { ...event, id: 'evt_disputeSqlObject', objectType: 'charge' },
    { ...event, id: 'evt_disputeSqlReference', references: { ...event.references, riskId: 'dp_other' } },
    { ...event, id: 'evt_disputeSqlCustomer', references: { ...event.references, customerId: 'cus_fixture' } },
  ]) {
    await expect(receive(rejected)).rejects.toThrow()
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_event_receipt WHERE event_id=$1', [rejected.id])).rows[0].n).toBe(0)
  }
  expect((await receive(event)).rows[0]?.result).toEqual({ status: 'unassigned-risk' })
  expect((await receive(event)).rows[0]?.result).toEqual({ status: 'unassigned-risk' })
  expect((await stores.administrator.query('SELECT risk_id,charge_id FROM billing_event_receipt WHERE event_id=$1', [event.id])).rows)
    .toEqual([{ risk_id: 'du_nativeSql', charge_id: 'ch_disputeSql' }])
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_current_agreement')).rows[0].n).toBe(0)
})

test('native worker SQL records dp and du facts under the exact observed scope without creating paid entitlement', async () => {
  const event = { ...billingWorkerClaim().event, id: 'evt_disputeSqlFacts' }, signal = new AbortController().signal
  expect(await ingress.receive(event, signal)).toBe('enqueued')
  const outboxes = (await stores.administrator.query<{ id: string }>('SELECT o.id FROM billing_outbox o JOIN billing_command c ON c.id=o.command_id JOIN billing_event_receipt r ON r.id=c.receipt_id WHERE r.event_id=$1', [event.id])).rows
  expect(outboxes).toHaveLength(1)
  const input = { outboxId: outboxes[0]!.id, tenantId: workspaceId }, claim = await worker.claim(input, signal)
  if (!claim || claim.commandCompleted) throw new Error('Expected a fresh native financial claim')
  const lineage: ObservedBillingLineage = { operationId, workspaceId, environment: config.environment, accountId: config.accountId,
    customerId: 'cus_fixture', checkoutSessionId: 'cs_test_fixture123', subscriptionId: 'sub_fixture123', invoiceId: 'in_fixture123',
    boundInvoice: { environment: config.environment, accountId: config.accountId, customerId: 'cus_fixture',
      subscriptionId: 'sub_fixture123', invoiceId: 'in_fixture123', agreedTermsId: termsA.id,
      monthlyPriceId: termsA.monthlyPriceId, currency: 'eur', expectedAmount: 1500,
      periodStart: 1790812800, periodEnd: 1793491200, firstPeriod: true, onboarding: null } }
  const observation = await worker.observe(claim, lineage, { candidateInvoiceIds: ['in_fixture123'],
    paymentEdges: [{ chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', invoiceId: 'in_fixture123' }] }, signal)
  expect(observation.manifestReady).toBe(true)
  const facts: VerifiedRiskFacts = { chargeObservations: [{ chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123',
    customerId: 'cus_fixture', currency: 'eur', amountRefunded: 0, refunded: false, disputed: true,
    stripeFraudReport: null, userFraudReport: null }], disputes: [
      { riskId: 'dp_nativeFacts', chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', status: 'under_review' },
      { riskId: 'du_nativeFacts', chargeId: 'ch_fixture123', paymentIntentId: 'pi_fixture123', status: 'needs_response' },
    ], earlyFraudWarnings: [] }
  const record = (envelope: unknown, tenant = workspaceId, fence = claim.fence) => workerPool.query<{ result: unknown }>(
    'SELECT app_private.billing_record_risk($1::uuid,$2::uuid,$3::bigint,$4::jsonb) AS result',
    [input.outboxId, tenant, fence, JSON.stringify(envelope)])
  const unknown = { ...facts, disputes: [{ ...facts.disputes[1]!, riskId: 'dx_nativeFacts' }] }
  const wrongCharge = { ...facts, disputes: [{ ...facts.disputes[1]!, chargeId: 'ch_other' }] }
  const wrongIntent = { ...facts, disputes: [{ ...facts.disputes[1]!, paymentIntentId: 'pi_other' }] }
  const wrongStatus = { ...facts, disputes: [{ ...facts.disputes[1]!, status: 'unknown' }] }
  for (const rejected of [unknown, wrongCharge, wrongIntent, wrongStatus]) {
    await expect(record({ observation, facts: rejected })).rejects.toThrow()
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_risk_observation')).rows[0].n).toBe(0)
  }
  for (const scope of [{ accountId: 'acct_other' }, { environment: 'live' }]) {
    await expect(record({ observation: { ...observation, lineage: { ...lineage, ...scope,
      boundInvoice: { ...lineage.boundInvoice, ...scope } } }, facts })).rejects.toThrow()
  }
  expect((await record({ observation, facts }, randomUUID())).rows[0]?.result).toEqual({ targetDisposition: 'stale', commandCompleted: false })
  expect((await record({ observation, facts }, workspaceId, claim.fence + 1)).rows[0]?.result).toEqual({ targetDisposition: 'stale', commandCompleted: false })
  expect((await record({ observation, facts })).rows[0]?.result).toEqual({ targetDisposition: 'held', commandCompleted: false })
  expect((await stores.administrator.query('SELECT workspace_id,environment,account_id,charge_id,facts FROM billing_risk_observation')).rows)
    .toEqual([{ workspace_id: workspaceId, environment: 'sandbox', account_id: 'acct_fixture', charge_id: 'ch_fixture123', facts }])
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_agreement')).rows[0].n).toBe(0)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_current_agreement')).rows[0].n).toBe(0)
})
