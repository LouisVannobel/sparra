import { expect, test, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { resolveLocale } from '../../src/ui/auth/messages'
import { Route } from '../../src/routes/account'

vi.mock('../../src/modules/auth/auth.functions', () => ({ getAccount: async () => { throw new Response('Unauthorized', { status: 401 }) } }))

test.each([{ lang: 'fr', title: 'Votre compte' }, { lang: 'en', title: 'Your account' }])('account route emits its $lang document title without private account data', async ({ lang, title }) => {
  const root = createRootRoute({ validateSearch: (search: Record<string, unknown>) => ({ lang: resolveLocale(search.lang) }) })
  const account = createRoute({ ...Route.options, path: '/account', getParentRoute: () => root })
  const router = createRouter({ routeTree: root.addChildren([account]), history: createMemoryHistory({ initialEntries: ['/account?lang=' + lang] }), isServer: true })
  await router.load()
  expect(router.state.matches.find(match => match.routeId === '/account')?.meta).toEqual([{ title }])
})

test.each(['fr', 'en'] as const)('Google account panel distinguishes local unlink and disables controls before hydration in %s', async locale => {
  const modules = import.meta.glob('../../src/ui/auth/google-account-panel.tsx')
  const load = modules['../../src/ui/auth/google-account-panel.tsx']
  expect(typeof load).toBe('function')
  const { GoogleAccountPanel } = await load() as typeof import('../../src/ui/auth/google-account-panel')
  const unused = async (): Promise<never> => { throw new Error('SSR must not perform a command') }
  const html = renderToString(<GoogleAccountPanel locale={locale} userId="private-user" connection={{ state: 'linked', accountId: 'private-account', canUnlink: true }}
    onBeginLink={unused} onAuthorize={unused} onBeginUnlink={unused} onFinishUnlink={unused} onRead={unused} onCancel={unused} onChanged={unused} onRefused={unused} />)
  expect(html).toContain(locale === 'fr' ? 'Google est lié' : 'Google is linked')
  expect(html).toContain(locale === 'fr' ? 'consentement Google' : 'Google consent')
  expect(html).toContain('disabled')
  expect(html).not.toContain('private-user'); expect(html).not.toContain('private-account')
})

test('Google authorization history stores only its UUID selector and preserves Router metadata before live same-tab navigation', async () => {
  const modules = import.meta.glob('../../src/ui/auth/google-account-panel.tsx')
  const load = modules['../../src/ui/auth/google-account-panel.tsx']
  expect(typeof load).toBe('function')
  const { navigateGoogleAccountLink } = await load() as typeof import('../../src/ui/auth/google-account-panel')
  const metadata = { __TSR_index: 3 }, effects: string[] = []
  const replaceState = vi.fn(() => { effects.push('history') }), assign = vi.fn(() => { effects.push('navigate') })
  vi.stubGlobal('window', { history: { state: metadata, replaceState }, location: { assign } })
  const intentId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  const result = { intentId, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' }
  try {
    navigateGoogleAccountLink(result, 'en', () => false)
    expect(effects).toEqual([])
    navigateGoogleAccountLink(result, 'en', () => true)
    expect(effects).toEqual(['history', 'navigate'])
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(metadata, '', '/account?lang=en&googleAccount=' + intentId)
    expect(assign).toHaveBeenCalledExactlyOnceWith(result.url)
    expect(() => navigateGoogleAccountLink({ ...result, intentId: 'untrusted' }, 'en', () => true)).toThrow()
  } finally { vi.unstubAllGlobals() }
})
