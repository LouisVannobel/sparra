import { afterEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { Route as LoginRoute } from '../../src/routes/login'
import { Route as AccountRoute } from '../../src/routes/account'
import { messages, resolveLocale } from '../../src/ui/auth/messages'

// The RPC boundary owns request context, provider I/O and the database. Keep
// real routes, Router, hooks and panels; replace only that external boundary.
const rpc = vi.hoisted(() => ({ getLoginAvailability: vi.fn(), getAccount: vi.fn(), beginGoogleSignIn: vi.fn(),
  beginPasskeySignIn: vi.fn(), finishPasskeySignIn: vi.fn(), beginAdditionalPasskey: vi.fn(), authorizeAdditionalPasskey: vi.fn(),
  finishAdditionalPasskey: vi.fn(), requestMagicLink: vi.fn(), logout: vi.fn(),
  beginFirstGooglePasskey: vi.fn(), readFirstGooglePasskey: vi.fn(), prepareFirstGooglePasskey: vi.fn(), finishFirstGooglePasskey: vi.fn(), cancelFirstGooglePasskey: vi.fn(),
  beginGoogleAccountLink: vi.fn(), authorizeGoogleAccountLink: vi.fn(), beginGoogleAccountUnlink: vi.fn(), finishGoogleAccountUnlink: vi.fn(), readGoogleAccountIntent: vi.fn(), cancelGoogleAccountIntent: vi.fn(),
  beginSessionList: vi.fn(), finishSessionList: vi.fn(), beginSessionRevocation: vi.fn(), finishSessionRevocation: vi.fn() }))
vi.mock('../../src/modules/auth/auth.functions', () => rpc)
afterEach(() => vi.resetAllMocks())

function authRouter(path: '/login' | '/account', lang: 'fr' | 'en') {
  const root = createRootRoute({ validateSearch: (search: { lang?: unknown }) => ({ lang: resolveLocale(search.lang) }) })
  const login = createRoute({ ...LoginRoute.options, path: '/login', getParentRoute: () => root })
  const account = createRoute({ ...AccountRoute.options, path: '/account', getParentRoute: () => root })
  return createRouter({ routeTree: root.addChildren([login, account]), history: createMemoryHistory({ initialEntries: [`${path}?lang=${lang}`] }), isServer: true })
}
const render = (router: ReturnType<typeof authRouter>) => renderToString(createElement(RouterProvider, { router }))

// Removing either raw-Response guard returns failure as success data. Removing
// normalization leaks unexpected error contents; missing route error UI hides
// the announcement and recovery navigation for these actual route matches.
for (const path of ['/login', '/account'] as const) {
  for (const lang of ['fr', 'en'] as const) {
    const title = messages[lang][path === '/login' ? 'login' : 'account']
    for (const failure of ['returned Response', 'thrown Response', 'unexpected error'] as const) {
      test(`${path} ${lang}: ${failure} selects safe announced route error, never success data`, async () => {
        const call = path === '/login' ? rpc.getLoginAvailability : rpc.getAccount
        const raw = new Response('private-synthetic-response', { status: 503 })
        if (failure === 'returned Response') call.mockResolvedValue(raw)
        else call.mockRejectedValue(failure === 'thrown Response' ? raw : new Error('private-synthetic-error'))
        const router = authRouter(path, lang)
        await router.load()
        const match = router.state.matches.find(value => value.routeId === path)
        expect(match?.status).toBe('error')
        expect(match?.loaderData).toBeUndefined()
        expect(match?.error).toBeInstanceOf(Error)
        expect(String(match?.error)).not.toContain('private-synthetic')
        const html = render(router)
        expect(html).toContain('class="auth-brand" href="/"')
        expect(html).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`))
        expect(html).toContain('role="alert"')
        expect(html).toContain(lang === 'fr' ? 'Impossible de charger' : 'Unable to load')
        expect(html).toContain(`href="/login?lang=${lang}"`)
        expect(html).not.toContain('private-synthetic')
        expect(html).not.toContain('<dl>')
        expect(html).not.toContain('Continuer avec Google')
        expect(html).not.toContain('Continue with Google')
      })
    }
  }
}

// Rejecting all availability results would incorrectly replace a legitimate
// disabled provider with an error; successful principal data must survive too.
for (const lang of ['fr', 'en'] as const) {
  test(`${lang}: successful availability=false and principal keep their real UI`, async () => {
    rpc.getLoginAvailability.mockResolvedValue({ google: false })
    const login = authRouter('/login', lang)
    await login.load()
    const loginHtml = render(login)
    expect(loginHtml).toContain(lang === 'fr' ? 'La connexion Google est indisponible' : 'Google sign-in is currently unavailable')
    expect(loginHtml).toContain('disabled')
    expect(loginHtml).not.toContain('role="alert"')
    rpc.getAccount.mockResolvedValue({ userId: 'private-fixture-id', name: 'Current fixture', email: 'current@example.test', passkeys: [], additionalPasskey: 'existing-key-required',
      firstGooglePasskey: false, sessionManagement: false, googleAccount: { state: 'unlinked', canLink: false } })
    const account = authRouter('/account', lang)
    await account.load()
    const accountHtml = render(account)
    expect(accountHtml).toContain('Current fixture')
    expect(accountHtml).toContain('current@example.test')
    expect(accountHtml).not.toContain('private-fixture-id')
  })
}
