import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from 'vitest'
import { Schema } from 'effect'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { googleAccountMessages } from '../../src/ui/auth/messages'

const scrollCache = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Struct({
  scrollX: Schema.Number.check(Schema.isFinite()), scrollY: Schema.Number.check(Schema.isFinite()),
})))

test.each(['en', 'fr'] as const)('compiled Google account consumer in %s: real controls, unknown outcomes, protected refresh and same-User login', async locale => {
  const runId = randomUUID(), directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9d-evidence')
  const evidence: Record<string, unknown> = { runId, locale, scope: 'compiled Chromium with virtual authenticator and controlled Google TLS; not physical-device or genuine BFCache/screen-reader proof' }
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined, web: ReturnType<typeof startWeb> | undefined
  let proxy: ReturnType<typeof createServer> | undefined, browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined
  let stage = 'setup', client = 41, proxyFailures = 0, unexpectedRequests = 0, pageErrors = 0, finishes = 0, googleLinks = 0
  const routeFailures: string[] = []
  let userId = '', sessionId = '', signInSubject = randomUUID(), linkSubject = randomUUID(), accountPath = ''
  let callbackFault = false, refreshFault: 'none' | '500' | '401' = 'none', refreshArmed = false, refreshFaults = 0, callbackCommitted = false
  let focusHoldArmed = false, waitFocusResponse = async () => {}, focusResponseDelivered = () => {}
  const focusProbe = { status: 0, held: false, delivered: false, bytes: 0, sameOriginFetch: false, originPresent: false, refererPresent: false,
    errorType: '', errorFrames: [] as { line: number; column: number }[] }
  const cleanupFailures: string[] = [], canaries = new Set<string>(), pendingProxy = new Set<Promise<void>>(), pendingRoutes = new Set<Promise<void>>()
  const captures: Record<string, unknown>[] = [], releases: (() => void)[] = []
  let consoleText = ''
  const diagnostic = { beginRequests: 0, beginStatuses: [] as number[], finishRequests: 0, finishStatuses: [] as number[], assertions: 0,
    accountStatuses: [] as number[], receiptStatuses: [] as number[], nativeSessionCookiePublished: false }
  const leaks = (text: string) => [...canaries].some(value => value.length >= 8 && text.includes(value))
  function trackProxy(work: Promise<void>, outgoing: ServerResponse) {
    const guarded = work.catch(() => { proxyFailures++; outgoing.destroy() })
    pendingProxy.add(guarded); void guarded.finally(() => pendingProxy.delete(guarded))
  }
  async function drain(response: IncomingMessage) {
    await bounded(new Promise<void>((done, reject) => { response.once('end', done); response.once('error', reject); response.once('aborted', () => reject(new Error('Owned upstream aborted'))); response.resume() }), 10000)
  }
  function routeHandler(label: string, handler: (route: Route) => Promise<void>) {
    return async (route: Route) => {
      const work = handler(route).catch(async () => { routeFailures.push(label); await route.abort().catch(() => {}) })
      pendingRoutes.add(work); await work; pendingRoutes.delete(work)
    }
  }
  try {
    await mkdir(directory, { recursive: true })
    stores = await startDisposableStores(); await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.first_google_passkey_intent,public.google_account_intent TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime`)
    const port = await unusedLoopbackPort(), origin = `http://localhost:${port}`, secret = randomBytes(48).toString('hex')
    for (const value of [secret, stores.hmac, stores.runtimeUrl, stores.redisUrl, new URL(stores.runtimeUrl).password, new URL(stores.redisUrl).password, 'fixture-only', 'fixture-access']) canaries.add(value)
    web = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
      RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'google-account-browser', TRUSTED_PROXY_IPS: '127.0.0.2', AUTH_SECRET: secret,
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only', FIXTURE_GOOGLE_PROTOCOL: 'yes', REQUEST_TIMEOUT_MS: '10000' })
    const upstream = (await bounded(web.ready)).port
    proxy = createServer((incoming, outgoing) => {
      trackProxy((async () => {
        const accountRequest = incoming.url?.split('?')[0] === accountPath
        const holdForFocus = accountRequest && focusHoldArmed
        if (holdForFocus) {
          focusHoldArmed = false
          focusProbe.sameOriginFetch = incoming.headers['sec-fetch-site'] === 'same-origin'
          focusProbe.originPresent = typeof incoming.headers.origin === 'string'
          focusProbe.refererPresent = typeof incoming.headers.referer === 'string'
        }
        const selectedFault = accountRequest && refreshArmed ? refreshFault : 'none'
        if (selectedFault !== 'none') { refreshArmed = false; refreshFaults++ }
        if (selectedFault === '401') await stores!.administrator.query('DELETE FROM session WHERE id=$1', [sessionId])
        await new Promise<void>((done, reject) => {
          const call = httpRequest({ hostname: '127.0.0.1', port: upstream, localAddress: '127.0.0.2', method: incoming.method, path: incoming.url,
            headers: { ...incoming.headers, 'x-real-ip': `192.0.2.${client}` } }, response => {
            void (async () => {
              if (holdForFocus) {
                focusProbe.status = response.statusCode ?? 0
                const chunks: Buffer[] = []
                await bounded(new Promise<void>((resolve, reject) => {
                  response.on('data', (chunk: Buffer) => {
                    focusProbe.bytes += chunk.length
                    if (focusProbe.bytes > 1048576) { response.destroy(); reject(new Error('Owned account response exceeds bound')); return }
                    chunks.push(chunk)
                  })
                  response.once('end', resolve); response.once('error', reject); response.once('aborted', () => reject(new Error('Owned account response aborted')))
                }), 10000)
                if (focusProbe.status === 200) { focusProbe.held = true; await waitFocusResponse() }
                outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(Buffer.concat(chunks))
                focusProbe.delivered = true; focusResponseDelivered(); done(); return
              }
              if (selectedFault === '500') {
                const status = response.statusCode; await drain(response)
                captures.push({ scenario: 'actual-account-request-500', upstreamStatus: status })
                outgoing.writeHead(500, { 'x-tss-raw': 'true', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); outgoing.end('Owned account read transport failure'); done(); return
              }
              if (selectedFault === '401') captures.push({ scenario: 'actual-account-request-401', nativeStatus: response.statusCode })
              if (callbackFault && incoming.url?.split('?')[0] === '/api/auth/account/google/callback') {
                callbackFault = false
                const id = response.headers.location ? new URL(response.headers.location, origin).searchParams.get('googleAccount') : null
                await drain(response)
                const rows = id ? (await stores!.administrator.query("SELECT phase FROM google_account_intent WHERE id=$1 AND user_id=$2", [id, userId])).rows : []
                callbackCommitted = rows.length === 1 && rows[0].phase === 'CONSUMED'
                if (!callbackCommitted) throw new Error('Callback commit witness missing')
                outgoing.writeHead(500, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); outgoing.end('Owned callback response lost'); done(); return
              }
              outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); response.once('end', done); response.once('error', reject)
            })().catch(error => {
              if (holdForFocus) {
                focusProbe.errorType = error instanceof Error ? error.name : typeof error
                focusProbe.errorFrames = [...(error instanceof Error ? error.stack ?? '' : '').matchAll(/google-account-browser\.test\.ts:(\d+):(\d+)/g)]
                  .map(match => ({ line: Number(match[1]), column: Number(match[2]) }))
              }
              reject(error)
            })
          })
          call.once('error', reject); incoming.pipe(call)
        })
      })(), outgoing)
    })
    await new Promise<void>((done, reject) => { proxy!.once('error', reject); proxy!.listen(port, '127.0.0.1', done) })
    browser = await chromium.launch({ headless: true, channel: 'chromium' })
    context = await browser.newContext({ viewport: { width: 320, height: 720 } }); page = await context.newPage()
    await page.addInitScript(() => {
      if (!navigator.credentials) return
      const original = navigator.credentials.get.bind(navigator.credentials)
      const events = { started: 0, aborted: 0, settled: 0 }
      Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: (options?: CredentialRequestOptions) => {
        events.started++
        options?.signal?.addEventListener('abort', () => { events.aborted++ }, { once: true })
        return original(options).finally(() => { events.settled++ })
      } })
      Reflect.set(window, '__googleAccountCredentialEvents', () => ({ ...events }))
    })
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000)
    evidence.browser = browser.version()
    const finishPath = await authRpcPath('finishGoogleAccountUnlink'), beginPath = await authRpcPath('beginGoogleAccountLink'), readPath = await authRpcPath('readGoogleAccountIntent')
    const authorizePath = await authRpcPath('authorizeGoogleAccountLink')
    const beginUnlinkPath = await authRpcPath('beginGoogleAccountUnlink')
    accountPath = await authRpcPath('getAccount')
    page.on('console', message => { consoleText += message.text() }); page.on('pageerror', error => { pageErrors++; consoleText += error.message })
    page.on('request', request => { if (new URL(request.url()).pathname === finishPath) finishes++ })
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === beginUnlinkPath) diagnostic.beginRequests++
      if (path === finishPath) diagnostic.finishRequests++
    })
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (path === beginUnlinkPath) diagnostic.beginStatuses.push(response.status())
      if (path === finishPath) diagnostic.finishStatuses.push(response.status())
      if (path === accountPath) diagnostic.accountStatuses.push(response.status())
      if (path === readPath) diagnostic.receiptStatuses.push(response.status())
      if ([beginUnlinkPath, finishPath, readPath].includes(path) && /session_token=/.test(response.headers()['set-cookie'] ?? '')) diagnostic.nativeSessionCookiePublished = true
    })
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === origin) await route.continue()
      else { unexpectedRequests++; await route.abort() }
    })
    await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
      const work = (async () => {
        const url = new URL(route.request().url()), redirect = url.searchParams.get('redirect_uri'), linking = redirect === origin + '/api/auth/account/google/callback'
        const first = redirect === origin + '/api/auth/first-passkey/google/callback'
        if (!linking && !first && redirect !== origin + '/api/auth/callback/google') throw new Error('Unexpected redirect')
        if (linking) {
          googleLinks++; expect(url.searchParams.get('prompt')).toBe('select_account'); expect(url.searchParams.has('login_hint')).toBe(false)
        }
        const code = await web!.registerGoogle(url.href, linking ? linkSubject : signInSubject,
          first ? { claims: { auth_time: Math.floor(Date.now() / 1000) - 10 } } : linking ? { email: `different-${linkSubject}@example.test` } : undefined)
        canaries.add(code)
        for (const key of ['state', 'nonce']) { const value = url.searchParams.get(key); if (value) canaries.add(value) }
        await route.fulfill({ status: 302, headers: { location: redirect + '?code=' + code + '&state=' + url.searchParams.get('state') } })
      })().catch(async () => { unexpectedRequests++; await route.abort().catch(() => {}) })
      pendingRoutes.add(work); await work; pendingRoutes.delete(work)
    })
    const cdp = await context.newCDPSession(page)
    cdp.on('WebAuthn.credentialAsserted', () => { diagnostic.assertions++ })
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
    const t = googleAccountMessages[locale]
    async function activate(label: string) {
      const control = page!.getByRole('button', { name: label, exact: true })
      await expect.poll(() => control.isEnabled()).toBe(true)
      await control.focus(); expect(await control.evaluate(element => element === document.activeElement)).toBe(true)
      await page!.keyboard.press('Enter')
    }
    async function check(checkpoint: string) {
      stage = checkpoint + ': privacy'
      for (const cookie of await context!.cookies()) if (cookie.name.includes('session_token')) canaries.add(cookie.value)
      const dom = await page!.content(), storage = await page!.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }))
      const privacy = { dom: leaks(dom), console: leaks(consoleText), child: leaks(web!.output()), storage: leaks(JSON.stringify(storage)) }
      captures.push({ checkpoint, privacy })
      expect(Object.values(privacy).some(Boolean)).toBe(false)
      await page!.screenshot({ path: resolve(directory, `google-account-${runId}-${checkpoint}-before-check.png`), fullPage: true })
      stage = checkpoint + ': storage'
      let scrollCacheValid = true
      for (const [, value] of storage.session) {
        try { Schema.decodeUnknownSync(scrollCache)(JSON.parse(value), { onExcessProperty: 'error' }) } catch { scrollCacheValid = false }
      }
      captures.push({ checkpoint, storage: { localCount: storage.local.length, unknownSessionCount: storage.session.filter(([name]) => name !== 'tsr-scroll-restoration-v1_3').length, scrollCacheValid } })
      expect(storage.local.length).toBe(0)
      expect(storage.session.filter(([name]) => name !== 'tsr-scroll-restoration-v1_3').length).toBe(0)
      expect(scrollCacheValid).toBe(true)
      stage = checkpoint + ': viewport'
      const viewport = await page!.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }))
      captures.push({ checkpoint, viewport }); expect(viewport.content <= viewport.viewport).toBe(true)
      stage = checkpoint + ': Axe'
      const axe = await new AxeBuilder({ page: page! }).analyze(), violations = axe.violations.map(value => ({ id: value.id, impact: value.impact }))
      captures.push({ checkpoint, axeRuleIds: violations }); expect(violations).toEqual([])
      stage = checkpoint + ': screenshot'
      await page!.screenshot({ path: resolve(directory, `google-account-${runId}-${checkpoint}.png`), fullPage: true })
      captures.push({ checkpoint, axe: 0, width: 320, privacyCanariesChecked: true })
    }
    stage = 'compiled direct native denial and anonymous protected commands'
    const assertion = registrationCredentialFixture({ challenge: 'anonymous-fixture', rp: { id: 'localhost' } }, origin)
      .authenticationResponse({ challenge: 'anonymous-fixture', rpId: 'localhost' })
    const selector = { intentId: randomUUID() }
    const anonymous = [
      ['beginGoogleAccountLink', locale], ['authorizeGoogleAccountLink', { ...selector, response: assertion }],
      ['beginGoogleAccountUnlink', { accountId: 'opaque-unowned-row' }], ['finishGoogleAccountUnlink', { ...selector, response: assertion }],
      ['readGoogleAccountIntent', selector], ['cancelGoogleAccountIntent', selector],
    ] as const
    for (const [command, data] of anonymous) {
      const response = await context.request.post(origin + await authRpcPath(command), { headers: { origin, 'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, data: await rpcBody(data) })
      expect(response.status()).toBe(401)
      expect(response.headers()['cache-control']).toBe('no-store')
      expect(response.headers()['set-cookie']).toBeUndefined()
    }
    for (const path of ['/application/account/google/authorize', '/application/account/google/complete', '/application/account/google/mutate', '/link-social', '/unlink-account']) {
      for (const method of ['GET', 'POST']) {
        const response = await context.request.fetch(origin + '/api/auth' + path, { method, headers: { origin } })
        expect(response.status()).toBe(404)
      }
    }
    expect((await stores.administrator.query('SELECT count(*)::int n FROM google_account_intent')).rows[0].n).toBe(0)
    expect((await web.googleEvidence()).posts).toBe(0)
    captures.push({ checkpoint: 'compiled-admission', anonymousCommands: 6, directNativeRequests: 10, privateEffects: 0 })
    client++
    stage = 'native Google and first-key setup'
    await page.goto(origin + '/login?lang=en'); await activate('Continue with Google'); await page.waitForURL(url => url.pathname === '/account')
    await page.getByRole('link', { name: 'My personal workspace', exact: true }).click(); await activate('Create my workspace')
    await page.getByRole('button', { name: 'Save name', exact: true }).waitFor(); await page.getByRole('link', { name: 'Back to account', exact: true }).click()
    await activate('Verify with Google'); await page.getByRole('button', { name: 'Create my first passkey', exact: true }).waitFor(); await activate('Create my first passkey')
    await page.getByText('Your first passkey was added.', { exact: true }).waitFor()
    const [original] = (await stores.administrator.query('SELECT s.id,s.user_id FROM session s JOIN account a ON a.user_id=s.user_id WHERE a.account_id=$1', [signInSubject])).rows
    userId = original.user_id; sessionId = original.id
    const originalCookie = (await context.cookies()).find(cookie => cookie.name.includes('session_token'))!.value
    await page.goto(origin + '/account?lang=' + locale)
    const firstUnlink = page.getByRole('button', { name: t.unlink, exact: true })
    stage = 'first unlink: control enabled'; await expect.poll(() => firstUnlink.isEnabled()).toBe(true)
    stage = 'first unlink: focus'; await firstUnlink.focus(); expect(await firstUnlink.evaluate(element => element === document.activeElement)).toBe(true)
    const beforeBegin = diagnostic.beginRequests, beforeBeginStatus = diagnostic.beginStatuses.length, beforeAssert = diagnostic.assertions,
      beforeFinishRequest = diagnostic.finishRequests, beforeFinishStatus = diagnostic.finishStatuses.length, beforeReceiptRead = diagnostic.receiptStatuses.length
    stage = 'first unlink: dispatch'; await page.keyboard.press('Enter')
    stage = 'first unlink: Begin request'; await expect.poll(() => diagnostic.beginRequests > beforeBegin).toBe(true)
    stage = 'first unlink: Begin response'; await expect.poll(() => diagnostic.beginStatuses.length > beforeBeginStatus).toBe(true)
    expect(diagnostic.beginStatuses.at(-1)).toBe(200)
    stage = 'first unlink: native UV assertion'; await expect.poll(() => diagnostic.assertions > beforeAssert).toBe(true)
    stage = 'first unlink: Finish request'; await expect.poll(() => diagnostic.finishRequests > beforeFinishRequest).toBe(true)
    stage = 'first unlink: Finish response'; await expect.poll(() => diagnostic.finishStatuses.length > beforeFinishStatus).toBe(true)
    expect(diagnostic.finishStatuses.at(-1)).toBe(200)
    stage = 'first unlink: confirmed status'; await page.getByText(t.unlinked, { exact: true }).waitFor()
    stage = 'first unlink: account refresh'; await page.getByText(t.notConnected, { exact: true }).waitFor()
    expect(diagnostic.receiptStatuses.length - beforeReceiptRead).toBe(0)
    expect(new URL(page.url()).searchParams.has('googleAccount')).toBe(true)
    captures.push({ checkpoint: 'self-published-selector', originalCeremonyFinished: true, automaticReceiptReads: 0, retainedSelector: true })
    for (const external of ['intent', 'language', 'unmount'] as const) {
      client++; stage = 'external ' + external + ': pending native assertion'
      await page.goto(origin + '/account?lang=' + locale)
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
      const readEvents = async () => Schema.decodeUnknownSync(Schema.Struct({ started: Schema.Number, aborted: Schema.Number, settled: Schema.Number }))(
        await page!.evaluate(() => Reflect.get(window, '__googleAccountCredentialEvents')()))
      const before = await readEvents(), linkNavigations = googleLinks, assertions = diagnostic.assertions
      await activate(t.link)
      await expect.poll(async () => (await readEvents()).started > before.started).toBe(true)
      stage = 'external ' + external + ': real Router transition'
      await page.evaluate(({ external, language, selector }) => {
        if (external === 'unmount') history.pushState(history.state, '', '/workspace?lang=' + language)
        else history.replaceState(history.state, '', '/account?lang=' + (external === 'language' ? language === 'en' ? 'fr' : 'en' : language)
          + (external === 'intent' ? '&googleAccount=' + selector : ''))
      }, { external, language: locale, selector: randomUUID() })
      await expect.poll(async () => (await readEvents()).aborted > before.aborted).toBe(true)
      if (external === 'unmount') await expect.poll(() => page!.locator('.auth-google-account').count()).toBe(0)
      expect(googleLinks).toBe(linkNavigations); expect(diagnostic.assertions).toBe(assertions)
      captures.push({ checkpoint: 'external-' + external, realCredentialRequestAborted: true, noAssertion: true, noProviderNavigation: true })
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
    }
    client++; await page.goto(origin + '/account?lang=' + locale)
    const beforeLinks = googleLinks
    for (const [latePhase, latePath] of [['Begin', beginPath], ['Authorize', authorizePath]] as const) {
      stage = 'late ' + latePhase + ' result after actual navigation'
      let releaseLate = () => {}, held = false, settled = false, transport = ''
      const gate = new Promise<void>(resolve => { releaseLate = resolve }); releases.push(releaseLate)
      await page.route(origin + latePath, routeHandler('late-' + latePhase, async route => {
        const response = await route.fetch(); expect(response.status()).toBe(200); held = true; await gate
        try { await route.fulfill({ response }); transport = 'fulfilled' }
        catch {
          const failure = route.request().failure()?.errorText
          if (failure !== 'net::ERR_ABORTED' && failure !== 'net::ERR_FAILED') throw new Error('Late response has no cancellation witness')
          transport = 'aborted'
        } finally { settled = true }
      }))
      await activate(t.link); await expect.poll(() => held).toBe(true)
      await page.getByRole('link', { name: locale === 'fr' ? 'Mon espace personnel' : 'My personal workspace', exact: true }).click()
      await page.waitForURL(url => url.pathname === '/workspace'); releaseLate(); await bounded(Promise.all([...pendingRoutes]), 12000)
      expect(settled && (transport === 'fulfilled' || transport === 'aborted')).toBe(true)
      expect(googleLinks).toBe(beforeLinks); expect(new URL(page.url()).pathname).toBe('/workspace')
      captures.push({ checkpoint: 'late-' + latePhase, settled, transport, providerNavigationSuppressed: true })
      await page.unroute(origin + latePath); await page.goto(origin + '/account?lang=' + locale)
    }
    stage = 'cancel existing challenge before submission'
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    await activate(t.link); await page.getByRole('button', { name: t.cancel, exact: true }).waitFor(); await activate(t.cancel)
    await page.getByText(t.invalidated, { exact: true }).waitFor()
    expect(googleLinks).toBe(beforeLinks)
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true })
    stage = 'lost callback: authorize and navigate'
    client++; callbackFault = true
    await activate(t.link); await page.waitForURL(url => url.pathname === '/api/auth/account/google/callback')
    stage = 'lost callback: committed witness'; await page.getByText('Owned callback response lost', { exact: true }).waitFor()
    captures.push({ checkpoint: 'lost-callback', callbackCommitted }); expect(callbackCommitted).toBe(true)
    stage = 'lost callback: back navigation'; await page.goBack()
    stage = 'lost callback: confirmed status'; await page.getByText(t.linked, { exact: true }).waitFor()
    stage = 'lost callback: selector URL'
    const selectorRetained = new URL(page.url()).searchParams.has('googleAccount')
    captures.push({ checkpoint: 'lost-callback', selectorRetained }); expect(selectorRetained).toBe(true)
    stage = 'lost callback: original cookie'
    const originalCookieRetained = (await context.cookies()).find(cookie => cookie.name.includes('session_token'))?.value === originalCookie
    captures.push({ checkpoint: 'lost-callback', originalCookieRetained }); expect(originalCookieRetained).toBe(true)
    stage = 'lost callback: original session in DB'
    const originalSessionRows = (await stores.administrator.query('SELECT count(*)::int n FROM session WHERE id=$1 AND user_id=$2', [sessionId, userId])).rows[0].n
    captures.push({ checkpoint: 'lost-callback', originalSessionRows }); expect(originalSessionRows).toBe(1)
    await check('linked')
    stage = 'committed UNLINK raw500 and explicit status check'
    let rawCommitted = false
    await page.route(origin + finishPath, routeHandler('raw-unlink', async route => {
      const response = await route.fetch(), selected = new URL(page!.url()).searchParams.get('googleAccount')
      const rows = (await stores!.administrator.query('SELECT phase FROM google_account_intent WHERE id=$1 AND user_id=$2', [selected, userId])).rows
      rawCommitted = response.status() === 200 && rows.length === 1 && rows[0].phase === 'CONSUMED'
      if (!rawCommitted) throw new Error('Unlink commit witness missing')
      await route.fulfill({ status: 500, headers: { 'x-tss-raw': 'true', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: 'Owned result unconfirmed' })
    }))
    const beforeFinishes = finishes
    await activate(t.unlink); await page.getByText(t.uncertain, { exact: true }).waitFor(); expect(rawCommitted).toBe(true)
    await activate(t.check); await page.getByText(t.unlinked, { exact: true }).waitFor()
    expect(finishes - beforeFinishes).toBe(1)
    await page.unroute(origin + finishPath); await page.reload(); await page.getByText(t.unlinked, { exact: true }).waitFor()
    expect(finishes - beforeFinishes).toBe(1); await check('unlinked-reconciled')
    stage = 'actual ancillary account request failure retains committed LINK'
    refreshFault = '500'; client++; linkSubject = randomUUID()
    await page.route(origin + readPath, routeHandler('read-before-refresh-failure', async route => {
      const response = await route.fetch()
      if (response.status() === 200 && refreshFault !== 'none') refreshArmed = true
      await route.fulfill({ response })
    }))
    await activate(t.link); await page.getByText(t.linked, { exact: true }).waitFor(); await page.getByText(t.refreshFailed, { exact: true }).waitFor()
    expect(refreshFaults).toBe(1)
    refreshFault = 'none'; await page.unroute(origin + readPath)
    stage = 'healthy reload: hold actual account refresh'
    let releaseRefresh = () => {}, delivered = () => {}
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve }), delivery = new Promise<void>(resolve => { delivered = resolve })
    releases.push(releaseRefresh)
    waitFocusResponse = () => refreshGate; focusResponseDelivered = delivered; focusHoldArmed = true
    await page.reload(); await page.getByText(t.linked, { exact: true }).waitFor()
    await expect.poll(() => focusProbe.status !== 0).toBe(true)
    expect(focusProbe.status).toBe(200); await expect.poll(() => focusProbe.held).toBe(true)
    stage = 'healthy reload: user focuses Sign out during refresh'
    const signOutControl = page.getByRole('button', { name: locale === 'fr' ? 'Se déconnecter' : 'Sign out', exact: true })
    await signOutControl.focus(); expect(await signOutControl.evaluate(element => element === document.activeElement)).toBe(true)
    stage = 'healthy reload: deliver response and render'
    const actualResponse = page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.status() === 200)
    releaseRefresh(); await bounded(delivery, 10000)
    await (await actualResponse).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    stage = 'healthy reload: preserve user-selected focus'
    const userFocusPreserved = await signOutControl.evaluate(element => element === document.activeElement)
    captures.push({ checkpoint: 'background-refresh-focus', accountHeld: focusProbe.held, accountDelivered: focusProbe.delivered, responseFinished: true, rendered: true, userFocusPreserved })
    expect(userFocusPreserved).toBe(true)
    stage = 'ordinary Google login then surviving key login reach original User'
    signInSubject = linkSubject
    await activate(locale === 'fr' ? 'Se déconnecter' : 'Sign out'); await page.waitForURL(url => url.pathname === '/login')
    await page.goto(origin + '/login?lang=en'); await activate('Continue with Google'); await page.waitForURL(url => url.pathname === '/account')
    const [googleSession] = (await stores.administrator.query('SELECT id,user_id FROM session WHERE user_id=$1', [userId])).rows
    expect(googleSession.user_id).toBe(userId); sessionId = googleSession.id
    await page.goto(origin + '/account?lang=' + locale); await activate(t.unlink); await page.getByText(t.unlinked, { exact: true }).waitFor()
    await activate(locale === 'fr' ? 'Se déconnecter' : 'Sign out'); await page.goto(origin + '/login?lang=en'); await activate('Sign in with a passkey')
    await page.waitForURL(url => url.pathname === '/account')
    const [keySession] = (await stores.administrator.query('SELECT id,user_id,auth_method FROM session WHERE user_id=$1', [userId])).rows
    expect({ id: keySession.user_id, method: keySession.auth_method }).toEqual({ id: userId, method: 'passkey' }); sessionId = keySession.id
    await page.goto(origin + '/account?lang=' + locale)
    stage = 'actual401 account refresh removes private UI'
    refreshFault = '401'; client++; linkSubject = randomUUID()
    await page.route(origin + readPath, routeHandler('read-before-principal-refusal', async route => { const response = await route.fetch(); if (response.status() === 200) refreshArmed = true; await route.fulfill({ response }) }))
    await activate(t.link)
    await page.getByRole('alert').filter({ hasText: locale === 'fr' ? 'compte' : 'account' }).waitFor()
    await expect.poll(() => page!.locator('.auth-google-account').count()).toBe(0)
    expect(captures.some(value => value.scenario === 'actual-account-request-401' && value.nativeStatus === 401)).toBe(true)
    expect(await page.getByRole('button', { name: locale === 'fr' ? 'Se déconnecter' : 'Sign out', exact: true }).count()).toBe(0)
    expect({ unexpectedRequests, pageErrors, proxyFailures }).toEqual({ unexpectedRequests: 0, pageErrors: 0, proxyFailures: 0 })
    expect(routeFailures).toEqual([])
    evidence.peer = await web.googleEvidence(); evidence.completed = true
    evidence.actions = { finishes, googleLinks, rawCommitted, callbackCommitted, refreshFaults, sameUserGoogle: true, survivingKey: true }
    await cdp.detach()
  } catch (error) {
    evidence.completed = false; evidence.failureStage = stage; evidence.timeout = error instanceof Error && error.name === 'TimeoutError'
    evidence.assertionFailure = error instanceof Error && error.name === 'AssertionError'
    evidence.failureType = error instanceof Error ? error.name : typeof error
    evidence.failureFrames = [...(error instanceof Error ? error.stack ?? '' : '').matchAll(/google-account-browser\.test\.ts:(\d+):(\d+)/g)]
      .map(match => ({ line: Number(match[1]), column: Number(match[2]) }))
    evidence.diagnostic = diagnostic
    evidence.focusProbe = focusProbe
    try {
      if (stores && userId) {
        evidence.databaseFlags = {
          intents: (await stores.administrator.query('SELECT action,phase,count(*)::int n FROM google_account_intent WHERE user_id=$1 GROUP BY action,phase ORDER BY action,phase', [userId])).rows,
          counters: (await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1 ORDER BY counter', [userId])).rows.map(row => row.counter),
          accounts: (await stores.administrator.query('SELECT count(*)::int n FROM account WHERE user_id=$1', [userId])).rows[0].n,
          originalSessionExists: (await stores.administrator.query('SELECT count(*)::int n FROM session WHERE id=$1', [sessionId])).rows[0].n === 1,
        }
      }
      if (page && context) {
        const t = googleAccountMessages[locale]
        evidence.domFlags = { section: await page.locator('.auth-google-account').count(), unlinkVisible: await page.getByRole('button', { name: t.unlink, exact: true }).isVisible(),
          unlinkEnabled: await page.getByRole('button', { name: t.unlink, exact: true }).isEnabled().catch(() => false),
          unsupported: await page.getByText(t.unsupported, { exact: true }).count(), eligibility: await page.getByText(t.eligibility, { exact: true }).count(),
          pending: await page.getByText(t.pending, { exact: true }).count(), refused: await page.getByText(t.refused, { exact: true }).count(),
          uncertain: await page.getByText(t.uncertain, { exact: true }).count(), confirmedUnlink: await page.getByText(t.unlinked, { exact: true }).count(),
          refreshFailure: await page.getByText(t.refreshFailed, { exact: true }).count() }
        for (const cookie of await context.cookies()) if (cookie.name.includes('session_token')) canaries.add(cookie.value)
        if (!leaks(await page.content()) && !leaks(consoleText) && (!web || !leaks(web.output()))) {
          await page.screenshot({ path: resolve(directory, `google-account-${runId}-failure.png`), fullPage: true })
          evidence.failureScreenshotCanaryChecked = true
        } else evidence.failureScreenshotSuppressed = true
      }
    } catch { evidence.diagnosticUnavailable = true }
    throw new Error('Compiled Google account fixture failed at ' + stage)
  } finally {
    for (const release of releases) release()
    refreshArmed = false; refreshFault = 'none'; callbackFault = false; focusHoldArmed = false
    try { await bounded(Promise.allSettled([...pendingRoutes, ...pendingProxy]), 12000) } catch { cleanupFailures.push('request-drain') }
    for (const [name, close] of [['context', () => context?.close()], ['browser', () => browser?.close()],
      ['proxy', () => proxy && new Promise<void>(done => { proxy!.closeAllConnections(); proxy!.close(() => done()) })], ['web', () => web?.cleanup()], ['stores', () => stores?.cleanup()]] as const) {
      try { await close() } catch { cleanupFailures.push(name) }
    }
    evidence.captures = captures; evidence.cleanupFailures = cleanupFailures; evidence.stores = stores?.evidence
    evidence.finalChildCanaryLeak = web ? leaks(web.output()) : false
    if (evidence.finalChildCanaryLeak) cleanupFailures.push('child-canary')
    if (proxyFailures) cleanupFailures.push('proxy-handler')
    evidence.routeFailures = routeFailures
    if (routeFailures.length) cleanupFailures.push('route-handler')
    await writeFile(resolve(directory, `browser-${runId}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
    if (cleanupFailures.length) throw new Error('Owned Google account browser cleanup failed')
  }
}, 180000)
