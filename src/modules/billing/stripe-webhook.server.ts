import Stripe from 'stripe'
import { Redacted, Schema } from 'effect'
import { classifyBillingEvent } from './events.server'
import type { StripeConfig } from './stripe-config.server'

export type StripeEventReferences = Readonly<{
  customerId: string | null
  subscriptionId: string | null
  paymentIntentId: string | null
  chargeId: string | null
  riskId: string | null
}>

export type VerifiedStripeEvent = Readonly<{
  id: string
  type: string
  created: number
  objectId: string
  objectType: string
  projectionVersion: 1
  environment: StripeConfig['environment']
  accountId: string
  references: StripeEventReferences
}>

export class StripeWebhookError extends Error {
  constructor() { super('Stripe webhook rejected'); this.name = 'StripeWebhookError' }
}

function isRecord(value: Schema.Json | undefined): value is Schema.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type ReferenceKind = 'customer' | 'subscription' | 'payment_intent' | 'charge' | 'dispute' | 'radar.early_fraud_warning'
const referencePatterns: Readonly<Record<ReferenceKind, RegExp>> = Object.freeze({
  customer: /^cus_[A-Za-z0-9]+$/,
  subscription: /^sub_[A-Za-z0-9]+$/,
  payment_intent: /^pi_[A-Za-z0-9]+$/,
  charge: /^ch_[A-Za-z0-9]+$/,
  dispute: /^dp_[A-Za-z0-9]+$/,
  'radar.early_fraud_warning': /^issfr_[A-Za-z0-9]+$/,
})

function reference(value: Schema.Json | undefined, kind: ReferenceKind, live: boolean, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new StripeWebhookError()
    return null
  }
  if (isRecord(value) && Object.hasOwn(value, 'livemode') && value.livemode !== live) {
    throw new StripeWebhookError()
  }
  const id = typeof value === 'string' ? value : isRecord(value) && value.object === kind ? value.id : null
  if (typeof id !== 'string' || id.length > 255 || !referencePatterns[kind].test(id)) {
    throw new StripeWebhookError()
  }
  return id
}

function linkedCustomer(value: Schema.Json | undefined, live: boolean): string | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'customer')) return null
  return reference(value.customer, 'customer', live)
}

function consistentCustomers(...ids: Array<string | null>): void {
  const first = ids.find(id => id !== null)
  if (first !== undefined && ids.some(id => id !== null && id !== first)) throw new StripeWebhookError()
}

function invoiceSubscription(object: Schema.JsonObject, live: boolean,
  customerId: string | null): string | null {
  const parent = object.parent
  if (parent === undefined || parent === null) return null
  if (!isRecord(parent) || typeof parent.type !== 'string') throw new StripeWebhookError()
  if (parent.type !== 'subscription_details') return null
  if (!isRecord(parent.subscription_details)) throw new StripeWebhookError()
  const subscription = parent.subscription_details.subscription
  const subscriptionId = reference(subscription, 'subscription', live, true)
  consistentCustomers(customerId, linkedCustomer(subscription, live))
  return subscriptionId
}

function riskCharge(object: Schema.JsonObject, paymentIntentId: string | null, live: boolean): string {
  const chargeId = reference(object.charge, 'charge', live, true)!
  if (isRecord(object.charge) && Object.hasOwn(object.charge, 'payment_intent')) {
    const nestedPaymentIntentId = reference(object.charge.payment_intent, 'payment_intent', live)
    if (paymentIntentId !== null && nestedPaymentIntentId !== null
      && paymentIntentId !== nestedPaymentIntentId) throw new StripeWebhookError()
    consistentCustomers(linkedCustomer(object.charge, live),
      linkedCustomer(object.charge.payment_intent, live))
  }
  return chargeId
}

function projectReferences(kind: ReturnType<typeof classifyBillingEvent>['kind'],
  object: Schema.JsonObject, objectId: string, live: boolean): StripeEventReferences {
  let customerId: string | null = null
  let subscriptionId: string | null = null
  let paymentIntentId: string | null = null
  let chargeId: string | null = null
  let riskId: string | null = null

  switch (kind) {
    case 'checkout':
      customerId = reference(object.customer, 'customer', live)
      subscriptionId = reference(object.subscription, 'subscription', live)
      paymentIntentId = reference(object.payment_intent, 'payment_intent', live)
      consistentCustomers(customerId, linkedCustomer(object.subscription, live),
        linkedCustomer(object.payment_intent, live))
      break
    case 'subscription':
      customerId = reference(object.customer, 'customer', live)
      subscriptionId = reference(objectId, 'subscription', live, true)
      break
    case 'invoice':
      customerId = reference(object.customer, 'customer', live)
      subscriptionId = invoiceSubscription(object, live, customerId)
      break
    case 'charge':
      customerId = reference(object.customer, 'customer', live)
      paymentIntentId = reference(object.payment_intent, 'payment_intent', live)
      consistentCustomers(customerId, linkedCustomer(object.payment_intent, live))
      chargeId = reference(objectId, 'charge', live, true)
      break
    case 'dispute':
    case 'early_fraud_warning':
      paymentIntentId = reference(object.payment_intent, 'payment_intent', live)
      chargeId = riskCharge(object, paymentIntentId, live)
      consistentCustomers(linkedCustomer(object.charge, live),
        linkedCustomer(isRecord(object.charge) ? object.charge.payment_intent : null, live),
        linkedCustomer(object.payment_intent, live))
      riskId = reference(objectId, kind === 'dispute' ? 'dispute' : 'radar.early_fraud_warning', live, true)
      break
  }
  return Object.freeze({ customerId, subscriptionId, paymentIntentId, chargeId, riskId })
}

function validateWebhookInput(raw: Uint8Array, signature: string, nowMs: number) {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 256 * 1024
    || typeof signature !== 'string' || signature.length === 0 || signature.length > 8192
    || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new StripeWebhookError()
}

function checkedEventIdentity(config: StripeConfig, verified: Schema.JsonObject, id: Schema.Json | undefined,
  type: Schema.Json | undefined, created: Schema.Json | undefined) {
  if (verified.object !== 'event' || typeof id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(id)
    || verified.api_version !== config.apiVersion
    || verified.livemode !== (config.environment === 'live')
    || Object.hasOwn(verified, 'account') || Object.hasOwn(verified, 'context')
    || typeof type !== 'string'
    || typeof created !== 'number' || !Number.isSafeInteger(created) || created < 0) throw new StripeWebhookError()
  return { id, type, created }
}

function verifiedEventEnvelope(config: StripeConfig, verified: Schema.JsonObject) {
  const id = verified.id
  const type = verified.type
  const created = verified.created
  const data = verified.data
  if (!isRecord(data) || !isRecord(data.object)) throw new StripeWebhookError()
  const objectId = data.object.id
  const objectType = data.object.object
  const identity = checkedEventIdentity(config, verified, id, type, created)
  if (typeof objectId !== 'string' || objectId.length === 0 || objectId.length > 255
    || typeof objectType !== 'string' || objectType.length === 0) throw new StripeWebhookError()
  return { ...identity, objectId, objectType, object: data.object }
}

export function verifyStripeWebhook(
  config: StripeConfig,
  raw: Uint8Array,
  signature: string,
  nowMs: number,
): VerifiedStripeEvent {
  validateWebhookInput(raw, signature, nowMs)

  let verified: Schema.JsonObject
  try {
    const snapshot = Stripe.webhooks.constructEvent(
      raw, signature, Redacted.value(config.webhookSecret), 300, undefined, nowMs,
    )
    verified = Schema.decodeUnknownSync(Schema.JsonObject)(snapshot)
  } catch { throw new StripeWebhookError() }

  const { id, type, created, objectId, objectType, object } = verifiedEventEnvelope(config, verified)

  let kind: ReturnType<typeof classifyBillingEvent>['kind']
  try { kind = classifyBillingEvent({ id, type, objectId, objectType }).kind }
  catch { throw new StripeWebhookError() }
  if (Object.hasOwn(object, 'livemode')
    && object.livemode !== (config.environment === 'live')) throw new StripeWebhookError()
  const references = projectReferences(kind, object, objectId, config.environment === 'live')
  return Object.freeze({
    id, type, created, objectId, objectType,
    projectionVersion: 1, environment: config.environment, accountId: config.accountId, references,
  })
}
