import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { Route as AppRoute } from '../../src/routes/app'
import { Route as BusinessRoute } from '../../src/routes/app.entreprise'
import type { ActivityState } from '../../src/modules/sparra/sparra.functions'
import type { CalendarState } from '../../src/modules/calendar/connection.server'
import { activityMessages, appMessages } from '../../src/modules/sparra/messages'
import { calendarMessages } from '../../src/ui/sparra/calendar-messages'
import { resolveLocale } from '../../src/ui/auth/messages'

// Keep the actual route hierarchy, panels, hooks and Router. Only request RPCs
// are replaced; rendering must never provision, save or prepare Google consent.
const rpc = vi.hoisted(() => ({ getWorkspace: vi.fn(), ensurePersonalWorkspace: vi.fn(), getActivity: vi.fn(), saveActivity: vi.fn(), confirmActivity: vi.fn(), getActivityConfirmation: vi.fn(), importKnowledgePage: vi.fn(),
  getCalendar: vi.fn(), beginCalendarConnection: vi.fn(), saveCalendarPolicy: vi.fn(), disconnectCalendar: vi.fn() }))
vi.mock('../../src/modules/workspaces/workspace.functions', () => rpc)
vi.mock('../../src/modules/sparra/sparra.functions', () => rpc)
vi.mock('../../src/modules/calendar/calendar.functions', () => rpc)

const workspace = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Route owner' }
const disconnected: CalendarState = { available: true, status: 'disconnected', accountEmail: null, selectedCalendar: null, calendars: [], enabled: false, policy: null, revision: 0 }
function activity(sector: 'garage' | 'controle-technique' | 'diagnostic-immobilier'): ActivityState {
  return { workspace, localAudioAvailable: true, configuration: { workspaceId: workspace.id, businessName: `Saved ${sector}`, sector,
    revision: 7, savedAt: '2026-10-21T10:00:00.000Z', knowledge: { openingHours: 'Saved hours', services: 'Saved services', prices: 'Saved prices', faq: 'Saved answers', instructions: 'Saved instructions' },
    transferDestination: '+33123456789', recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone: '+33987654321' } }
}
function businessRouter(lang: 'fr' | 'en', suffix = '') {
  const root = createRootRoute({ validateSearch: (search: { lang?: unknown }) => ({ lang: resolveLocale(search.lang) }) })
  const app = createRoute({ ...AppRoute.options, path: '/app', getParentRoute: () => root })
  const business = createRoute({ ...BusinessRoute.options, path: '/entreprise', getParentRoute: () => app })
  const others = ['/login', '/account', '/workspace', '/billing'].map(path => createRoute({ path, getParentRoute: () => root }))
  return createRouter({ routeTree: root.addChildren([app.addChildren([business]), ...others]),
    history: createMemoryHistory({ initialEntries: [`/app/entreprise?lang=${lang}${suffix}`] }), origin: 'http://localhost', isServer: true })
}
const render = (router: ReturnType<typeof businessRouter>) => renderToString(createElement(RouterProvider, { router })).replace(/<!-- -->/g, '')
function expectNoMutations() {
  for (const call of [rpc.ensurePersonalWorkspace, rpc.saveActivity, rpc.beginCalendarConnection, rpc.saveCalendarPolicy, rpc.disconnectCalendar]) expect(call).not.toHaveBeenCalled()
}
afterEach(() => vi.resetAllMocks())

for (const lang of ['fr', 'en'] as const) for (const sector of ['garage', 'controle-technique', 'diagnostic-immobilier'] as const) {
  test.each(['', 'returned', 'failed'] as const)(`Business ${lang} ${sector} callback=%s renders persisted Activity and the observed Calendar state without writes`, async callback => {
    const saved = activity(sector), t = activityMessages[lang], c = calendarMessages[lang]
    rpc.getWorkspace.mockResolvedValue(workspace); rpc.getActivity.mockResolvedValue(saved); rpc.getCalendar.mockResolvedValue(disconnected)
    const router = businessRouter(lang, callback ? `&calendar=${callback}` : '')
    await router.load()
    expect(router.state.matches.find(match => match.routeId === '/app/entreprise')?.status).toBe('success')
    const html = render(router)
    expect(html).toContain(`value="Saved ${sector}"`)
    for (const knowledge of Object.values(saved.configuration!.knowledge)) expect(html).toContain(`${knowledge}</textarea>`)
    expect(html).toContain('value="+33123456789"'); expect(html).toContain('value="+33987654321"')
    expect(html).toContain(`${appMessages[lang].version}: 7`)
    expect(html).toContain(t.upToDate)
    expect(html.match(/data-activity-section=/g)).toHaveLength(4)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    const selected = callback ? 'handling' : 'establishment'
    expect(html.match(new RegExp(`<div id="activity-${selected}"[^>]*>`))?.[0]).not.toContain('hidden=')
    const calendar = html.match(/<div class="sparra-guided-calendar"[^>]*>/)?.[0]
    expect(calendar?.includes('hidden=""')).toBe(callback === '')
    expect(html.match(/<h2\b[^>]*id="calendar-heading"[^>]*>/)?.[0]?.includes('tabindex="-1"')).toBe(callback !== '')
    expect(html).toContain(c.disconnected); expect(html).not.toContain(`${c.connected} : `)
    expect(html.includes(c.callbackFailed)).toBe(callback === 'failed')
    expect(html).not.toContain(t.saved)
    if(sector==='diagnostic-immobilier')expect(html).toContain(lang==='fr'?'Diagnostic immobilier':'Property diagnostics')
    else{expect(html).not.toContain('Property diagnostics');expect(html).not.toContain('Diagnostic immobilier')}
    expect(rpc.getActivity).toHaveBeenCalledOnce(); expect(rpc.getCalendar).toHaveBeenCalledOnce()
    expectNoMutations()
  })
}

test.each(['fr', 'en'] as const)('Business %s keeps the observed connected Calendar form independent on ordinary entry', async lang => {
  rpc.getWorkspace.mockResolvedValue(workspace); rpc.getActivity.mockResolvedValue(activity('garage'))
  rpc.getCalendar.mockResolvedValue({ ...disconnected, status: 'connected', accountEmail: 'observed@example.test', revision: 3 })
  const router = businessRouter(lang)
  await router.load()
  const html = render(router), calendarStart = html.indexOf('class="sparra-guided-calendar"')
  expect(html.match(/<form\b/g)).toHaveLength(2)
  expect(calendarStart).toBeGreaterThan(html.indexOf('</form>'))
  expect(html).toContain(`${calendarMessages[lang].connected} : observed@example.test`)
  expect(html.match(/<div id="activity-establishment"[^>]*>/)?.[0]).not.toContain('hidden=')
  expect(html.match(/<h2\b[^>]*id="calendar-heading"[^>]*>/)?.[0]).not.toContain('tabindex=')
  expectNoMutations()
})

test.each(['returned Response', 'thrown Response', 'unexpected error'] as const)('Business Calendar %s falls back to unavailable while preserving Activity', async failure => {
  rpc.getWorkspace.mockResolvedValue(workspace); rpc.getActivity.mockResolvedValue(activity('garage'))
  const response = new Response('private-calendar-response-marker', { status: 503 })
  if (failure === 'returned Response') rpc.getCalendar.mockResolvedValue(response)
  else rpc.getCalendar.mockRejectedValue(failure === 'thrown Response' ? response : new Error('private-calendar-error-marker'))
  const router = businessRouter('en', '&calendar=returned')
  await router.load()
  expect(router.state.matches.find(match => match.routeId === '/app/entreprise')?.status).toBe('success')
  const html = render(router)
  expect(html).toContain('value="Saved garage"'); expect(html).toContain(calendarMessages.en.unavailable)
  expect(html).not.toContain('private-calendar-'); expect(html).not.toContain(calendarMessages.en.connect)
  expectNoMutations()
})

for (const lang of ['fr', 'en'] as const) for (const failure of ['returned Response', 'thrown Response', 'unexpected error'] as const) {
  test(`Business ${lang} Activity ${failure} selects redacted private recovery before reading Calendar`, async () => {
    rpc.getWorkspace.mockResolvedValue(workspace)
    const response = new Response('private-activity-response-marker', { status: 503 })
    if (failure === 'returned Response') rpc.getActivity.mockResolvedValue(response)
    else rpc.getActivity.mockRejectedValue(failure === 'thrown Response' ? response : new Error('private-activity-error-marker'))
    const router = businessRouter(lang)
    await router.load()
    const match = router.state.matches.find(value => value.routeId === '/app/entreprise')
    expect(match?.status).toBe('error'); expect(match?.loaderData).toBeUndefined()
    expect(String(match?.error)).toBe('Error: Business unavailable')
    const html = render(router)
    expect(html).toContain('role="alert"'); expect(html).toContain(`href="/login?lang=${lang}"`)
    expect(html).not.toContain('private-activity-'); expect(html).not.toContain('sparra-business-form')
    expect(rpc.getCalendar).not.toHaveBeenCalled(); expectNoMutations()
  })
}

test.each(['fr', 'en'] as const)('Business %s Activity 401 uses the native localized redirect without reading Calendar', async lang => {
  rpc.getWorkspace.mockResolvedValue(workspace); rpc.getActivity.mockResolvedValue(new Response('private-refusal-marker', { status: 401 }))
  const router = businessRouter(lang)
  await router.load()
  // The pinned Router publishes an SSR redirect as its server-load result;
  // it does not commit a browser location or put it in state.redirect.
  const result = router._serverResult
  expect(result?.type).toBe('redirect')
  if (result?.type !== 'redirect') throw new Error('Expected native SSR redirect')
  expect(result.redirect.headers.get('location')).toBe(`/login?lang=${lang}`)
  expect(router.state.matches.some(match => match.routeId === '/app/entreprise' && match.status === 'success')).toBe(false)
  expect(rpc.getCalendar).not.toHaveBeenCalled(); expectNoMutations()
})

test('Business waits for the real parent Workspace read, then Activity, then Calendar with the owned request signal', async () => {
  const order: string[] = []
  let enterParent = () => {}, releaseParent = () => {}, enterActivity = () => {}, releaseActivity = () => {}
  const parentEntered = new Promise<void>(resolve => { enterParent = resolve }), parentGate = new Promise<void>(resolve => { releaseParent = resolve })
  const activityEntered = new Promise<void>(resolve => { enterActivity = resolve }), activityGate = new Promise<void>(resolve => { releaseActivity = resolve })
  rpc.getWorkspace.mockImplementation(async () => { order.push('parent entered'); enterParent(); await parentGate; order.push('parent finished'); return workspace })
  rpc.getActivity.mockImplementation(async () => { order.push('activity entered'); enterActivity(); await activityGate; order.push('activity finished'); return activity('garage') })
  rpc.getCalendar.mockImplementation(async () => { order.push('calendar entered'); return disconnected })
  const router = businessRouter('en'), loading = router.load()
  try {
    await parentEntered
    expect(rpc.getActivity).not.toHaveBeenCalled(); expect(rpc.getCalendar).not.toHaveBeenCalled()
    releaseParent(); await activityEntered
    expect(order).toEqual(['parent entered', 'parent finished', 'activity entered']); expect(rpc.getCalendar).not.toHaveBeenCalled()
    releaseActivity(); await loading
    expect(order).toEqual(['parent entered', 'parent finished', 'activity entered', 'activity finished', 'calendar entered'])
    const input = rpc.getActivity.mock.calls[0]?.[0]
    expect(input).toEqual({ data: {}, signal: expect.any(AbortSignal) })
    expect(rpc.getCalendar.mock.calls[0]?.[0]).toEqual({ data: {}, signal: input.signal })
    expect(input.signal.aborted).toBe(false)
    expectNoMutations()
  } finally { releaseParent(); releaseActivity(); await loading }
})
