import Stripe from 'stripe'
import { Redacted, type Schema } from 'effect'
import { expect, test } from 'vitest'
import { StripeWebhookError, verifyStripeWebhook } from '../../src/modules/billing/stripe-webhook.server'
import { config } from '../helpers/billing-fixtures'

const nowMs = 1_800_000_000_000
const nowSeconds = nowMs / 1000
const checkout = { id: 'cs_test_fixture', object: 'checkout.session', customer: 'cus_fixture',
  subscription: 'sub_fixture', payment_intent: 'pi_fixture' }
function event(object: Schema.JsonObject = checkout, type = 'checkout.session.completed', changes: Schema.JsonObject = {}) {
  return { id: 'evt_fixture', object: 'event', api_version: config.apiVersion, created: nowSeconds,
    livemode: false, type, data: { object }, ...changes }
}
function signed(payload: string, timestamp = nowSeconds) {
  return { raw: Buffer.from(payload), signature: Stripe.webhooks.generateTestHeaderString({
    payload, secret: Redacted.value(config.webhookSecret), timestamp }) }
}
function verify(object: Schema.JsonObject = checkout, type = 'checkout.session.completed', changes: Schema.JsonObject = {}) {
  const { raw, signature } = signed(JSON.stringify(event(object, type, changes)))
  return verifyStripeWebhook(config, raw, signature, nowMs)
}

const projections: ReadonlyArray<{ type: string; object: Schema.JsonObject; subscriptionId: string | null;
  paymentIntentId: string | null; chargeId: string | null; riskId: string | null }> = [
  { type: 'checkout.session.completed', object: checkout, subscriptionId: 'sub_fixture', paymentIntentId: 'pi_fixture', chargeId: null, riskId: null },
  { type: 'checkout.session.async_payment_succeeded', object: checkout, subscriptionId: 'sub_fixture', paymentIntentId: 'pi_fixture', chargeId: null, riskId: null },
  { type: 'checkout.session.async_payment_failed', object: checkout, subscriptionId: 'sub_fixture', paymentIntentId: 'pi_fixture', chargeId: null, riskId: null },
  ...['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].map(type => ({
    type, object: { id: 'sub_fixture', object: 'subscription', customer: 'cus_fixture' },
    subscriptionId: 'sub_fixture', paymentIntentId: null, chargeId: null, riskId: null })),
  ...['invoice.paid', 'invoice.payment_failed'].map(type => ({ type,
    object: { id: 'in_fixture', object: 'invoice', customer: 'cus_fixture', subscription: 'sub_legacy',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_fixture' } } },
    subscriptionId: 'sub_fixture', paymentIntentId: null, chargeId: null, riskId: null })),
  { type: 'charge.refunded', object: { id: 'ch_fixture', object: 'charge', customer: 'cus_fixture', payment_intent: 'pi_fixture' },
    subscriptionId: null, paymentIntentId: 'pi_fixture', chargeId: 'ch_fixture', riskId: null },
]
test.each(projections)('projects only signed $type trigger references', ({ type, object, ...references }) => {
  const result = verify({ ...object, metadata: { private: 'never-project' } }, type)
  expect(result).toEqual({ id: 'evt_fixture', type, created: nowSeconds, objectId: object.id,
    objectType: object.object, projectionVersion: 1, environment: 'sandbox', accountId: 'acct_fixture',
    references: { customerId: 'cus_fixture', ...references } })
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.references)).toBe(true)
})

test.each(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'radar.early_fraud_warning.created'])(
  'checks repeated expanded PaymentIntent and Customer identities for %s', type => {
    const warning = type.startsWith('radar.')
    const object = { id: warning ? 'issfr_fixture' : 'dp_fixture', object: warning ? 'radar.early_fraud_warning' : 'dispute',
      charge: { id: 'ch_fixture', object: 'charge', livemode: false, customer: 'cus_fixture',
        payment_intent: { id: 'pi_fixture', object: 'payment_intent', customer: 'cus_fixture' } },
      payment_intent: { id: 'pi_fixture', object: 'payment_intent', customer: 'cus_fixture' } }
    expect(verify(object, type).references).toEqual({ customerId: null, subscriptionId: null,
      paymentIntentId: 'pi_fixture', chargeId: 'ch_fixture', riskId: warning ? 'issfr_fixture' : 'dp_fixture' })
    expect(() => verify({ ...object, payment_intent: { ...object.payment_intent, customer: 'cus_other' } }, type)).toThrow(StripeWebhookError)
    expect(() => verify({ ...object, payment_intent: 'pi_other' }, type)).toThrow(StripeWebhookError)
    expect(() => verify({ ...object, charge: null }, type)).toThrow(StripeWebhookError)
  })

test('accepts coherent expanded Checkout identities and refuses customer or environment contradictions', () => {
  const object = { ...checkout, customer: { id: 'cus_fixture', object: 'customer', livemode: false },
    subscription: { id: 'sub_fixture', object: 'subscription', customer: 'cus_fixture', livemode: false },
    payment_intent: { id: 'pi_fixture', object: 'payment_intent', customer: 'cus_fixture', livemode: false } }
  expect(verify(object).references).toEqual({ customerId: 'cus_fixture', subscriptionId: 'sub_fixture',
    paymentIntentId: 'pi_fixture', chargeId: null, riskId: null })
  expect(() => verify({ ...object, subscription: { ...object.subscription, customer: 'cus_other' } })).toThrow(StripeWebhookError)
  expect(() => verify({ ...object, customer: { ...object.customer, livemode: true } })).toThrow(StripeWebhookError)
  expect(() => verify({ ...object, customer: { ...object.customer, object: 'subscription' } })).toThrow(StripeWebhookError)
})

test('reads Invoice subscription only from its typed parent and checks expanded customer identity', () => {
  const invoice = { id: 'in_fixture', object: 'invoice', customer: 'cus_fixture', subscription: 'sub_legacy' }
  expect(verify(invoice, 'invoice.paid').references.subscriptionId).toBeNull()
  expect(verify({ ...invoice, parent: { type: 'quote_details' } }, 'invoice.paid').references.subscriptionId).toBeNull()
  expect(() => verify({ ...invoice, parent: { type: 'subscription_details', subscription_details: {
    subscription: { id: 'sub_fixture', object: 'subscription', customer: 'cus_other' } } } }, 'invoice.paid')).toThrow(StripeWebhookError)
  expect(() => verify({ ...invoice, parent: [] }, 'invoice.paid')).toThrow(StripeWebhookError)
})

const rejectedEnvelopes: ReadonlyArray<Schema.JsonObject> = [{ api_version: 'wrong' }, { livemode: true },
  { account: null }, { context: null }, { type: 'customer.created' }, { data: { object: [] } }, { created: -1 }]
test.each(rejectedEnvelopes)(
  'refuses a signed envelope outside the adopted account, version or event contract %#', changes => {
    expect(() => verify(checkout, 'checkout.session.completed', changes)).toThrow(StripeWebhookError)
  })

test('verifies the raw bytes and signature age before parsing trigger fields', () => {
  const payload = JSON.stringify(event())
  const { raw, signature } = signed(payload)
  expect(verifyStripeWebhook(config, raw, signature, nowMs).id).toBe('evt_fixture')
  expect(() => verifyStripeWebhook(config, Buffer.from(` ${payload}`), signature, nowMs)).toThrow(StripeWebhookError)
  const stale = signed(payload, nowSeconds - 301)
  expect(() => verifyStripeWebhook(config, stale.raw, stale.signature, nowMs)).toThrow(StripeWebhookError)
  expect(() => verifyStripeWebhook(config, raw, `${signature}${'x'.repeat(8192)}`, nowMs)).toThrow(StripeWebhookError)
})

test('accepts exactly the raw body byte budget and rejects its next byte', () => {
  const payload = JSON.stringify(event())
  const atLimit = payload + ' '.repeat(256 * 1024 - Buffer.byteLength(payload))
  const allowed = signed(atLimit), excess = signed(`${atLimit} `)
  expect(verifyStripeWebhook(config, allowed.raw, allowed.signature, nowMs).id).toBe('evt_fixture')
  expect(() => verifyStripeWebhook(config, excess.raw, excess.signature, nowMs)).toThrow(StripeWebhookError)
})
