import { expect, test } from 'vitest'
import { buildCheckoutParameters } from '../../src/modules/billing/stripe.server'
import { config } from '../helpers/billing-fixtures'

const intent = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'cus_fixture',
  idempotencyKey: 'checkout:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', integrationIdentifier: 'template_ABCDEFGH',
  operationReference: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  terms: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', monthlyPriceId: 'price_negotiatedA', currency: 'eur', monthlyUnitAmount: 1500 } }

test('Checkout sends exactly its admitted Price, quantity one and explicit currency', () => {
  expect(buildCheckoutParameters(config, intent)).toEqual({ mode: 'subscription', ui_mode: 'hosted_page',
    customer: 'cus_fixture', client_reference_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    integration_identifier: 'template_ABCDEFGH', line_items: [{ price: 'price_negotiatedA', quantity: 1 }],
    currency: 'eur', subscription_data: { billing_mode: { type: 'flexible' } },
    success_url: 'https://sparra.example/billing?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://sparra.example/billing?checkout=cancelled' })
})
test.each([
  { ...intent.terms, monthlyPriceId: 'prod_wrong' }, { ...intent.terms, monthlyUnitAmount: 0 },
  { ...intent.terms, currency: 'EUR' }, { ...intent.terms, monthlyUnitAmount: Number.MAX_SAFE_INTEGER + 1 },
  { ...intent.terms, price_data: {} },
])('rejects malformed operation terms before constructing a provider request %#', terms => {
  expect(() => buildCheckoutParameters(config, { ...intent, terms })).toThrow()
})
