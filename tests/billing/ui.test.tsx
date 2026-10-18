import { existsSync } from 'node:fs'
import type { ComponentType } from 'react'
import { expect, test, vi } from 'vitest'
import type { BillingSummary } from '../../src/modules/billing/checkout.server'
import type { WorkspaceDto } from '../../src/modules/workspaces/personal.server'
import { AppShell } from '../../src/ui/sparra/app-shell'
import { renderPrivatePanel } from '../helpers/private-panel-router'

type Props = Readonly<{
  locale: 'fr' | 'en'; workspace: WorkspaceDto | null; summary: BillingSummary | null
  pending: boolean; failed: boolean
  onCheckout(): Promise<void>; onCancel(): Promise<void>; onRefresh(): Promise<void>
}>
const source = new URL('../../src/ui/billing/billing-panel.tsx', import.meta.url)
// Only the missing feature produces an empty panel for the positive assertion.
// Once it exists, genuine module/render failures remain failures.
const candidate = existsSync(source)
  ? await vi.importActual<{ BillingPanel: ComponentType<Props> }>('../../src/ui/billing/billing-panel') : null
const workspace = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Atelier <script>privateMarker=1</script>' }
const initial: BillingSummary = { availability: 'available', state: 'not-started', paidThrough: null, cancellation: 'none' }
const paid: BillingSummary = { availability: 'available', state: 'paid', paidThrough: '2030-11-16T12:00:00.000Z', cancellation: 'none' }
const forbidden = async (): Promise<never> => { throw new Error('SSR must not invoke a billing action') }
async function render(overrides: Partial<Props> = {}) {
  const props: Props = { locale: 'fr', workspace, summary: initial, pending: false, failed: false,
    onCheckout: forbidden, onCancel: forbidden, onRefresh: forbidden, ...overrides }
  const Panel = candidate?.BillingPanel
  return renderPrivatePanel(<AppShell locale={props.locale}>{Panel && <Panel {...props}/>}</AppShell>, `/billing?lang=${props.locale}`)
}

test.each(['fr','en'] as const)('billing %s stays in one private landmark with localized navigation and a disabled SSR payment action', async locale => {
  const html = await render({ locale })
  expect(html).toMatch(new RegExp(`<h1\\b[^>]*>[\\s\\S]*?${locale === 'fr' ? 'Facturation' : 'Billing'}`))
  expect(html.match(/<main\b/g)).toHaveLength(1)
  expect(html).toContain('id="app-content"')
  expect(html).toContain('href="#app-content"')
  expect(html).toContain(`href="/billing?lang=${locale}"`)
  const navigation = html.match(/<nav\b[^>]*class="sparra-app-nav"[\s\S]*?<\/nav>/)?.[0] ?? ''
  const active = navigation.match(/<a\b[^>]*aria-current="page"[^>]*>/g) ?? []
  expect(active).toHaveLength(1)
  expect(active[0]).toContain(`href="/billing?lang=${locale}"`)
  expect(html).toContain(locale === 'fr' ? 'Abonnement mensuel' : 'Monthly subscription')
  const action = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
  expect(action).toContain(locale === 'fr' ? 'Continuer vers le paiement' : 'Continue to payment')
  expect(action).toContain('disabled')
  expect(html).not.toContain('<time')
  expect(html).not.toMatch(/\d+[,.]\d{2}\s*[€$]|price_|cus_|acct_/)
})

test.each(['fr','en'] as const)('unavailable billing %s explains negotiated pricing without a numeric amount or financial control', async locale => {
  const html = await render({ locale, summary: { availability: 'unavailable', state: 'unavailable', paidThrough: null, cancellation: 'none' } })
  expect(html).toContain(locale === 'fr' ? 'Le paiement n’est pas encore disponible pour cet espace.' : 'Payment is not yet available for this workspace.')
  expect(html).toContain(locale === 'fr' ? 'Votre tarif est convenu avec votre interlocuteur commercial.' : 'Your price is agreed with your sales representative.')
  expect(html).toContain(locale === 'fr' ? 'Actualiser' : 'Refresh')
  expect(html).not.toContain(locale === 'fr' ? 'Continuer vers le paiement' : 'Continue to payment')
  expect(html).not.toContain(locale === 'fr' ? 'Annuler à l’échéance' : 'Cancel at period end')
  expect(html).not.toContain('<time')
  expect(html).not.toMatch(/mailto:|price_|\d+[,.]\d{2}\s*[€$]/)
})

test.each(['fr','en'] as const)('null Workspace %s offers navigation without creation or billing mutation', async locale => {
  const html = await render({ locale, workspace: null, summary: null })
  expect(html).toContain(locale === 'fr' ? 'Créez votre espace' : 'Create your workspace')
  expect(html).toContain(`href="/workspace?lang=${locale}"`)
  expect(html).not.toContain('<button')
  expect(html).not.toContain('<form')
})

test.each(['customer-pending','checkout-pending','incident','held'] as const)('unresolved state %s offers refresh without a replacement payment or cancellation', async state => {
  const html = await render({ summary: { ...initial, state } })
  expect(html).toContain('Actualiser')
  expect(html).toContain(state === 'incident' || state === 'held' ? 'role="alert"' : 'role="status"')
  expect(html).not.toContain('Continuer vers le paiement')
  expect(html).not.toContain('Reprendre le paiement')
  expect(html).not.toContain('Annuler à l’échéance')
  expect(html).not.toContain('<time')
})

test('a retained Checkout is resumed without presenting it as paid', async () => {
  const html = await render({ locale: 'en', summary: { ...initial, state: 'checkout-ready' } })
  expect(html).toContain('Resume payment')
  expect(html).not.toContain('Continue to payment')
  expect(html).not.toContain('<time')
  expect(html).not.toContain('Your paid period is confirmed.')
})

test.each(['paid','subscription-present'] as const)('state %s offers cancellation and shows only the persisted paid-through value', async state => {
  const html = await render({ locale: 'en', summary: { ...paid, state, paidThrough: state === 'paid' ? paid.paidThrough : null } })
  expect(html).toContain('Cancel at period end')
  expect(html).not.toContain('Continue to payment')
  if (state === 'paid') expect(html).toMatch(/<time\b[^>]*datetime="2030-11-16T12:00:00.000Z"/i)
  else { expect(html).not.toContain('<time'); expect(html).not.toContain('Your paid period is confirmed.') }
})

test.each(['pending','incident','confirmed'] as const)('cancellation %s cannot be repeated and retains only the real paid-through date', async cancellation => {
  const html = await render({ locale: 'en', summary: { ...paid, cancellation } })
  expect(html).toContain('Refresh')
  expect(html).not.toContain('Cancel at period end')
  expect(html).not.toContain('Continue to payment')
  expect(html).toMatch(/<time\b[^>]*datetime="2030-11-16T12:00:00.000Z"/i)
  expect(html).toContain(cancellation === 'incident' ? 'role="alert"' : 'role="status"')
  if (cancellation === 'confirmed') expect(html).toContain('Cancellation request confirmed')
})

test('billing escapes the current display name without rendering selectors, provider IDs or secret fields', async () => {
  const extra = { ...paid, customerId: 'cus_privateMarker', priceId: 'price_privateMarker', accountId: 'acct_privateMarker',
    apiKey: 'sk_test_privateMarker', idempotencyKey: 'checkout:privateMarker' }
  const html = await render({ summary: extra })
  expect(html).toContain('Atelier &lt;script&gt;privateMarker=1&lt;/script&gt;')
  expect(html).not.toContain('<script>privateMarker')
  for (const value of [workspace.id,'cus_privateMarker','price_privateMarker','acct_privateMarker','sk_test_privateMarker','checkout:privateMarker']) expect(html).not.toContain(value)
})

test('pending billing is busy without an invented failure and every rendered control stays disabled', async () => {
  const html = await render({ pending: true })
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('role="status"')
  expect(html).not.toContain('role="alert"')
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)]
  expect(buttons.length).toBeGreaterThan(0)
  for (const button of buttons) expect(button[1]).toContain('disabled')
})
