import type { BillingClaim } from '../../src/modules/billing/store.server'
import { checkoutOperation, config, customer, termsA, workspaceId } from './billing-fixtures'
import * as provider from './billing-provider-fixtures'
import type { startStripeFinancialPeer } from './stripe-financial-protocol-peer'
import type { startDisposableStores } from '../fixtures/db/disposable-stores'
import { randomBytes, randomUUID } from 'node:crypto'

export const billingWorkerInput = { outboxId: 'abababab-abab-4bab-8bab-abababababab', tenantId: workspaceId }
export function billingWorkerClaim(): BillingClaim {
  return { input: billingWorkerInput, commandCompleted: false, fence: 1, deadlineAtMs: Date.now() + 30000,
    event: { id: 'evt_worker', type: 'invoice.paid', created: 1790812900, objectId: provider.invoice.id,
      objectType: 'invoice', projectionVersion: 1, environment: config.environment, accountId: config.accountId,
      references: { customerId: customer.stripeCustomerId, subscriptionId: provider.subscription.id,
        chargeId: null, paymentIntentId: null, riskId: null } },
    operation: { ...checkoutOperation, apiVersion: config.apiVersion }, agreedTerms: termsA, customer, knownInvoiceIds: [], manifestRevision: 0, targetProgress: [] }
}

export function installBillingReadReplies(peer: Awaited<ReturnType<typeof startStripeFinancialPeer>>, options: {
  invoice?: Partial<typeof provider.invoice>; charge?: Partial<typeof provider.charge>; warning?: boolean; holdInvoice?: 'headers' | 'body'
} = {}) {
  peer.setReply('/v1/invoices/in_fixture123', { body: { ...provider.invoice, ...options.invoice }, hold: options.holdInvoice })
  peer.setReply('/v1/subscriptions/sub_fixture123', { body: provider.subscription })
  peer.setReply('/v1/checkout/sessions/cs_test_fixture123', { body: provider.session })
  peer.setReply('/v1/checkout/sessions?subscription=sub_fixture123&customer=cus_fixture&limit=100', {
    body: provider.list('/v1/checkout/sessions', [provider.session]) })
  peer.setReply('/v1/checkout/sessions/cs_test_fixture123/line_items?limit=100', {
    body: provider.list('/v1/checkout/sessions/cs_test_fixture123/line_items', [provider.line]) })
  peer.setReply('/v1/invoice_payments?invoice=in_fixture123&limit=100', {
    body: provider.list('/v1/invoice_payments', [provider.allocation]) })
  peer.setReply('/v1/payment_intents/pi_fixture123', { body: provider.pi })
  peer.setReply('/v1/charges/ch_fixture123', { body: { ...provider.charge, ...options.charge } })
  peer.setReply('/v1/disputes?charge=ch_fixture123&limit=100', { body: provider.list('/v1/disputes', []) })
  peer.setReply('/v1/radar/early_fraud_warnings?charge=ch_fixture123&limit=100', {
    body: provider.list('/v1/radar/early_fraud_warnings', options.warning ? [provider.warning] : []) })
  peer.setReply('/v1/radar/early_fraud_warnings/issfr_fixture123', { body: provider.warning })
  peer.setReply('/v1/customers/cus_fixture/balance_transactions?limit=100', {
    body: provider.list('/v1/customers/cus_fixture/balance_transactions', []) })
}

export async function seedBillingWorker(stores: Awaited<ReturnType<typeof startDisposableStores>>) {
  const urls = { relay: '', worker: '' }
  for (const [part, login] of [['relay', 'billing_relay'], ['worker', 'billing_worker']] as const) {
    const password = randomBytes(24).toString('hex')
    await stores.administrator.query(`ALTER ROLE ${login} PASSWORD '${password}'`)
    const url = new URL(stores.directRuntimeUrl); url.username = login; url.password = password
    urls[part] = url.href
  }
  const userId = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,\'Fixture\',$2,true)', [userId, userId + '@example.test'])
  await stores.administrator.query("INSERT INTO workspace(id,kind,lifecycle,owner_user_id) VALUES($1,'personal','active',$2)", [workspaceId, userId])
  await stores.administrator.query("INSERT INTO billing_customer(workspace_id,environment,account_id,stripe_customer_id) VALUES($1,'sandbox','acct_fixture','cus_fixture')", [workspaceId])
  await stores.administrator.query("INSERT INTO billing_agreed_terms(id,workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,$2,'sandbox','acct_fixture',1,'price_negotiatedA','eur',1500)", [termsA.id, workspaceId])
  await stores.administrator.query("INSERT INTO billing_operation(id,workspace_id,kind,phase,environment,account_id,api_version,idempotency_key,request_hash,customer_id,agreed_terms_id,monthly_price_id,currency,monthly_unit_amount,integration_identifier,checkout_reference_version) VALUES($1,$2,'CHECKOUT_CREATE','UNKNOWN','sandbox','acct_fixture','2026-09-30.endive',$3,$4,'cus_fixture',$5,'price_negotiatedA','eur',1500,'template_ABCDEFGH','operation-v2')",
    [checkoutOperation.id, workspaceId, checkoutOperation.idempotencyKey, checkoutOperation.requestHash, termsA.id])
  return urls
}
