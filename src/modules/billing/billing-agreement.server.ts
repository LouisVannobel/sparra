import { Schema } from 'effect'

export class BillingStoreError extends Error {
  constructor() { super('Billing reconciliation unavailable'); this.name = 'BillingStoreError' }
}
export const billingUuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
export const billingNatural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const billingPositive = billingNatural.check(Schema.isGreaterThan(0))
const id = (prefix: string) => Schema.String.check(Schema.isMaxLength(255), Schema.isPattern(new RegExp(`^${prefix}_[A-Za-z0-9]+$`)))
export const billingIds = { invoice: id('in'), charge: id('ch'), intent: id('pi'), customer: id('cus'), subscription: id('sub'),
  price: id('price'), dispute: id('(dp|du)'), warning: id('issfr'), allocation: id('inpay'), account: id('acct'), event: id('evt') }
const currency = Schema.String.check(Schema.isPattern(/^[a-z]{3}$/))
export const billingHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const billingEnvironment = Schema.Literals(['sandbox', 'live'])
export const bounded = <S extends Schema.Top>(item: S) => Schema.Array(item).check(Schema.isMaxLength(500))
export function decodeBilling<A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A {
  try { return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: 'error' }) }
  catch { throw new BillingStoreError() }
}
const bindingSchema = Schema.Struct({ chargeId: billingIds.charge, paymentIntentId: billingIds.intent, invoiceId: billingIds.invoice })
export type ObservedChargeBinding = typeof bindingSchema.Type
export const observationInputSchema = Schema.Struct({
  candidateInvoiceIds: bounded(billingIds.invoice).check(Schema.isMinLength(1)), paymentEdges: bounded(bindingSchema),
})
export type BillingObservationInput = typeof observationInputSchema.Type
export const targetProgressSchema = Schema.Struct({ invoiceId: billingIds.invoice, identityValidated: Schema.Boolean,
  requiredWorkRevision: billingPositive, requiresMonetary: Schema.Boolean, requiresRisk: Schema.Boolean,
  monetarySettlement: Schema.NullOr(Schema.Struct({ revision: billingPositive,
    disposition: Schema.Literals(['applied', 'duplicate', 'held', 'observed-no-grant']), agreementId: Schema.NullOr(billingUuid) })),
  riskSettlement: Schema.NullOr(Schema.Struct({ revision: billingPositive, disposition: Schema.Literals(['held', 'risk-recorded']),
    riskObservationIds: bounded(billingUuid) })),
})
const boundInvoiceSchema = Schema.Struct({ environment: billingEnvironment, accountId: billingIds.account,
  customerId: billingIds.customer, subscriptionId: billingIds.subscription, invoiceId: billingIds.invoice,
  agreedTermsId: billingUuid, monthlyPriceId: billingIds.price, currency, expectedAmount: billingPositive, periodStart: billingPositive, periodEnd: billingPositive,
  firstPeriod: Schema.optionalKey(Schema.Boolean),
  onboarding: Schema.optionalKey(Schema.NullOr(Schema.Struct({ priceId: billingIds.price, amount: billingPositive }))),
})
export const lineageSchema = Schema.Struct({ operationId: billingUuid, workspaceId: billingUuid, environment: billingEnvironment,
  accountId: billingIds.account, customerId: billingIds.customer,
  checkoutSessionId: Schema.String.check(Schema.isMaxLength(255), Schema.isPattern(/^cs_(test|live)_[A-Za-z0-9]+$/)),
  subscriptionId: billingIds.subscription, invoiceId: billingIds.invoice, boundInvoice: boundInvoiceSchema,
})
export const observationSchema = Schema.Struct({ lineage: lineageSchema, chargeIds: bounded(billingIds.charge),
  riskRevisions: bounded(Schema.Struct({ chargeId: billingIds.charge, revision: billingNatural })),
  expectedAgreementVersion: billingNatural, expectedCurrentAgreementId: Schema.NullOr(billingUuid),
  manifestRevision: billingNatural, manifestReady: Schema.Boolean, paymentEdges: bounded(bindingSchema),
})
export type BillingObservation = typeof observationSchema.Type
// The existing positive monetary primitive's limits and accepted subset remain
// its responsibility; these fields are decoded without introducing a new cap.
const paidSchema = Schema.Struct({ invoiceId: billingIds.invoice, subscriptionId: billingIds.subscription,
  customerId: billingIds.customer, currency, amount: billingPositive, periodStart: billingPositive, periodEnd: billingPositive,
  allocationIds: Schema.Array(billingIds.allocation), paymentIntentIds: Schema.Array(billingIds.intent), chargeIds: Schema.Array(billingIds.charge),
})
const unpaidSchema = Schema.Struct({ kind: Schema.Literal('unpaid-invoice'), invoiceId: billingIds.invoice,
  customerId: billingIds.customer, subscriptionId: billingIds.subscription, currency, status: Schema.Literals(['open', 'uncollectible']),
  amountDue: billingPositive, amountPaid: Schema.Literal(0), amountRemaining: billingPositive,
  periodStart: billingPositive, periodEnd: billingPositive, invoicePaymentIds: bounded(billingIds.allocation), observationDigest: billingHash,
})
export type UnpaidInvoiceObservation = typeof unpaidSchema.Type
export const decisionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('paid'), proof: paidSchema }),
  Schema.Struct({ kind: Schema.Literal('observedNoGrant'), evidence: unpaidSchema }),
  Schema.Struct({ kind: Schema.Literal('unresolved') }),
])
export type BillingApplyDecision = typeof decisionSchema.Type
export const riskFactsSchema = Schema.Struct({
  chargeObservations: bounded(Schema.Struct({ chargeId: billingIds.charge, paymentIntentId: billingIds.intent,
    customerId: billingIds.customer, currency, amountRefunded: billingNatural, refunded: Schema.Boolean, disputed: Schema.Boolean,
    stripeFraudReport: Schema.NullOr(Schema.Literal('fraudulent')), userFraudReport: Schema.NullOr(Schema.Literals(['fraudulent', 'safe'])) })),
  disputes: bounded(Schema.Struct({ riskId: billingIds.dispute, chargeId: billingIds.charge, paymentIntentId: Schema.NullOr(billingIds.intent),
    status: Schema.Literals(['lost', 'needs_response', 'prevented', 'under_review', 'warning_closed', 'warning_needs_response', 'warning_under_review', 'won']) })),
  earlyFraudWarnings: bounded(Schema.Struct({ riskId: billingIds.warning, chargeId: billingIds.charge,
    paymentIntentId: Schema.NullOr(billingIds.intent), actionable: Schema.Boolean })),
})
export type VerifiedRiskFacts = typeof riskFactsSchema.Type
const effectResultSchema = Schema.Struct({ targetDisposition: Schema.Literals([
  'applied', 'duplicate', 'held', 'observed-no-grant', 'risk-recorded', 'stale', 'incomplete', 'unresolved',
]), commandCompleted: Schema.Boolean })
export type BillingEffectResult = typeof effectResultSchema.Type
export function decodeBillingResult(value: unknown): BillingEffectResult {
  const result = decodeBilling(effectResultSchema, value)
  if (result.commandCompleted && ['stale', 'incomplete', 'unresolved'].includes(result.targetDisposition)) throw new BillingStoreError()
  return result
}
