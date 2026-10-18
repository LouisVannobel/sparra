import { expect, test } from 'vitest'
import { readStripeConfig } from '../../src/modules/billing/stripe-config.server'

const provider = { STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox', APP_ORIGIN: 'https://sparra.example' }

test('provider configuration is complete without a global commercial Price', () => {
  expect(readStripeConfig(provider)).toMatchObject({ accountId: 'acct_fixture', environment: 'sandbox' })
  expect(readStripeConfig(provider)).not.toHaveProperty('monthlyPriceId')
  expect(readStripeConfig(provider)).not.toHaveProperty('onboardingPriceId')
})
test('an absent provider is unavailable and a partial provider is rejected', () => {
  expect(readStripeConfig({})).toBeNull()
  expect(() => readStripeConfig({ STRIPE_ACCOUNT_ID: 'acct_fixture' })).toThrow()
  expect(() => readStripeConfig({ ...provider, STRIPE_API_KEY: 'sk_live_fixture' })).toThrow()
})
