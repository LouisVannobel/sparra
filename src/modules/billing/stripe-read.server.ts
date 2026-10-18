import type { StripeConfig } from './stripe-config.server'
import { createStripeReadMethods } from './stripe.server'
import { createStripeTransport } from './stripe-transport.server'

export function createStripeReadClient(config: StripeConfig, signal: AbortSignal, deadlineAtMs: number) {
  const transport = createStripeTransport(config, signal, deadlineAtMs)
  const reads = createStripeReadMethods(config, transport.stripe)
  return Object.freeze({
    retrieveInvoice: (id: string) => transport.owned(() => reads.retrieveInvoice(id)),
    retrieveSubscription: (id: string) => transport.owned(() => reads.retrieveSubscription(id)),
    retrievePaymentIntent: (id: string) => transport.owned(() => reads.retrievePaymentIntent(id)),
    retrieveCharge: (id: string) => transport.owned(() => reads.retrieveCharge(id)),
    listInvoicePayments: (id: string, cursor?: string) => transport.owned(() => reads.listInvoicePayments(id, cursor)),
    listCustomerBalanceTransactions: (id: string, cursor?: string) => transport.owned(() => reads.listCustomerBalanceTransactions(id, cursor)),
    retrieveCheckoutSession: (id: string) => transport.owned(() => reads.retrieveCheckoutSession(id)),
    listCheckoutSessions: (subscriptionId: string, customerId: string, cursor?: string) => transport.owned(() => reads.listCheckoutSessions(subscriptionId, customerId, cursor)),
    listCheckoutLineItems: (id: string, cursor?: string) => transport.owned(() => reads.listCheckoutLineItems(id, cursor)),
    listInvoicePaymentsForPaymentIntent: (id: string, cursor?: string) => transport.owned(() => reads.listInvoicePaymentsForPaymentIntent(id, cursor)),
    retrieveDispute: (id: string) => transport.owned(() => reads.retrieveDispute(id)),
    listDisputes: (id: string, cursor?: string) => transport.owned(() => reads.listDisputes(id, cursor)),
    retrieveEarlyFraudWarning: (id: string) => transport.owned(() => reads.retrieveEarlyFraudWarning(id)),
    listEarlyFraudWarnings: (id: string, cursor?: string) => transport.owned(() => reads.listEarlyFraudWarnings(id, cursor)),
    close: transport.close,
  })
}

export type StripeReadClient = ReturnType<typeof createStripeReadClient>
