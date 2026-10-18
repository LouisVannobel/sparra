import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { beforeAll, afterAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody, rpcResult } from '../helpers/auth-rpc'
import type { BillingSummary } from '../../src/modules/billing/checkout.server'

type DeferredBillingRead = { release(): void; restore(): void; state(): { paused: boolean; finished: boolean } }
declare global {
  interface Window { billingMarker?: number; __sparraBillingDeferred?: DeferredBillingRead }
}

let stores: Awaited<ReturnType<typeof startDisposableStores>>, browser: Browser
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.first_google_passkey_intent TO runtime;
    GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime`)
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  const failures: unknown[] = []
  try { await browser?.close() } catch (error) { failures.push(error) }
  try { await stores?.cleanup() } catch (error) { failures.push(error) }
  if (stores) {
    expect(stores.evidence.unrelatedUnchanged).toBe(true)
    expect(stores.evidence.inventoryDelta).toEqual([])
  }
  if (failures.length) throw new AggregateError(failures, 'Billing browser resources did not retire')
})

type Fixture = { app: ReturnType<typeof startWeb>; origin: string; context: BrowserContext; page: Page; subject: string
  activate(label: string): Promise<void>; google(): Promise<string>; workspace(): Promise<{ id: string; displayName: string }>
  passkey(): Promise<{ userId: string; sessionId: string }>; rpc(name: Parameters<typeof authRpcPath>[0], data: unknown): ReturnType<BrowserContext['request']['post']> }
const syntheticStripe = { STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox' }
const unavailableText = 'Payment is not yet available for this workspace.'
const available = { availability: 'available' as const, state: 'not-started' as const, paidThrough: null, cancellation: 'none' as const }

async function snapshot() {
  const rows = []
  for (const table of ['workspace','billing_customer','billing_operation','billing_operation_outcome','billing_agreement','billing_current_agreement','billing_agreed_terms'] as const) {
    const result = await stores.administrator.query<{ body: string }>(`SELECT row_to_json(r)::text AS body FROM public.${table} r ORDER BY row_to_json(r)::text`)
    rows.push({ table, count: result.rows.length, hash: createHash('sha256').update(JSON.stringify(result.rows)).digest('hex') })
  }
  return rows
}

async function withPage(run: (f: Fixture) => Promise<void>, extra: Record<string,string> = {}) {
  const port = await unusedLoopbackPort(), origin = 'http://localhost:' + port, subject = randomUUID()
  const authSecret = randomBytes(48).toString('hex'), canaries = new Set([authSecret, stores.hmac, stores.runtimeUrl, stores.redisUrl])
  let app: ReturnType<typeof startWeb> | undefined, context: BrowserContext | undefined
  const failures: unknown[] = [], routes = new Set<Promise<void>>()
  let routeFailures = 0, externalRequests = 0, pageErrors = 0
  try {
    app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, PORT: String(port), DATABASE_URL: stores.runtimeUrl,
      REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'billing-ui-' + subject,
      TRUSTED_PROXY_IPS: '127.0.0.1', AUTH_SECRET: authSecret, GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture-only', FIXTURE_GOOGLE_PROTOCOL: 'yes', REQUEST_TIMEOUT_MS: '10000', SHUTDOWN_TIMEOUT_MS: '1000', ...extra })
    await bounded(app.ready, 15000)
    context = await browser.newContext({ viewport: { width: 320, height: 720 }, extraHTTPHeaders: { 'x-real-ip': '192.0.2.71' } })
    const ownedApp = app, ownedContext = context, page = await context.newPage()
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000)
    page.on('pageerror', () => { pageErrors++ })
    const ownedRoute = (action: (route: Route) => Promise<void>) => (route: Route) => {
      const work = action(route).catch(async () => { routeFailures++; try { await route.abort() } catch { routeFailures++ } })
      routes.add(work); void work.then(() => routes.delete(work)); return work
    }
    await context.route('**/*', ownedRoute(async route => {
      if (new URL(route.request().url()).origin === origin) { await route.continue(); return }
      externalRequests++; await route.abort()
    }))
    await page.route('https://accounts.google.com/o/oauth2/v2/auth*', ownedRoute(async route => {
      const target = new URL(route.request().url()), callback = target.searchParams.get('redirect_uri')
      if (![origin + '/api/auth/callback/google',origin + '/api/auth/first-passkey/google/callback'].includes(callback ?? '')) throw new Error('Unexpected fixture callback')
      const code = await ownedApp.registerGoogle(target.href, subject, { email: subject + '@example.test', claims: { auth_time: Math.floor(Date.now() / 1000) - 10 } })
      canaries.add(code)
      await route.fulfill({ status: 302, headers: { location: callback + '?code=' + code + '&state=' + target.searchParams.get('state') } })
    }))
    async function activate(label: string) {
      const button = page.getByRole('button', { name: label, exact: true })
      await expect.poll(() => button.isEnabled()).toBe(true)
      await button.focus(); await page.keyboard.press('Enter')
    }
    async function rpc(name: Parameters<typeof authRpcPath>[0], data: unknown) {
      return ownedContext.request.post(origin + await authRpcPath(name), { headers: { origin, 'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, data: await rpcBody(data) })
    }
    async function google() {
      await page.goto(origin + '/login?lang=en'); await activate('Continue with Google')
      await page.waitForURL(url => url.pathname === '/account')
      const row = (await stores.administrator.query<{ id: string }>('SELECT id FROM public."user" WHERE email=$1', [subject + '@example.test'])).rows[0]
      if (!row) throw new Error('Native browser-created user missing')
      // Synthetic prerequisite, not email-verification/provider acceptance.
      await stores.administrator.query('UPDATE public."user" SET email_verified=true WHERE id=$1', [row.id])
      canaries.add(row.id)
      return row.id
    }
    async function workspace() {
      expect((await rpc('ensurePersonalWorkspace', {})).status()).toBe(200)
      const row = (await stores.administrator.query<{ id: string; displayName: string }>('SELECT w.id,w.display_name AS "displayName" FROM workspace w JOIN public."user" u ON u.id=w.owner_user_id WHERE u.email=$1', [subject + '@example.test'])).rows[0]
      if (!row) throw new Error('Explicitly created native Workspace missing')
      const displayName = 'Private billing <script>billingMarker=1</script>'
      expect((await rpc('renameWorkspace', { workspaceId: row.id, displayName })).status()).toBe(200)
      return { id: row.id, displayName }
    }
    async function passkey() {
      const userId = await google()
      // Native first-key admission requires an existing PERSONAL Workspace,
      // as in the consumer's established Google/passkey browser ceremony.
      await workspace()
      const cdp = await ownedContext.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
      await page.reload(); await activate('Verify with Google')
      await activate('Create my first passkey'); await page.getByText('Your first passkey was added.', { exact: true }).waitFor()
      await activate('Sign out'); await page.waitForURL(url => url.pathname === '/login')
      await activate('Sign in with a passkey'); await page.waitForURL(url => url.pathname === '/account')
      const rows = (await stores.administrator.query<{ id: string; method: string; state: string; fresh: boolean }>(
        `SELECT id,auth_method AS method,auth_state AS state,authenticated_at>clock_timestamp()-interval '300 seconds' AS fresh FROM session WHERE user_id=$1`, [userId])).rows
      expect(rows).toHaveLength(1)
      expect({ method: rows[0].method, state: rows[0].state, fresh: rows[0].fresh }).toEqual({ method: 'passkey', state: 'ACTIVE', fresh: true })
      canaries.add(rows[0].id)
      for (const cookie of await ownedContext.cookies()) canaries.add(cookie.value)
      return { userId, sessionId: rows[0].id }
    }
    await run({ app: ownedApp, origin, context: ownedContext, page, subject, activate, google, workspace, passkey, rpc })
    await bounded(Promise.all([...routes]), 15000)
    expect({ routeFailures, externalRequests, pageErrors }).toEqual({ routeFailures: 0, externalRequests: 0, pageErrors: 0 })
    expect((await ownedApp.googleEvidence()).disallowed).toBe(0)
    expect([...canaries].some(value => value.length >= 8 && ownedApp.output().includes(value))).toBe(false)
  } finally {
    try { await context?.close() } catch (error) { failures.push(error) }
    try {
      if (app) { await app.shutdown(); expect(await bounded(app.exit, 15000)).toBe(0); await app.cleanup() }
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Billing browser application retirement failed')
  }
}

test('compiled billing redirects anonymous navigation and never provisions a null Workspace', async () => {
  await withPage(async f => {
    const before = await snapshot()
    expect((await f.page.goto(f.origin + '/billing?lang=en'))?.status()).toBe(200)
    expect(new URL(f.page.url()).pathname).toBe('/login')
    expect(await snapshot()).toEqual(before)
    await f.google()
    await f.page.goto(f.origin + '/billing?lang=en')
    await f.page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
    await f.page.getByText('Create your workspace', { exact: false }).waitFor()
    expect(await f.page.locator('main button').count()).toBe(0)
    expect(await snapshot()).toEqual(before)
  })
}, 120000)

test('compiled Google navigation exposes Billing while native financial authority refuses without affecting Inbox', async () => {
  await withPage(async f => {
    await f.google(); const workspace = await f.workspace(), before = await snapshot()
    await f.page.goto(f.origin + '/app?lang=en')
    await f.page.getByRole('heading', { name: 'Call inbox', exact: true }).waitFor()
    await f.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Billing', exact: true }).click()
    await f.page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
    await f.page.getByRole('alert').waitFor()
    expect(await f.page.getByRole('alert').evaluate(node => node === document.activeElement)).toBe(false)
    expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
    expect(await f.page.locator('main time').count()).toBe(0)
    for (const name of ['startBillingCheckout','cancelBillingAtPeriodEnd'] as const) {
      const response = await f.rpc(name, { workspaceId: workspace.id })
      expect(response.status()).toBe(404)
      expect(await response.text()).not.toContain(workspace.displayName)
    }
    await f.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Call inbox', exact: true }).click()
    await f.page.getByRole('heading', { name: 'Call inbox', exact: true }).waitFor()
    expect(await snapshot()).toEqual(before)
  }, syntheticStripe)
}, 120000)

test('compiled fresh passkey billing stays truthful in FR EN at320 with keyboard access and forged Checkout returns', async () => {
  await withPage(async f => {
    await f.passkey(); const workspace = await f.workspace(), before = await snapshot()
    for (const locale of ['en','fr'] as const) {
      const response = await f.page.goto(f.origin + `/billing?lang=${locale}&session_id=cs_test_forgedMarker&checkout=cancelled&state=paid`)
      expect(response?.headers()['cache-control']).toContain('no-store')
      expect(response?.headers()['x-robots-tag']).toBe('noindex')
      await f.page.getByRole('heading', { name: locale === 'fr' ? 'Facturation' : 'Billing', exact: true }).waitFor()
      await f.page.getByText(locale === 'fr' ? 'Le paiement n’est pas encore disponible pour cet espace.' : unavailableText, { exact: false }).waitFor()
      expect(await f.page.getByText(workspace.displayName, { exact: true }).isVisible()).toBe(true)
      expect(await f.page.getByRole('main').count()).toBe(1)
      expect(await f.page.locator('main time').count()).toBe(0)
      expect(await f.page.evaluate(() => window.billingMarker)).toBeUndefined()
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page: f.page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([])
      const refresh = f.page.getByRole('button', { name: locale === 'fr' ? 'Actualiser' : 'Refresh', exact: true })
      await expect.poll(() => refresh.isEnabled()).toBe(true)
      await refresh.focus(); await f.page.keyboard.press('Tab'); await f.page.keyboard.press('Shift+Tab')
      expect(await refresh.evaluate(node => node === document.activeElement && node.matches(':focus-visible'))).toBe(true)
      await f.page.keyboard.press('Enter')
      await f.page.getByText(locale === 'fr' ? 'Le paiement n’est pas encore disponible pour cet espace.' : unavailableText, { exact: false }).waitFor()
      await expect.poll(() => refresh.isEnabled()).toBe(true)
    }
    expect(await snapshot()).toEqual(before)
  }, syntheticStripe)
}, 120000)

test('compiled partial Stripe configuration preserves private navigation and a fresh passkey unavailable billing screen', async () => {
  await withPage(async f => {
    await f.passkey(); await f.workspace(); const before = await snapshot()
    await f.page.goto(f.origin + '/billing?lang=en')
    await f.page.getByText(unavailableText, { exact: false }).waitFor()
    await f.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Call inbox', exact: true }).click()
    await f.page.getByRole('heading', { name: 'Call inbox', exact: true }).waitFor()
    expect((await f.context.request.get(f.origin + '/health/ready')).status()).toBe(200)
    expect(await snapshot()).toEqual(before)
  }, { STRIPE_ACCOUNT_ID: 'acct_fixture' })
}, 120000)

test('compiled protected refresh ignores a late departed read and clears private content after native session refusal', async () => {
  await withPage(async f => {
    const session = await f.passkey(), workspace = await f.workspace(), before = await snapshot()
    await f.page.goto(f.origin + '/billing?lang=en'); await f.page.getByText(unavailableText, { exact: false }).waitFor()
    const path = await authRpcPath('getBilling')
    await f.page.evaluate(path => {
      const nativeFetch = window.fetch
      let release = () => {}, paused = false, finished = false, armed = true
      const gate = new Promise<void>(resolve => { release = resolve })
      window.fetch = async (resource, init) => {
        const target = new URL(resource instanceof Request ? resource.url : String(resource), location.href).pathname
        if (!armed || target !== path) return nativeFetch(resource, init)
        armed = false
        const response = await nativeFetch(resource, init ? { ...init, signal: undefined } : init)
        paused = true; await gate; finished = true; return response
      }
      window.__sparraBillingDeferred = { release, restore: () => { window.fetch = nativeFetch }, state: () => ({ paused, finished }) }
    }, path)
    try {
      await f.activate('Refresh')
      await f.page.waitForFunction(() => window.__sparraBillingDeferred?.state().paused === true)
      expect(await f.page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled()).toBe(true)
      expect(await f.page.locator('.sparra-billing').getAttribute('aria-busy')).toBe('true')
      await f.page.evaluate(() => { history.pushState(null, '', '/account?lang=en'); dispatchEvent(new PopStateEvent('popstate')) })
      await f.page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
      await f.page.evaluate(() => window.__sparraBillingDeferred?.release())
      await f.page.waitForFunction(() => window.__sparraBillingDeferred?.state().finished === true)
      expect(new URL(f.page.url()).pathname).toBe('/account')
      expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
    } finally { await f.page.evaluate(() => { const value = window.__sparraBillingDeferred; value?.release(); value?.restore() }) }
    async function holdWorkspaceRead() {
      const workspacePath = await authRpcPath('getWorkspace')
      await f.page.evaluate(path => {
        const nativeFetch = window.fetch
        let release = () => {}, paused = false, finished = false, armed = true
        const gate = new Promise<void>(resolve => { release = resolve })
        window.fetch = async (resource, init) => {
          const target = new URL(resource instanceof Request ? resource.url : String(resource), location.href).pathname
          if (!armed || target !== path) return nativeFetch(resource, init)
          armed = false
          const response = await nativeFetch(resource, init ? { ...init, signal: undefined } : init)
          paused = true; await gate; finished = true; return response
        }
        window.__sparraBillingDeferred = { release, restore: () => { window.fetch = nativeFetch }, state: () => ({ paused, finished }) }
      }, workspacePath)
    }
    async function restoreWorkspaceRead() {
      await f.page.evaluate(() => { const value = window.__sparraBillingDeferred; value?.release(); value?.restore() })
    }
    // Actual history Back within the retained document: an authorized slow
    // reentry must remain private until its fresh native read is released.
    await holdWorkspaceRead()
    try {
      await f.page.evaluate(() => history.back())
      await f.page.waitForFunction(() => window.__sparraBillingDeferred?.state().paused === true)
      expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
      expect(await f.page.getByRole('button', { name: 'Cancel at period end', exact: true }).count()).toBe(0)
      expect(await f.page.locator('.sparra-billing time').count()).toBe(0)
      await f.page.evaluate(() => window.__sparraBillingDeferred?.release())
      await f.page.getByText(workspace.displayName, { exact: true }).waitFor()
    } finally { await restoreWorkspaceRead() }
    // Exercise the installed handlers in the retained document. These
    // dispatched events do not claim that Chromium admitted a real BFCache entry.
    await holdWorkspaceRead()
    try {
      await f.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
      await expect.poll(() => f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
      expect(await f.page.locator('.sparra-billing time').count()).toBe(0)
      await f.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
      await f.page.waitForFunction(() => window.__sparraBillingDeferred?.state().paused === true)
      expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
      await f.page.evaluate(() => window.__sparraBillingDeferred?.release())
      await f.page.getByText(workspace.displayName, { exact: true }).waitFor()
    } finally { await restoreWorkspaceRead() }
    await f.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Account', exact: true }).click()
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
    await stores.administrator.query('DELETE FROM session WHERE id=$1 AND user_id=$2', [session.sessionId, session.userId])
    await holdWorkspaceRead()
    try {
      await f.page.evaluate(() => history.back())
      await f.page.waitForFunction(() => window.__sparraBillingDeferred?.state().paused === true)
      expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
      expect(await f.page.getByRole('button', { name: 'Continue to payment', exact: true }).count()).toBe(0)
      expect(await f.page.getByRole('button', { name: 'Cancel at period end', exact: true }).count()).toBe(0)
      expect(await f.page.locator('.sparra-billing time').count()).toBe(0)
      await f.page.evaluate(() => window.__sparraBillingDeferred?.release())
      await f.page.waitForURL(url => url.pathname === '/login')
      await f.page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
    } finally { await restoreWorkspaceRead() }
    expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
    expect(await f.page.locator('main time').count()).toBe(0)
    expect(await snapshot()).toEqual(before)
  })
}, 120000)

test('compiled billing UI validates Checkout navigation and uses exact Workspace POSTs without trusting cancellation acknowledgements', async () => {
  // These native-serializer RPC replacements qualify browser controls only.
  // They cannot qualify financial admission, provider effects or paid rights.
  await withPage(async f => {
    await f.passkey(); const workspace = await f.workspace(), before = await snapshot()
    const readPath = await authRpcPath('getBilling'), checkoutPath = await authRpcPath('startBillingCheckout'), cancelPath = await authRpcPath('cancelBillingAtPeriodEnd')
    let summary: BillingSummary = { ...available }
    let checkoutUrl = 'https://checkout.stripe.com.evil.invalid/c/pay/cs_test_uiMarker', checkoutPosts = 0, cancellationPosts = 0
    const bodies: string[] = [], routeErrors: unknown[] = []
    const capture = (run: (route: Route) => Promise<void>) => async (route: Route) => {
      try { await run(route) } catch (error) { routeErrors.push(error); await route.abort() }
    }
    await f.page.route('**' + readPath + '*', capture(async route => { await route.fulfill(await rpcResult(summary)) }))
    await f.page.route('**' + checkoutPath, capture(async route => {
      checkoutPosts++; bodies.push(route.request().postData() ?? '')
      await route.fulfill(await rpcResult({ url: checkoutUrl }))
    }))
    await f.page.route('**' + cancelPath, capture(async route => {
      cancellationPosts++; bodies.push(route.request().postData() ?? '')
      await route.fulfill(await rpcResult({ state: 'confirmed' }))
    }))
    await f.page.goto(f.origin + '/billing?lang=en')
    // Initial server loader uses native unavailable data. Explicit Refresh now
    // consumes the intercepted native Start RPC response in the actual UI.
    await f.activate('Refresh')
    for (const url of ['https://checkout.stripe.com.evil.invalid/c/pay/cs_test_uiMarker','http://checkout.stripe.com/c/pay/cs_test_uiMarker',
      'https://user:password@checkout.stripe.com/c/pay/cs_test_uiMarker','https://checkout.stripe.com/foreign/cs_test_uiMarker']) {
      checkoutUrl = url
      const action = f.page.getByRole('button', { name: 'Continue to payment', exact: true })
      await expect.poll(() => action.isEnabled()).toBe(true)
      await action.focus()
      const prior = checkoutPosts
      await action.evaluate(node => {
        if (!(node instanceof HTMLButtonElement)) throw new Error('Expected the actual billing button')
        node.click(); node.click()
      })
      await f.page.getByRole('alert').waitFor()
      await expect.poll(() => f.page.getByRole('alert').evaluate(node => node === document.activeElement)).toBe(true)
      expect(checkoutPosts).toBe(prior + 1)
      expect(new URL(f.page.url()).origin).toBe(f.origin)
      expect(await f.page.getByText(workspace.displayName, { exact: true }).count()).toBe(0)
      await f.activate('Refresh')
    }
    summary = { availability: 'available', state: 'paid', paidThrough: '2030-11-16T12:00:00.000Z', cancellation: 'none' }
    await f.activate('Refresh'); await f.activate('Cancel at period end')
    await expect.poll(() => cancellationPosts).toBe(1)
    await expect.poll(() => f.page.getByRole('button', { name: 'Cancel at period end', exact: true }).isEnabled()).toBe(true)
    expect(await f.page.getByText('Cancellation request confirmed', { exact: true }).count()).toBe(0)
    summary = { ...summary, cancellation: 'confirmed' }; await f.activate('Refresh')
    await f.page.getByText('Cancellation request confirmed', { exact: true }).waitFor()
    expect(await f.page.getByRole('button', { name: 'Cancel at period end', exact: true }).count()).toBe(0)
    summary = { ...available, state: 'incident' }; await f.activate('Refresh')
    await f.page.getByRole('alert').waitFor()
    expect(await f.page.getByRole('button', { name: 'Continue to payment', exact: true }).count()).toBe(0)
    expect(checkoutPosts).toBe(4)
    summary = { ...available }; await f.activate('Refresh')
    checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_uiMarker'
    await f.page.route(checkoutUrl, capture(async route => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Owned Checkout UI destination</h1>' })
    }))
    await f.activate('Continue to payment')
    await f.page.getByRole('heading', { name: 'Owned Checkout UI destination', exact: true }).waitFor()
    expect(f.page.url()).toBe(checkoutUrl)
    expect(checkoutPosts).toBe(5)
    for (const body of bodies) expect(body).toBe(await rpcBody({ workspaceId: workspace.id }))
    expect(routeErrors).toEqual([])
    expect(await snapshot()).toEqual(before)
  })
}, 120000)
