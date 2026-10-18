// Synthetic read fixtures adapted from the authorized frozen Stripe source.
import Stripe from 'stripe'
import { termsA, workspaceId, operationId, monthlyPrice } from './billing-fixtures'
export const price = monthlyPrice({ active: false })
export const session = { id: 'cs_test_fixture123', object: 'checkout.session', livemode: false, mode: 'subscription',
  ui_mode: 'hosted_page', customer: 'cus_fixture', customer_account: null, subscription: 'sub_fixture123',
  invoice: 'in_fixture123', client_reference_id: operationId, integration_identifier: 'template_ABCDEFGH',
  status: 'complete', payment_status: 'paid', currency: 'eur', amount_subtotal: 1500, amount_total: 1500,
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
  metadata: { workspace_id: workspaceId }, customer_details: { email: 'fixture@example.invalid' } }
export const line = { id: 'li_fixture123', object: 'item', adjustable_quantity: null, quantity: 1, currency: 'eur',
  price, amount_subtotal: 1500, amount_total: 1500, amount_discount: 0, amount_tax: 0, metadata: null, description: null }
export const subscription = { id: 'sub_fixture123', object: 'subscription', livemode: false, customer: 'cus_fixture',
  customer_account: null, currency: 'eur', status: 'active', collection_method: 'charge_automatically',
  billing_mode: { type: 'flexible' }, latest_invoice: 'in_fixture123',
  items: { object: 'list', has_more: false, url: '/v1/subscription_items?subscription=sub_fixture123', data: [
    { id: 'si_fixture123', object: 'subscription_item', price, quantity: 1, subscription: 'sub_fixture123',
      current_period_start: 1790812800, current_period_end: 1793491200 }] } }
export const invoiceLine = { id: 'il_fixture123', object: 'line_item', livemode: false, currency: 'eur', amount: 1500,
  quantity: 1, subscription: 'sub_fixture123', period: { start: 1790812800, end: 1793491200 }, pretax_credit_amounts: [],
  parent: { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: {
    invoice_item: null, proration: false, proration_details: null, subscription: 'sub_fixture123', subscription_item: 'si_fixture123' } },
  pricing: { type: 'price_details', unit_amount_decimal: Stripe.Decimal.from('1500'), price_details: { price: termsA.monthlyPriceId, product: 'prod_fixture123' } } }
export const invoice = { id: 'in_fixture123', object: 'invoice', livemode: false, customer: 'cus_fixture', customer_account: null,
  parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: 'sub_fixture123', metadata: null } },
  currency: 'eur', status: 'paid', billing_reason: 'subscription_create', collection_method: 'charge_automatically',
  amount_due: 1500, amount_paid: 1500, total: 1500, amount_remaining: 0, amount_overpaid: 0, starting_balance: 0,
  ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
  amount_paid_off_stripe: 0, total_pretax_credit_amounts: [], period_start: 1790812800, period_end: 1793491200,
  lines: { object: 'list', has_more: false, url: '/v1/invoices/in_fixture123/lines', data: [invoiceLine] } }
export const pi = { id: 'pi_fixture123', object: 'payment_intent', livemode: false, customer: 'cus_fixture',
  currency: 'eur', status: 'succeeded', amount: 1500, amount_received: 1500, latest_charge: 'ch_fixture123' }
export const charge = { id: 'ch_fixture123', object: 'charge', livemode: false, customer: 'cus_fixture', payment_intent: 'pi_fixture123',
  currency: 'eur', status: 'succeeded', amount: 1500, amount_captured: 1500, amount_refunded: 0, captured: true,
  paid: true, disputed: false, refunded: false, fraud_details: {}, review: null, outcome: null }
export const allocation = { id: 'inpay_fixture123', object: 'invoice_payment', livemode: false, invoice: 'in_fixture123',
  payment: { type: 'payment_intent', payment_intent: 'pi_fixture123' }, amount_requested: 1500, amount_paid: 1500,
  status: 'paid', currency: 'eur', created: 1790812800, is_default: true, status_transitions: { paid_at: 1790812801, canceled_at: null } }
export const warning = { id: 'issfr_fixture123', object: 'radar.early_fraud_warning', livemode: false, charge: 'ch_fixture123',
  payment_intent: 'pi_fixture123', actionable: true, created: 1790812800, fraud_type: 'misc' }
export const list = <T>(url: string, data: T[], has_more = false) => ({ object: 'list' as const, url, data, has_more })
