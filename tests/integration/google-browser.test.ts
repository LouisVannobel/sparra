import { beforeAll, beforeEach, afterAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcResult } from '../helpers/auth-rpc'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let app: ReturnType<typeof startWeb>
let proxy: ReturnType<typeof createServer>
let browser: Browser
let origin: string
let responseTestClient = 0
let clientIp: string | undefined
async function browserContext(options?: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(options)
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  return context
}
// A separate synthetic client per new test avoids consuming another case's
// genuine max=3/10s admission budget. The test proxy remains the IP authority.
beforeEach(({ task }) => { clientIp = task.name.startsWith('task-11 auth response') ? `192.0.2.${++responseTestClient}` : undefined })
beforeAll(async () => {
  await mkdir('.output/test-evidence/google-browser', { recursive: true })
  stores = await startDisposableStores()
  await stores.migrate()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  // The account loader consumes only passkey metadata in this Google fixture.
  await stores.administrator.query('GRANT SELECT (id,name,created_at,user_id) ON public.passkey TO runtime')
  expect((await stores.administrator.query(`SELECT
    has_column_privilege('runtime','public.passkey','id','SELECT') AS id_select,
    has_column_privilege('runtime','public.passkey','name','SELECT') AS name_select,
    has_column_privilege('runtime','public.passkey','created_at','SELECT') AS created_at_select,
    has_column_privilege('runtime','public.passkey','user_id','SELECT') AS user_id_select,
    has_column_privilege('runtime','public.passkey','public_key','SELECT') AS public_key_select,
    has_column_privilege('runtime','public.passkey','credential_id','SELECT') AS credential_id_select,
    has_column_privilege('runtime','public.passkey','counter','SELECT') AS counter_select,
    has_table_privilege('runtime','public.passkey','SELECT') AS table_select,
    has_any_column_privilege('runtime','public.passkey','INSERT') AS can_insert,
    has_any_column_privilege('runtime','public.passkey','UPDATE') AS can_update,
    has_table_privilege('runtime','public.passkey','DELETE') AS can_delete
  `)).rows[0]).toEqual({ id_select: true, name_select: true, created_at_select: true, user_id_select: true,
    public_key_select: false, credential_id_select: false, counter_select: false, table_select: false,
    can_insert: false, can_update: false, can_delete: false })
  const port = await unusedLoopbackPort()
  origin = `http://localhost:${port}`
  app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
    RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'browser', TRUSTED_PROXY_IPS: '127.0.0.2',
    AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only', FIXTURE_GOOGLE_PROTOCOL: 'yes', REQUEST_TIMEOUT_MS: '10000' })
  const upstreamPort = (await bounded(app.ready)).port
  proxy = createServer((incoming, outgoing) => {
    const call = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, method: incoming.method, path: incoming.url, localAddress: '127.0.0.2', headers: { ...incoming.headers, 'x-real-ip': clientIp ?? incoming.socket.remoteAddress } }, response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing) })
    call.on('error', () => { outgoing.writeHead(502); outgoing.end() }); incoming.pipe(call)
  })
  await new Promise<void>(done => proxy.listen(port, '127.0.0.1', done))
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => browser?.close(), () => proxy && new Promise(done => proxy.close(done)), () => app?.cleanup(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Google browser cleanup failed')
})

test('actual browser Google protocol, locale, Secure cookie, account and logout; authenticated-victim CSRF', async () => {
  const context = await browserContext({ viewport: { width: 320, height: 720 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(5000)
  const errors: string[] = [], unexpected: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => { const url = new URL(request.url()); if (url.origin !== origin && url.origin !== 'https://accounts.google.com') unexpected.push(url.origin) })
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
    const target = new URL(route.request().url())
    expect(target.searchParams.get('redirect_uri') === origin + '/api/auth/callback/google').toBe(true)
    const code = await app.registerGoogle(target.href, 'fixture-browser')
    return route.fulfill({ status: 302, headers: { location: origin + `/api/auth/callback/google?code=${code}&state=` + target.searchParams.get('state') } })
  })
  await page.goto(origin + '/login?lang=en', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor()
  expect(errors).toEqual([])
  expect(await page.locator('html').getAttribute('lang')).toBe('en')
  await page.screenshot({ path: '.output/test-evidence/google-browser/task-5-login-en-320.png', fullPage: true })
  const nonce = await page.locator('script[nonce]').first().evaluate(script => script.nonce)
  await page.getByRole('link', { name: 'Français' }).click()
  await page.getByRole('button', { name: 'Continuer avec Google' }).waitFor()
  expect(await page.locator('html').getAttribute('lang')).toBe('fr')
  expect(await page.locator('script[nonce]').first().evaluate(script => script.nonce) === nonce).toBe(true)
  await page.getByRole('link', { name: 'English' }).click()
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor()
  await page.getByRole('link', { name: 'Français' }).focus()
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Français')
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
  expect(await page.getByRole('button', { name: 'Continue with Google', exact: true }).evaluate(button => document.activeElement === button)).toBe(true)
  const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, outline: getComputedStyle(document.activeElement!).outlineWidth, fits: document.documentElement.scrollWidth <= 320 }))
  expect(focused).toMatchObject({ tag: 'BUTTON', fits: true })
  expect(parseFloat(focused.outline)).toBeGreaterThan(0)
  await page.keyboard.press('Enter')
  await page.waitForURL(origin + '/account?lang=en')
  await page.getByRole('button', { name: 'Sign out' }).waitFor()
  expect(await page.getByText('Browser protocol fixture').count()).toBe(1)
  const cookies = await context.cookies()
  const session = cookies.find(cookie => cookie.name === '__Secure-better-auth.session_token')
  expect({ httpOnly: session?.httpOnly, secure: session?.secure, sameSite: session?.sameSite, domain: session?.domain, path: session?.path }).toEqual({ httpOnly: true, secure: true, sameSite: 'Lax', domain: 'localhost', path: '/' })
  expect(await page.evaluate(() => document.cookie.includes('session_token'))).toBe(false)
  await page.screenshot({ path: '.output/test-evidence/google-browser/task-5-account-en-320.png', fullPage: true })
  const cookieHeader = cookies.map(cookie => cookie.name + '=' + cookie.value).join('; ')
  const logoutPath = await authRpcPath('logout')
  const count = async () => (await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n
  expect(await count()).toBe(1)
  for (const attackOrigin of ['https://other.example', null]) {
    const headers = new Headers({ cookie: cookieHeader, 'x-tsr-serverFn': 'true' })
    if (attackOrigin) headers.set('origin', attackOrigin)
    const response = await fetch(origin + logoutPath, { method: 'POST', headers })
    expect(response.status).toBe(403)
    expect(await count()).toBe(1)
  }
  await page.reload()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL(origin + '/login?lang=en')
  expect(await count()).toBe(0)
  const anonymous = await fetch(origin + await authRpcPath('getAccount'), { headers: { 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true' } })
  expect(anonymous.status).toBe(401)
  expect(await app.googleEvidence()).toMatchObject({ posts: 1, tls: 1, disallowed: 0, activeClientSockets: 0, activeRequests: 0 })
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
  await context.close()
})

test('actual login click rejects a fixture-CA-trusted wrong-host certificate before token POST or session', async () => {
  const port = await unusedLoopbackPort(), wrongOrigin = `http://localhost:${port}`
  const wrongApp = startWeb({ NODE_ENV: 'test', APP_ORIGIN: wrongOrigin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
    RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'browser-wrong-cert', TRUSTED_PROXY_IPS: '127.0.0.2', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only', FIXTURE_GOOGLE_PROTOCOL: 'yes', FIXTURE_GOOGLE_WRONG_HOST: 'yes', REQUEST_TIMEOUT_MS: '10000' })
  let wrongProxy: ReturnType<typeof createServer> | undefined
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined
  try {
    context = await browser.newContext()
    const upstream = (await bounded(wrongApp.ready)).port
    wrongProxy = createServer((incoming, outgoing) => {
      const call = httpRequest({ hostname: '127.0.0.1', port: upstream, method: incoming.method, path: incoming.url, localAddress: '127.0.0.2', headers: { ...incoming.headers, 'x-real-ip': '192.0.2.200' } }, response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing) })
      call.on('error', () => { outgoing.writeHead(502); outgoing.end() }); incoming.pipe(call)
    })
    await new Promise<void>(resolve => wrongProxy!.listen(port, '127.0.0.1', resolve))
    await context.route('**/*', route => new URL(route.request().url()).origin === wrongOrigin ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
      const url = new URL(route.request().url()), code = await wrongApp.registerGoogle(url.href, 'wrong-certificate-browser')
      return route.fulfill({ status: 302, headers: { location: `${wrongOrigin}/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}` } })
    })
    const before = (await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n
    await page.goto(wrongOrigin+'/login?lang=en')
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await page.waitForURL(url => url.pathname === '/login' && url.searchParams.has('error'))
    expect((await context.cookies()).some(cookie => cookie.name.includes('session_token'))).toBe(false)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(before)
    expect(await wrongApp.googleEvidence()).toMatchObject({ posts: 0, disallowed: 0, activeClientSockets: 0, activeRequests: 0 })
  } finally {
    const failures: unknown[] = []
    for (const close of [() => context?.close(), () => wrongProxy && new Promise(resolve => wrongProxy!.close(resolve)), () => wrongApp.cleanup()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Wrong-host browser cleanup failed')
  }
})

test('French browser error announcement, reflow, system font and actual text contrast', async () => {
  const context = await browserContext({ viewport: { width: 320, height: 720 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(5000)
  await page.goto(origin + '/login?lang=fr&error=invalid_code', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continuer avec Google' }).waitFor()
  await page.getByRole('alert').waitFor()
  expect(await page.locator('html').getAttribute('lang')).toBe('fr')
  const view = await page.evaluate(() => {
    const main = document.querySelector('main')!, title = document.querySelector('h1')!, button = document.querySelector('button')!, image = button.querySelector('img')!
    const buttonBox = button.getBoundingClientRect(), imageBox = image.getBoundingClientRect()
    return { fits: document.documentElement.scrollWidth <= innerWidth, font: getComputedStyle(title).fontFamily,
      foreground: getComputedStyle(main).color, background: getComputedStyle(document.body).backgroundColor,
      actionText: getComputedStyle(document.querySelector('.google-sign-in-row')!).color,
      image: { width: imageBox.width, height: imageBox.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        contained: imageBox.left >= buttonBox.left && imageBox.right <= buttonBox.right && imageBox.top >= buttonBox.top && imageBox.bottom <= buttonBox.bottom },
      stylesheets: [...document.styleSheets].map(sheet => sheet.href), text: main.textContent }
  })
  expect(view.fits).toBe(true)
  expect(view.font).toContain('system-ui')
  expect(view.text).not.toMatch(/Sign in|Loading/)
  expect(view.stylesheets.filter(Boolean)).toHaveLength(1)
  function luminance(rgb: string) {
    const values = rgb.match(/[\d.]+/g)!.slice(0,3).map(Number).map(c => { const s = c/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4 })
    return .2126*values[0]+.7152*values[1]+.0722*values[2]
  }
  function contrast(a: string,b: string) { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
  expect(contrast(view.foreground, view.background)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(view.actionText, view.background)).toBeGreaterThanOrEqual(4.5)
  expect(view.image).toEqual({ width: 40, height: 40, naturalWidth: 160, naturalHeight: 160, contained: true })
  await page.screenshot({ path: '.output/test-evidence/google-browser/task-5-login-fr-320.png', fullPage: true })
  await context.close()
})

test('actual callback session defect emits no raw stdout/stderr and publishes no cookie', async () => {
  const context = await browserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
    const target = new URL(route.request().url())
    const code = await app.registerGoogle(target.href, 'fixture-session-defect')
    return route.fulfill({ status: 302, headers: { location: origin + `/api/auth/callback/google?code=${code}&state=` + target.searchParams.get('state') } })
  })
  await stores.administrator.query("CREATE FUNCTION fixture_reject_session_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-fixture-sql-body-marker' USING ERRCODE='23514'; END $$; CREATE TRIGGER fixture_reject_session_log BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION fixture_reject_session_log()")
  try {
    await page.goto(origin + '/login?lang=en')
    const outputStart = app.output().length
    const callbackResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/callback/google')
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    const response = await callbackResponse
    const emitted = app.output().slice(outputStart)
    expect(/# SERVER_ERROR|PgTransactionError|\bat (?:Object\.|file:|[A-Za-z]+ \()|private-fixture-sql-body-marker|fixture-only|session_token|insert into/i.test(emitted)).toBe(false)
    expect(response.status()).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(((await response.allHeaders())['set-cookie'] ?? '').includes('session_token=')).toBe(false)
    expect((await context.cookies()).some(cookie => cookie.name.includes('session_token'))).toBe(false)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(0)
  } finally {
    await stores.administrator.query('DROP TRIGGER fixture_reject_session_log ON session; DROP FUNCTION fixture_reject_session_log()')
    await context.close()
  }
})

// These test-only navigations deliver the native history event used for browser
// back/forward routing, exercising client loaders without a production hook.
async function navigateAuthHistory(page: Page, path: string) {
  await page.evaluate(target => {
    history.pushState(null, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}
function responseGate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function openHydratedAuthPage(page: Page, path: string, lang: 'fr' | 'en') {
  await page.goto(`${origin}${path}?lang=${lang}`, { waitUntil: 'domcontentloaded' })
  const nonce = await page.locator('script[nonce]').first().evaluate(script => script.nonce)
  const other = lang === 'fr' ? 'en' : 'fr'
  await page.getByRole('link', { name: other === 'fr' ? 'Français' : 'English' }).click()
  await page.waitForFunction(locale => document.documentElement.lang === locale, other)
  await page.getByRole('link', { name: lang === 'fr' ? 'Français' : 'English' }).click()
  await page.waitForFunction(locale => document.documentElement.lang === locale, lang)
  // Both real Link transitions completed inside the initial document: the
  // client Router is active before keyboard events or native history tests.
  expect(await page.locator('script[nonce]').first().evaluate(script => script.nonce) === nonce).toBe(true)
}

for (const lang of ['fr', 'en'] as const) {
  for (const mutation of ['begin', 'logout', 'logout-unconfirmed'] as const) test(`task-11 auth response ${lang} ${mutation}: failure stays put, announces and releases pending; genuine logout revokes`, async () => {
    // Removing begin's Response guard navigates to the RPC URL. Removing either
    // logout guard navigates despite failure/unconfirmed revocation. Resetting
    // pending only on success would leave the real buttons unusable for retry.
    const context = await browserContext({ viewport: { width: 320, height: 720 } })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    page.setDefaultNavigationTimeout(5000)
    const t = lang === 'fr'
      ? { begin: 'Continuer avec Google', busy: 'Connexion en cours…', failed: 'La connexion a échoué. Réessayez.', logout: 'Se déconnecter', logoutBusy: 'Déconnexion en cours…', logoutFailed: 'La déconnexion a échoué. Réessayez.' }
      : { begin: 'Continue with Google', busy: 'Signing in…', failed: 'Sign-in failed. Try again.', logout: 'Sign out', logoutBusy: 'Signing out…', logoutFailed: 'Sign-out failed. Try again.' }
    const beginUrl = origin + await authRpcPath('beginGoogleSignIn')
    const logoutUrl = origin + await authRpcPath('logout')
    const rawFailure = { status: 503, headers: { 'x-tss-raw': 'true', 'content-type': 'text/plain' }, body: 'synthetic-auth-failure' }
    try {
      await openHydratedAuthPage(page, '/login', lang)
      const begin = page.getByRole('button', { name: t.begin })
      if (mutation === 'begin') {
      const beginGate = responseGate()
      await page.route(beginUrl, async route => { await beginGate.promise; await route.fulfill(rawFailure) })
      try {
        await begin.focus()
        await page.keyboard.press('Enter')
        await page.getByRole('status').filter({ hasText: t.busy }).waitFor()
        expect(await begin.getAttribute('aria-busy')).toBe('true')
      } finally { beginGate.resolve() }
      await page.waitForFunction(() => !!document.querySelector('main [role="alert"]') || location.pathname !== '/login')
      expect(new URL(page.url()).pathname).toBe('/login')
      await page.getByRole('alert').filter({ hasText: t.failed }).waitFor()
      expect(await begin.getAttribute('aria-busy')).not.toBe('true')
      expect(await begin.isEnabled()).toBe(true)
      expect(await page.getByRole('status').filter({ hasText: t.busy }).count()).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true)
      await page.screenshot({ path: `.output/test-evidence/google-browser/task-11-auth-response-login-${lang}-320.png`, fullPage: true })
      await page.unroute(beginUrl)
      }
      await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
        const target = new URL(route.request().url())
        const code = await app.registerGoogle(target.href, `fixture-response-${lang}-${mutation}`)
        return route.fulfill({ status: 302, headers: { location: origin + `/api/auth/callback/google?code=${code}&state=` + target.searchParams.get('state') } })
      })
      await begin.click()
      await page.waitForURL(`${origin}/account?lang=${lang}`)
      await page.getByText('Browser protocol fixture', { exact: true }).waitFor()
      // Better Auth created this session through its callback and real adapter.
      // Assert only its existence, never print/read cookie or token contents.
      const count = async () => (await stores.administrator.query('SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1', [`fixture-response-${lang}-${mutation}@example.test`])).rows[0].n
      expect(await count()).toBe(1)
      const signOut = page.getByRole('button', { name: t.logout })
      const failures = mutation === 'begin' ? [] : mutation === 'logout' ? [rawFailure] : [
        await rpcResult({ signedOut: false }),
        await rpcResult({}),
        await rpcResult(null),
      ]
      for (const [index, response] of failures.entries()) {
        const gate = responseGate()
        await page.route(logoutUrl, async route => { await gate.promise; await route.fulfill(response) })
        try {
          await signOut.focus()
          await page.keyboard.press('Enter')
          await page.getByRole('status').filter({ hasText: t.logoutBusy }).waitFor()
          expect(await signOut.getAttribute('aria-busy')).toBe('true')
        } finally { gate.resolve() }
        await page.waitForFunction(() => !!document.querySelector('main [role="alert"]') || location.pathname !== '/account')
        expect(new URL(page.url()).pathname).toBe('/account')
        await page.getByRole('alert').filter({ hasText: t.logoutFailed }).waitFor()
        expect(await signOut.getAttribute('aria-busy')).not.toBe('true')
        expect(await signOut.isEnabled()).toBe(true)
        expect(await page.getByRole('status').filter({ hasText: t.logoutBusy }).count()).toBe(0)
        expect(await page.getByText('Browser protocol fixture', { exact: true }).count()).toBe(1)
        expect(await count()).toBe(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true)
        if (index === 0 && mutation === 'logout') await page.screenshot({ path: `.output/test-evidence/google-browser/task-11-auth-response-account-${lang}-320.png`, fullPage: true })
        await page.unroute(logoutUrl)
      }
      await signOut.click()
      await page.waitForURL(`${origin}/login?lang=${lang}`)
      expect(await count()).toBe(0)
    } finally { await context.close() }
  })

  for (const path of ['/account', '/login'] as const) test(`task-11 auth response ${lang} ${path}: delayed client loader shows localized pending then success or safe error`, async () => {
    // Missing route pending UI (or the default 1s delay) loses the timely state;
    // removing either Response guard renders success instead of the error UI.
    const context = await browserContext({ viewport: { width: 320, height: 720 } })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    try {
      await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
        const target = new URL(route.request().url())
        const code = await app.registerGoogle(target.href, `fixture-loader-${lang}`)
        return route.fulfill({ status: 302, headers: { location: origin + `/api/auth/callback/google?code=${code}&state=` + target.searchParams.get('state') } })
      })
      await openHydratedAuthPage(page, '/login', lang)
      await page.getByRole('button', { name: lang === 'fr' ? 'Continuer avec Google' : 'Continue with Google' }).click()
      await page.waitForURL(`${origin}/account?lang=${lang}`)
      await page.getByText('Browser protocol fixture', { exact: true }).waitFor()
        for (const fail of [false, true]) {
          // A fresh document discards cached route data, ensuring a foreground
          // load rather than a successful cached match with background SWR.
          await openHydratedAuthPage(page, '/missing', lang)
          await page.getByRole('heading', { name: lang === 'fr' ? 'Page introuvable' : 'Page not found' }).waitFor()
          const rpcUrl = origin + await authRpcPath(path === '/login' ? 'getLoginAvailability' : 'getAccount')
          const gate = responseGate()
          await page.route(url => url.origin + url.pathname === rpcUrl, async route => {
            await gate.promise
            if (fail) await route.fulfill({ status: 503, headers: { 'x-tss-raw': 'true', 'content-type': 'text/plain' }, body: 'synthetic-loader-failure' })
            else if (path === '/login') await route.fulfill(await rpcResult({ google: false }))
            // Successful account reads retain the real principal/session check.
            else await route.continue()
          })
          try {
            await navigateAuthHistory(page, `${path}?lang=${lang}`)
            await page.getByRole('status').filter({ hasText: lang === 'fr' ? 'Chargement' : 'Loading' }).waitFor({ timeout: 700 })
            expect(await page.locator('main dl').count()).toBe(0)
          } finally { gate.resolve() }
          if (!fail && path === '/login') {
            await page.getByRole('status').filter({ hasText: lang === 'fr' ? 'La connexion Google est indisponible' : 'Google sign-in is currently unavailable' }).waitFor()
            expect(await page.getByRole('alert').count()).toBe(0)
          } else if (fail) {
            await page.getByRole('alert').filter({ hasText: lang === 'fr' ? 'Impossible de charger' : 'Unable to load' }).waitFor()
            expect(await page.locator('main dl').count()).toBe(0)
            expect(await page.locator('main').textContent()).not.toContain('synthetic-loader-failure')
          } else {
            await page.getByText('Browser protocol fixture', { exact: true }).waitFor()
            expect(await page.getByRole('alert').count()).toBe(0)
          }
          expect(await page.getByRole('status').filter({ hasText: lang === 'fr' ? 'Chargement' : 'Loading' }).count()).toBe(0)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true)
          await page.unrouteAll({ behavior: 'wait' })
        }
      await navigateAuthHistory(page, `/account?lang=${lang}`)
      await page.getByRole('button', { name: lang === 'fr' ? 'Se déconnecter' : 'Sign out' }).click()
      await page.waitForURL(`${origin}/login?lang=${lang}`)
    } finally { await context.close() }
  })
}
