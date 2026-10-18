import { existsSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, type AnyRoute } from '@tanstack/react-router'
import { resolveLocale } from '../../src/ui/auth/messages'

const rpc = vi.hoisted(() => ({ getWorkspace: vi.fn(), getBilling: vi.fn(), startBillingCheckout: vi.fn(),
  cancelBillingAtPeriodEnd: vi.fn(), ensurePersonalWorkspace: vi.fn(), renameWorkspace: vi.fn() }))
vi.mock('../../src/modules/workspaces/workspace.functions', () => rpc)
vi.mock('../../src/modules/billing/billing.functions', () => rpc)
const source = new URL('../../src/routes/billing.tsx', import.meta.url)
const candidate = existsSync(source) ? await vi.importActual<{ Route: AnyRoute }>('../../src/routes/billing') : null
const workspace = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'private-workspace-display-marker' }
const unavailable = { availability: 'unavailable', state: 'unavailable', paidThrough: null, cancellation: 'none' }
afterEach(() => vi.resetAllMocks())

function billingRouter(lang: 'fr' | 'en', suffix = '', client = false) {
  const root = createRootRoute({ validateSearch: (search: { lang?: unknown }) => ({ lang: resolveLocale(search.lang) }) })
  const paths = ['/app','/app/entreprise','/account','/workspace','/login']
  const routes: AnyRoute[] = paths.map(path => createRoute({ path, getParentRoute: () => root }))
  if (candidate) routes.push(createRoute({ ...candidate.Route.options, path: '/billing', getParentRoute: () => root }))
  return createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [`/billing?lang=${lang}${suffix}`] }), origin: 'http://localhost', isServer: !client })
}
const render = (router: ReturnType<typeof billingRouter>) => renderToString(createElement(RouterProvider, { router }))

for (const lang of ['fr','en'] as const) for (const boundary of ['Workspace','Billing'] as const) {
  for (const failure of ['returned Response','thrown Response','unexpected error'] as const) {
    test(`billing ${lang} ${boundary} ${failure} selects a redacted Router error without private markers`, async () => {
      rpc.getWorkspace.mockResolvedValue(workspace); rpc.getBilling.mockResolvedValue(unavailable)
      const call = boundary === 'Workspace' ? rpc.getWorkspace : rpc.getBilling
      const response = new Response('private-synthetic-response-marker', { status: 503 })
      if (failure === 'returned Response') call.mockResolvedValue(response)
      else call.mockRejectedValue(failure === 'thrown Response' ? response : new Error('private-synthetic-error-marker'))
      const router = billingRouter(lang)
      await router.load()
      const match = router.state.matches.find(value => value.routeId === '/billing')
      expect(match?.status).toBe('error')
      expect(match?.loaderData).toBeUndefined()
      expect(String(match?.error)).not.toContain('private-synthetic')
      const html = render(router)
      expect(html).toMatch(new RegExp(`<h1\\b[^>]*>[\\s\\S]*?${lang === 'fr' ? 'Facturation' : 'Billing'}`))
      expect(html).toContain('role="alert"')
      expect(html.match(/<main\b/g)).toHaveLength(1)
      expect(html).toContain(`href="/login?lang=${lang}"`)
      expect(html).toContain(`href="/account?lang=${lang}"`)
      expect(html).not.toContain('private-synthetic')
      expect(html).not.toContain(workspace.displayName)
      expect(html).not.toContain(workspace.id)
      expect(html).not.toContain('<time')
      expect(rpc.ensurePersonalWorkspace).not.toHaveBeenCalled()
      expect(rpc.startBillingCheckout).not.toHaveBeenCalled()
      expect(rpc.cancelBillingAtPeriodEnd).not.toHaveBeenCalled()
    })
  }
}

test.each(['fr','en'] as const)('billing %s null Workspace is a successful empty read without a hidden provisioning mutation', async lang => {
  rpc.getWorkspace.mockResolvedValue(null)
  const router = billingRouter(lang)
  await router.load()
  const match = router.state.matches.find(value => value.routeId === '/billing')
  expect(match?.status).toBe('success')
  const html = render(router)
  expect(html).toContain(lang === 'fr' ? 'Créez votre espace' : 'Create your workspace')
  expect(html).not.toContain('role="alert"')
  expect(rpc.getBilling).not.toHaveBeenCalled()
  expect(rpc.ensurePersonalWorkspace).not.toHaveBeenCalled()
})

test('forged Checkout return flags never turn a successful unavailable read into paid or cancellation confirmation', async () => {
  rpc.getWorkspace.mockResolvedValue(workspace); rpc.getBilling.mockResolvedValue(unavailable)
  const router = billingRouter('en', '&session_id=cs_test_forgedMarker&checkout=cancelled&state=paid&cancellation=confirmed')
  await router.load()
  expect(router.state.matches.find(value => value.routeId === '/billing')?.status).toBe('success')
  const html = render(router)
  expect(html).toContain('Payment is not yet available for this workspace.')
  expect(html).not.toContain('<time')
  expect(html).not.toContain('Your paid period is confirmed.')
  expect(html).not.toContain('Cancellation request confirmed')
  expect(html).not.toContain('cs_test_forgedMarker')
  expect(rpc.startBillingCheckout).not.toHaveBeenCalled()
  expect(rpc.cancelBillingAtPeriodEnd).not.toHaveBeenCalled()
})

test.each(['refused','authorized'] as const)('SPA history return keeps old billing private until the fresh %s read settles', async admission => {
  const previous = { availability: 'available', state: 'paid', paidThrough: '2030-11-16T12:00:00.000Z', cancellation: 'none' }
  rpc.getWorkspace.mockResolvedValue(workspace); rpc.getBilling.mockResolvedValue(previous)
  const router = billingRouter('en', '', true)
  await router.load()
  const visible = () => router.state.matches.filter(match => match.status === 'success').map(match => match.loaderData)
  expect(JSON.stringify(visible())).toContain(workspace.displayName)
  router.history.push('/account?lang=en'); await router.load()
  let release = () => {}, entered = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const freshWorkspace = { ...workspace, displayName: 'fresh-authorized-workspace-marker' }
  rpc.getWorkspace.mockImplementation(async () => {
    entered(); await gate
    if (admission === 'refused') return new Response('private-refused-history-marker', { status: 404 })
    return freshWorkspace
  })
  rpc.getBilling.mockResolvedValue(unavailable)
  router.history.back()
  const returning = router.load()
  try {
    await started
    // Allow the real Router to publish its cached/background match if its
    // policy permits one; the protected loader remains deliberately held.
    await new Promise<void>(resolve => setImmediate(resolve))
    const exposed = JSON.stringify(visible())
    expect(exposed).not.toContain(workspace.displayName)
    expect(exposed).not.toContain('2030-11-16T12:00:00.000Z')
    expect(router.state.matches.find(match => match.routeId === '/billing')?.status).not.toBe('success')
    release(); await returning
    const settled = JSON.stringify(visible())
    if (admission === 'refused') {
      expect(router.state.matches.find(match => match.routeId === '/billing')?.status).toBe('error')
      expect(settled).not.toContain('private-refused-history-marker')
      expect(settled).not.toContain(workspace.displayName)
    } else {
      expect(settled).toContain(freshWorkspace.displayName)
      expect(settled).toContain('unavailable')
      expect(settled).not.toContain('2030-11-16T12:00:00.000Z')
    }
  } finally { release(); await returning; router.history.destroy() }
})
