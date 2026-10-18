import { createHash } from 'node:crypto'
import { Redacted } from 'effect'
import type { StripeConfig } from '../../src/modules/billing/stripe-config.server'
import Stripe from 'stripe'

export const config: StripeConfig = { apiKey: Redacted.make('sk_test_fixture'), webhookSecret: Redacted.make('whsec_fixture'),
  accountId: 'acct_fixture', environment: 'sandbox', origin: 'https://sparra.example', apiVersion: '2026-09-30.endive' }
export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const termsA = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspaceId, environment: 'sandbox' as const,
  accountId: 'acct_fixture', revision: 1, monthlyPriceId: 'price_negotiatedA', currency: 'eur', monthlyUnitAmount: 1500 }
export const termsB = { ...termsA, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 2, monthlyPriceId: 'price_negotiatedB', monthlyUnitAmount: 2900 }
export const at = new Date('2026-10-01T00:00:00Z')
export const customer = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', workspaceId, environment: 'sandbox' as const,
  accountId: 'acct_fixture', stripeCustomerId: 'cus_fixture', knownSubscriptionId: null, createdAt: at }
export const admittedBody = JSON.stringify({ mode: 'subscription', ui_mode: 'hosted_page', customer: 'cus_fixture',
  client_reference_id: operationId, integration_identifier: 'template_ABCDEFGH', line_items: [{ price: 'price_negotiatedA', quantity: 1 }],
  currency: 'eur', subscription_data: { billing_mode: { type: 'flexible' } },
  success_url: 'https://sparra.example/billing?session_id={CHECKOUT_SESSION_ID}', cancel_url: 'https://sparra.example/billing?checkout=cancelled' })
export const checkoutOperation = { id: operationId, workspaceId, kind: 'CHECKOUT_CREATE' as const, phase: 'UNKNOWN' as const,
  environment: 'sandbox' as const, accountId: 'acct_fixture', apiVersion: '2026-09-30.endive', idempotencyKey: `checkout:${operationId}`,
  requestHash: createHash('sha256').update(admittedBody).digest('hex'), customerId: 'cus_fixture', agreedTermsId: termsA.id,
  monthlyPriceId: 'price_negotiatedA', onboardingPriceId: null, currency: 'eur', monthlyUnitAmount: 1500, onboardingUnitAmount: null,
  integrationIdentifier: 'template_ABCDEFGH', checkoutReferenceVersion: 'operation-v2' as const, stripeObjectId: null,
  checkoutUrl: null, checkoutExpiresAt: null, createdAt: at, updatedAt: at }

export function monthlyPrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return { id: 'price_negotiatedA', object: 'price', active: true, livemode: false, currency: 'eur', unit_amount: 1500,
    unit_amount_decimal: Stripe.Decimal.from('1500'), type: 'recurring', billing_scheme: 'per_unit', created: 1790812800, custom_unit_amount: null,
    lookup_key: null, metadata: {}, nickname: null, product: 'prod_fixture', tax_behavior: 'unspecified', tiers_mode: null,
    transform_quantity: null, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null, trial_period_days: null }, ...overrides }
}
