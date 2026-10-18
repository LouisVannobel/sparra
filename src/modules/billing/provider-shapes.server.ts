import type Stripe from 'stripe'

// Called only after each consumer's object guard. Keep five-page traversal,
// row IDs, exhaustion, cycles and caller-specific URL policies at the call site.
export function hasBoundedBillingPageData<T>(page: { data: T[]; has_more: boolean }): boolean {
  return !(!Array.isArray(page.data) || page.data.length > 100
    || typeof page.has_more !== 'boolean' || page.has_more && page.data.length === 0)
}

type BalanceTransaction = Pick<Stripe.CustomerBalanceTransaction,
  'id' | 'object' | 'amount' | 'created' | 'currency' | 'customer' |
  'customer_account' | 'ending_balance' | 'livemode' | 'type'>

// Admission of the shared scalar DTO prefix only. References and relevance to
// an Invoice remain caller policies; this never establishes paid authority.
export function hasCustomerBalanceTransactionScalars(row: BalanceTransaction,
  customerId: string, expectedLive: boolean): boolean {
  return !(row.object !== 'customer_balance_transaction' || !/^cbtxn_[A-Za-z0-9]+$/.test(row.id)
    || row.livemode !== expectedLive || idOf(row.customer) !== customerId
    || row.customer_account !== null || !Number.isSafeInteger(row.amount)
    || !Number.isSafeInteger(row.ending_balance)
    || !Number.isSafeInteger(row.created) || row.created < 0
    || !/^[a-z]{3}$/.test(row.currency) || typeof row.type !== 'string' || row.type.length === 0)
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' ? value
    : value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : null
}
