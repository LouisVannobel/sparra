import type { VerifiedStripeEvent } from './stripe-webhook.server'

type EventKind = 'checkout' | 'subscription' | 'invoice' | 'charge' | 'dispute' | 'early_fraud_warning'
type Rule = Readonly<{ objectType: string; idPattern: RegExp; kind: EventKind }>

const checkout: Rule = { objectType: 'checkout.session', idPattern: /^cs_(?:test|live)_[A-Za-z0-9]+$/, kind: 'checkout' }
const subscription: Rule = { objectType: 'subscription', idPattern: /^sub_[A-Za-z0-9]+$/, kind: 'subscription' }
const invoice: Rule = { objectType: 'invoice', idPattern: /^in_[A-Za-z0-9]+$/, kind: 'invoice' }
const charge: Rule = { objectType: 'charge', idPattern: /^ch_[A-Za-z0-9]+$/, kind: 'charge' }
const dispute: Rule = { objectType: 'dispute', idPattern: /^(dp|du)_[A-Za-z0-9]+$/, kind: 'dispute' }
const earlyFraudWarning: Rule = {
  objectType: 'radar.early_fraud_warning', idPattern: /^issfr_[A-Za-z0-9]+$/, kind: 'early_fraud_warning',
}
const rules: Readonly<Record<string, Rule>> = Object.freeze({
  'checkout.session.completed': checkout,
  'checkout.session.async_payment_succeeded': checkout,
  'checkout.session.async_payment_failed': checkout,
  'customer.subscription.created': subscription,
  'customer.subscription.updated': subscription,
  'customer.subscription.deleted': subscription,
  'invoice.paid': invoice,
  'invoice.payment_failed': invoice,
  'charge.refunded': charge,
  'charge.dispute.created': dispute,
  'charge.dispute.updated': dispute,
  'charge.dispute.closed': dispute,
  'radar.early_fraud_warning.created': earlyFraudWarning,
})

class BillingEventError extends Error {
  constructor() { super('Billing event rejected'); this.name = 'BillingEventError' }
}

// The signed snapshot is a trigger. Its type/object pair only selects the
// exact first-class object to retrieve; it never establishes ownership,
// payment, temporal priority, or a Workspace entitlement.
export function classifyBillingEvent(
  event: Pick<VerifiedStripeEvent, 'id' | 'type' | 'objectId' | 'objectType'>,
): Readonly<{ kind: EventKind; id: string }> {
  if (!event || typeof event !== 'object' || !/^evt_[A-Za-z0-9]+$/.test(event.id)) throw new BillingEventError()
  const rule = rules[event.type]
  if (!rule || event.objectType !== rule.objectType || !rule.idPattern.test(event.objectId)) throw new BillingEventError()
  return Object.freeze({ kind: rule.kind, id: event.objectId })
}
