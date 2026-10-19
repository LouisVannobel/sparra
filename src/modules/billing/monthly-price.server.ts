import type Stripe from 'stripe'

// Shared by native Checkout admission and the trusted operator assignment.
export function matchesMonthlyPrice(price: Stripe.Price, id: string, live: boolean, currency: string, amount: number): boolean {
  return price !== null && price.object === 'price' && price.id === id && price.livemode === live && price.active === true
    && /^[a-z]{3}$/.test(currency) && price.currency === currency && typeof price.unit_amount === 'number'
    && Number.isSafeInteger(price.unit_amount) && price.unit_amount > 0 && price.unit_amount === amount
    && price.type === 'recurring' && price.billing_scheme === 'per_unit' && price.recurring?.interval === 'month'
    && price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed'
    && price.recurring.meter == null && price.transform_quantity == null && price.custom_unit_amount == null
}
