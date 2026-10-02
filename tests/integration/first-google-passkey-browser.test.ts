import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type Route } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath } from '../helpers/auth-rpc'
import { Schema } from 'effect'

const scrollCache = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Struct({
  scrollX: Schema.Number.check(Schema.isFinite()), scrollY: Schema.Number.check(Schema.isFinite()),
})))

for (const selection of ['baseline', 'account-refresh', 'account-refused'] as const) test(selection === 'baseline'
  ? 'compiled first Google passkey explicit creation and committed raw500 reconciliation then primary login'
  : selection === 'account-refresh' ? 'fix2 real account refresh failure retains confirmed added and original session'
  : 'fix2 real revoked session refuses private account after confirmed receipt', async () => {
  const runId = randomUUID(), directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9c-evidence')
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined, app: ReturnType<typeof startWeb> | undefined
  let proxy: ReturnType<typeof createServer> | undefined, browser: Browser | undefined, stage = 'setup'
  const evidence: Record<string, unknown> = { runId, scope: 'compiled Chromium virtual authenticator on loopback secure context; controlled Google TLS peer' }
  const cleanupFailures: string[] = []
  const canaries = new Set<string>(), privacyChecks: Record<string, unknown>[] = []
  const containsCanary = (text: string) => [...canaries].some(value => value.length >= 8 && text.includes(value))
  let callbackFault: ((response: IncomingMessage, outgoing: ServerResponse) => Promise<void>) | undefined, proxyFailures = 0
  let accountFaultPath: string | undefined
  let accountResponseFault: ((incoming: IncomingMessage, response: IncomingMessage, outgoing: ServerResponse) => Promise<void>) | undefined
  const proxyCalls = new Set<Promise<void>>()
  let client = 1
  try {
    await mkdir(directory, { recursive: true })
    stores = await startDisposableStores(); await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.first_google_passkey_intent TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime`)
    const port = await unusedLoopbackPort(), origin = `http://localhost:${port}`
    const authSecret = randomBytes(48).toString('hex')
    for (const value of [authSecret, stores.hmac, stores.runtimeUrl, stores.redisUrl, new URL(stores.runtimeUrl).password, new URL(stores.redisUrl).password, 'fixture-only', 'fixture-access']) canaries.add(value)
    app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
      RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'first-browser', TRUSTED_PROXY_IPS: '127.0.0.2',
      AUTH_SECRET: authSecret, GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only', FIXTURE_GOOGLE_PROTOCOL: 'yes', REQUEST_TIMEOUT_MS: '10000' })
    const upstream = (await bounded(app.ready)).port
    proxy = createServer((incoming, outgoing) => {
      const call = httpRequest({ hostname: '127.0.0.1', port: upstream, method: incoming.method, path: incoming.url,
        localAddress: '127.0.0.2', headers: { ...incoming.headers, 'x-real-ip': `192.0.2.${client}` } }, response => {
          const accountFault = accountResponseFault
          if (accountFault && incoming.url?.split('?')[0] === accountFaultPath) {
            const work = accountFault(incoming, response, outgoing).catch(() => { proxyFailures++; response.destroy(); outgoing.destroy() })
            proxyCalls.add(work); void work.then(() => { proxyCalls.delete(work) }); return
          }
          const fault = callbackFault
          if (fault && incoming.url?.split('?')[0] === '/api/auth/first-passkey/google/callback') {
            const work = fault(response, outgoing).catch(() => { proxyFailures++; response.destroy(); outgoing.destroy() })
            proxyCalls.add(work); void work.then(() => { proxyCalls.delete(work) }); return
          }
          outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing)
        })
      call.on('error', () => { outgoing.writeHead(502); outgoing.end() }); incoming.pipe(call)
    })
    await new Promise<void>((done, reject) => { proxy!.once('error', () => reject(new Error('Owned proxy failed'))); proxy!.listen(port, '127.0.0.1', done) })
    browser = await chromium.launch({ headless: true, channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] })
    evidence.browser = browser.version()
    const finishPath = await authRpcPath('finishFirstGooglePasskey')
    const accountPath = await authRpcPath('getAccount')
    const beginPath = await authRpcPath('beginFirstGooglePasskey'), readPath = await authRpcPath('readFirstGooglePasskey'), preparePath = await authRpcPath('prepareFirstGooglePasskey')
    const results: Record<string, unknown>[] = []
    const caseObservations: Record<string, unknown>[] = []
    evidence.results = results; evidence.caseObservations = caseObservations
    for (const outcome of (selection === 'account-refused' ? ['account-refused'] as const : selection === 'account-refresh' ? ['account-refresh'] as const : ['normal', 'raw500', 'callback500', 'late-begin', 'late-decoded-begin', 'missing-proof', 'stale-proof'] as const)) {
      client++; stage = outcome + ': browser login'
      const context = await browser.newContext({ viewport: { width: 320, height: 720 } })
      const page = await context.newPage(), subject = randomUUID()
      page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000)
      let unexpectedRequests = 0, pageErrors = 0, finishes = 0, nativeFinishStatus = 0, providerNavigations = 0, nativeCallbackStatus = 0, recoveredIntent = '', prepares = 0
      let routeFailures = 0, consoleText = '', boundUserId = '', beforeResponseAuthorized = false, beforeResponseConsumedKey = false
      let callbackProxyInvoked = false, callbackProxyDelivered = false
      let headerChecks = 0, headerFailures = 0
      const accountCase = outcome === 'account-refresh' || outcome === 'account-refused'
      const accountFault = { requests: 0, upstreamStatus: 0, delivered: false, originalSessionValid: false, sameOriginFetchMetadata: false, originPresent: false, refererPresent: false, sessionRevoked: false, nativeRefusal: false }
      if (accountCase) evidence.accountFault = accountFault
      const shows: { documentId: string; persisted: boolean; trusted: boolean }[] = []
      const releases: (() => void)[] = []
      const routeCalls = new Set<Promise<void>>(), routeFailureStages: string[] = []
      const keyboardActivations: string[] = [], announcedTransitions: string[] = []
      let restoreBrowser: (() => Promise<void>) | undefined
      async function activate(label: string) {
        const button = page.getByRole('button', { name: label, exact: true })
        if (outcome === 'account-refresh') {
          const witness = { label, enabled: false, focused: false, dispatched: false }
          const steps = (evidence.keyboardSteps ??= []) as typeof witness[]
          steps.push(witness); stage = 'keyboard: enabled ' + label
          await expect.poll(() => button.isEnabled()).toBe(true); witness.enabled = true
          stage = 'keyboard: focus ' + label
          await button.focus(); witness.focused = await button.evaluate(node => node === document.activeElement)
          expect(witness.focused).toBe(true)
          stage = 'keyboard: Enter ' + label
          await page.keyboard.press('Enter'); witness.dispatched = true; keyboardActivations.push(label)
        } else await button.click()
      }
      function safeRoute(operation: string, run: (route: Route) => Promise<void>) {
        return (route: Route) => {
          const enteredStage = stage
          const work = (async () => {
            try { await run(route) }
            catch {
              routeFailures++; routeFailureStages.push(operation + ':' + enteredStage)
              try { await route.abort('failed') } catch { /* The owned request may already be closed. */ }
            }
          })()
          routeCalls.add(work); void work.then(() => { routeCalls.delete(work) }); return work
        }
      }
      async function commonChecks(checkpoint: string) {
        for (const cookie of await context.cookies()) if (cookie.name.includes('session_token')) {
          canaries.add(cookie.value); try { canaries.add(decodeURIComponent(cookie.value)) } catch {}
        }
        const dom = await page.content()
        const storage = await page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }))
        const leaked = { renderedAppDom: containsCanary(dom), browserStorage: containsCanary(JSON.stringify(storage)), consoleText: containsCanary(consoleText), childOutput: containsCanary(app!.output()) }
        const unknownSession = storage.session.filter(([key]) => key !== 'tsr-scroll-restoration-v1_3').length
        let nativeScrollCacheValid = true
        for (const [key, value] of storage.session) if (key === 'tsr-scroll-restoration-v1_3') {
          try { Schema.decodeUnknownSync(scrollCache)(JSON.parse(value), { onExcessProperty: 'error' }) }
          catch { nativeScrollCacheValid = false }
        }
        const storageFacts = { localCount: storage.local.length, sessionCount: storage.session.length, unknownSessionCount: unknownSession, nativeScrollCacheValid }
        privacyChecks.push({ outcome, checkpoint, checked: Object.keys(leaked), leaked, storageFacts, counters: { unexpectedRequests, pageErrors, routeFailures, headerChecks, headerFailures }, scope: 'known synthetic auth/HMAC/DB secrets, issued fixture codes/state and observed session-cookie canaries only; exact native numeric scroll cache allowed; not browser URL, heap or universal privacy' })
        try { expect(Object.values(leaked).some(Boolean)).toBe(false) } catch { evidence.failureCheck = 'known-canary'; throw new Error('Scoped canary check failed') }
        try { expect({ local: storage.local.length, unknownSession, nativeScrollCacheValid }).toEqual({ local: 0, unknownSession: 0, nativeScrollCacheValid: true }) }
        catch { evidence.failureCheck = 'storage-shape'; throw new Error('Browser storage contract failed') }
        try { expect({ unexpectedRequests, pageErrors, routeFailures, headerFailures, proxyFailures }).toEqual({ unexpectedRequests: 0, pageErrors: 0, routeFailures: 0, headerFailures: 0, proxyFailures: 0 }) }
        catch { evidence.failureCheck = 'boundary-counters'; throw new Error('Browser boundary counters failed') }
      }
      await page.exposeFunction('__firstObserveShow', (value: { documentId: string; persisted: boolean; trusted: boolean }) => { shows.push(value) })
      await page.addInitScript(() => {
        const documentId = crypto.randomUUID(); Reflect.set(window, '__firstDocumentId', documentId)
        addEventListener('pageshow', event => { void Reflect.get(window, '__firstObserveShow')({ documentId, persisted: event.persisted, trusted: event.isTrusted }).catch(() => {}) })
      })
      page.on('pageerror', error => { pageErrors++; consoleText += error.message })
      page.on('console', message => { consoleText += message.text() })
      page.on('request', request => { if (new URL(request.url()).pathname === preparePath) prepares++ })
      page.on('response', response => {
        const url = new URL(response.url())
        if (url.origin === origin && (url.pathname === '/account' || url.pathname.startsWith('/_serverFn/') || url.pathname === '/api/auth/first-passkey/google/callback')) {
          headerChecks++
          const headers = response.headers()
          if (headers['cache-control'] !== 'no-store' || headers['referrer-policy'] !== 'no-referrer') headerFailures++
        }
      })
      await context.route('**/*', safeRoute('origin', async route => {
        if (new URL(route.request().url()).origin === origin) await route.continue()
        else { unexpectedRequests++; await route.abort() }
      }))
      await page.route('https://accounts.google.com/o/oauth2/v2/auth*', safeRoute('google', async route => {
        providerNavigations++
        const url = new URL(route.request().url()), redirect = url.searchParams.get('redirect_uri')
        const first = redirect === origin + '/api/auth/first-passkey/google/callback'
        if (!first && redirect !== origin + '/api/auth/callback/google') { unexpectedRequests++; await route.abort(); return }
        const code = await app!.registerGoogle(url.href, subject, first && outcome !== 'missing-proof'
          ? { claims: { auth_time: Math.floor(Date.now() / 1000) - (outcome === 'stale-proof' ? 301 : 10) } } : undefined)
        canaries.add(code); for (const key of ['state', 'nonce']) { const value = url.searchParams.get(key); if (value) canaries.add(value) }
        await route.fulfill({ status: 302, headers: { location: redirect + '?code=' + code + '&state=' + url.searchParams.get('state') } })
      }))
      if (outcome === 'callback500') callbackFault = async (response, outgoing) => {
        callbackProxyInvoked = true; nativeCallbackStatus = response.statusCode ?? 0
        const location = response.headers.location
        if (location) recoveredIntent = new URL(location, origin).searchParams.get('firstPasskey') ?? ''
        await bounded(new Promise<void>((done, reject) => {
          response.once('end', done)
          response.once('error', () => reject(new Error('Owned callback upstream failed')))
          response.once('aborted', () => reject(new Error('Owned callback upstream aborted')))
          response.resume()
        }), 10000)
        const rows = (await stores!.administrator.query('SELECT phase FROM first_google_passkey_intent WHERE id=$1 AND user_id=$2', [recoveredIntent, boundUserId])).rows
        beforeResponseAuthorized = nativeCallbackStatus === 303 && rows.length === 1 && rows[0].phase === 'AUTHORIZED'
        if (!beforeResponseAuthorized) throw new Error('Callback commit witness unavailable')
        outgoing.writeHead(500, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'text/plain; charset=utf-8' })
        outgoing.end('Controlled callback outcome unconfirmed'); callbackProxyDelivered = true
      }
      await page.route(origin + finishPath, safeRoute('finish', async route => {
        finishes++
        if (outcome !== 'raw500' && !accountCase) { await route.continue(); return }
        const response = await route.fetch({ timeout: 10000 }); nativeFinishStatus = response.status()
        const target = new URL(page.url()).searchParams.get('firstPasskey')
        const rows = (await stores!.administrator.query(`SELECT i.phase,EXISTS(SELECT 1 FROM passkey p WHERE p.id=i.passkey_id AND p.user_id=i.user_id) matching_key
          FROM first_google_passkey_intent i WHERE i.id=$1 AND i.user_id=$2`, [target, boundUserId])).rows
        beforeResponseConsumedKey = nativeFinishStatus === 200 && rows.length === 1 && rows[0].phase === 'CONSUMED' && rows[0].matching_key === true
        if (!beforeResponseConsumedKey) throw new Error('Finish commit witness unavailable')
        await route.fulfill({ status: 500, headers: { 'x-tss-raw': 'true', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, contentType: 'text/plain', body: 'Unconfirmed fixture outcome' })
      }))
      const cdp = await context.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
      try {
        await page.goto(origin + '/login?lang=en')
        const google = page.getByRole('button', { name: 'Continue with Google', exact: true })
        await expect.poll(() => google.isEnabled()).toBe(true)
        await google.focus(); await page.keyboard.press('Enter')
        await page.waitForURL(url => url.pathname === '/account')
        await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Workspace', exact: true }).click()
        await page.getByRole('button', { name: 'Create my workspace', exact: true }).click()
        await page.getByRole('button', { name: 'Save name', exact: true }).waitFor()
        await page.getByRole('link', { name: 'Back to account', exact: true }).click()
        await page.getByRole('button', { name: 'Verify with Google', exact: true }).waitFor()
        const originalCookie = (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
        expect(Boolean(originalCookie?.secure && originalCookie.httpOnly)).toBe(true)
        const original = (await stores.administrator.query('SELECT s.id,s.user_id FROM session s JOIN account a ON a.user_id=s.user_id WHERE a.account_id=$1', [subject])).rows[0]
        boundUserId = String(original.user_id)
        await commonChecks('linked-account')
        const beforeDocument = await page.evaluate(() => String(Reflect.get(window, '__firstDocumentId')))
        if (outcome === 'late-begin') {
          stage = 'late-begin: withheld committed Begin then real navigation cancellation'
          let release = () => {}, waiting = false, nativeStatus = 0, settled = false, transportFulfilled = false, transportCancelled = false
          const gate = new Promise<void>(resolve => { release = resolve })
          releases.push(release)
          await page.route(origin + beginPath, safeRoute('late-begin', async route => {
            const response = await route.fetch({ timeout: 10000 }); nativeStatus = response.status(); waiting = true
            await gate
            try { await route.fulfill({ response }); transportFulfilled = true }
            catch {
              const error = route.request().failure()?.errorText
              if (error === 'net::ERR_ABORTED' || error === 'net::ERR_FAILED') transportCancelled = true
              else throw new Error('Late transport failed without cancellation witness')
            } finally { settled = true }
          }))
          await page.getByRole('button', { name: 'Verify with Google', exact: true }).click()
          await expect.poll(() => waiting).toBe(true)
          expect(nativeStatus).toBe(200)
          await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Workspace', exact: true }).click()
          await page.waitForURL(url => url.pathname === '/workspace')
          release(); await expect.poll(() => settled).toBe(true)
          expect(transportFulfilled || transportCancelled).toBe(true)
          expect(providerNavigations).toBe(1)
          expect(new URL(page.url()).pathname).toBe('/workspace')
          await page.goBack()
          await page.getByRole('button', { name: 'Verify with Google', exact: true }).waitFor()
          expect(new URL(page.url()).searchParams.has('firstPasskey')).toBe(false)
          expect(providerNavigations).toBe(1)
          await commonChecks('late-navigation-cancellation')
          results.push({ outcome, nativeStatus, providerNavigations, transportFulfilled, transportCancelled, decodedCompletionProven: false, lateBeginDidNotRewriteHistory: true }); continue
        }
        if (outcome === 'late-decoded-begin') {
          stage = 'late-decoded-begin: actual decoded response held across controlled retained-document invalidation'
          await page.evaluate(path => {
            const originalFetch = window.fetch
            let release = () => {}, armed = true, paused = false, decodedReturned = false, nativeStatus = 0
            const gate = new Promise<void>(resolve => { release = resolve })
            window.fetch = async (resource, init) => {
              const selected = new URL(resource instanceof Request ? resource.url : String(resource), location.href).pathname === path
              if (!selected || !armed) return originalFetch(resource, init)
              armed = false
              const response = await originalFetch(resource, init ? { ...init, signal: undefined } : init)
              nativeStatus = response.status
              const json = response.json.bind(response)
              response.json = async () => {
                const value: unknown = await json()
                paused = true; await gate; decodedReturned = true; return value
              }
              return response
            }
            Reflect.set(window, '__firstDeferred', { state: () => ({ paused, decodedReturned, nativeStatus }), release,
              restore: () => { release(); window.fetch = originalFetch } })
          }, beginPath)
          restoreBrowser = () => page.evaluate(() => { Reflect.get(window, '__firstDeferred')?.restore() })
          await page.getByRole('button', { name: 'Verify with Google', exact: true }).click()
          await page.waitForFunction(() => Reflect.get(window, '__firstDeferred').state().paused)
          expect(await page.evaluate(() => Reflect.get(window, '__firstDeferred').state().nativeStatus)).toBe(200)
          expect((await stores.administrator.query("SELECT count(*)::int n FROM first_google_passkey_intent WHERE user_id=$1 AND phase='PENDING_GOOGLE'", [original.user_id])).rows[0].n).toBe(1)
          await page.evaluate(() => {
            dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
            dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
            Reflect.get(window, '__firstDeferred').release()
          })
          await page.waitForFunction(() => Reflect.get(window, '__firstDeferred').state().decodedReturned)
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          expect(await page.evaluate(value => String(Reflect.get(window, '__firstDocumentId')) === value, beforeDocument)).toBe(true)
          expect(new URL(page.url()).pathname === '/account' && !new URL(page.url()).searchParams.has('firstPasskey')).toBe(true)
          expect(providerNavigations).toBe(1)
          expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length).toBe(0)
          await commonChecks('controlled-retained-late-decoded-begin')
          results.push({ outcome, realBeginStatus: 200, actualDecodedResponseReturned: true, syntheticRetainedDocumentEvents: true,
            documentRetained: true, lateBeginDidNotRewriteHistory: true, providerNavigations }); continue
        }
        stage = outcome + ': proof return and reload'
        await activate('Verify with Google')
        if (outcome === 'callback500') {
          await page.getByText('Controlled callback outcome unconfirmed', { exact: true }).waitFor()
          expect(nativeCallbackStatus).toBe(303)
          expect((await stores.administrator.query('SELECT phase FROM first_google_passkey_intent WHERE id=$1 AND user_id=$2', [recoveredIntent, original.user_id])).rows[0].phase).toBe('AUTHORIZED')
          stage = 'callback500: actual Back recovers committed intent'
          await page.goBack()
          await page.getByRole('button', { name: 'Create my first passkey', exact: true }).waitFor()
          expect(new URL(page.url()).searchParams.get('firstPasskey') === recoveredIntent).toBe(true)
          evidence.callbackBack = { retainedDocumentObserved: shows.some(show => show.documentId === beforeDocument && show.persisted && show.trusted), actualBackRecoveredOriginalIntent: true, callbackProxyInvoked, callbackProxyDelivered, nativeCallbackStatus, beforeResponseAuthorized }
        } else await page.waitForURL(url => url.pathname === '/account' && url.searchParams.has('firstPasskey'))
        if (outcome === 'missing-proof' || outcome === 'stale-proof') {
          await page.getByText(outcome === 'missing-proof'
            ? 'Google did not provide the recent authentication proof required to create your first passkey. Your application session has not been replaced.'
            : 'The Google authentication is too old. Another account selection or consent round trip may not make it recent.', { exact: true }).waitFor()
          expect(await page.getByRole('button', { name: 'Create my first passkey', exact: true }).count()).toBe(0)
          expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [original.user_id])).rows[0].n).toBe(0)
          expect((await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')?.value === originalCookie?.value).toBe(true)
          await page.getByRole('link', { name: 'Français', exact: true }).click()
          await page.getByText(outcome === 'missing-proof'
            ? 'Google n’a pas fourni la preuve d’authentification récente nécessaire à votre première passkey. Votre session applicative n’a pas été remplacée.'
            : 'L’authentification Google est trop ancienne. Un autre choix de compte ou consentement ne la rendra pas nécessairement récente.', { exact: true }).waitFor()
          await commonChecks('translated-proof-refusal')
          results.push({ outcome, finishes, preservedSession: true, insertedKeys: 0, translatedRefusal: true }); continue
        }
        if (outcome === 'account-refresh') stage = 'keyboard: await authorized Create'
        await page.getByRole('button', { name: 'Create my first passkey', exact: true }).waitFor()
        if (outcome === 'account-refresh') {
          stage = 'keyboard: authorized live-region'
          const roleCount = await page.getByRole('status').filter({ hasText: 'Recent proof accepted. No key has been added yet. You can now create your passkey.' }).count()
          evidence.authorizedRoleCount = roleCount; expect(roleCount).toBe(1)
          announcedTransitions.push('authorized')
        }
        if (outcome === 'account-refresh') stage = 'keyboard: reload authorized document'
        await page.reload()
        if (outcome === 'account-refresh') {
          stage = 'keyboard: post-reload Create'
          evidence.postReloadCreateVisible = await page.getByRole('button', { name: 'Create my first passkey', exact: true }).isVisible()
        }
        await page.getByRole('button', { name: 'Create my first passkey', exact: true }).waitFor()
        if (outcome === 'account-refresh') evidence.postReloadCreateVisible = true
        if (outcome === 'account-refresh') stage = 'keyboard: zero browser credentials'
        const credentialCount = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length
        if (outcome === 'account-refresh') evidence.beforeCreateCredentials = credentialCount
        expect(credentialCount).toBe(0)
        if (outcome === 'account-refresh') stage = 'keyboard: zero stored keys'
        const storedKeyCount = (await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [original.user_id])).rows[0].n
        if (outcome === 'account-refresh') evidence.beforeCreateStoredKeys = storedKeyCount
        expect(storedKeyCount).toBe(0)
        if (outcome === 'callback500') {
          stage = 'callback500: controlled retained-document handler invalidates cached authorization'
          let release = () => {}, reading = false
          const gate = new Promise<void>(resolve => { release = resolve })
          releases.push(release)
          await page.route(origin + readPath, safeRoute('read', async route => { reading = true; await gate; await route.continue() }))
          const beforePrepares = prepares
          await page.evaluate(() => {
            const oldCreate = [...document.querySelectorAll('button')].find(button => button.textContent === 'Create my first passkey')
            if (!oldCreate) throw new Error('Cached Create control missing')
            dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
            oldCreate.click()
          })
          await expect.poll(() => reading).toBe(true)
          expect(prepares).toBe(beforePrepares)
          expect(await page.getByRole('button', { name: 'Create my first passkey', exact: true }).count()).toBe(0)
          release()
          await page.getByRole('button', { name: 'Create my first passkey', exact: true }).waitFor()
          await page.unroute(origin + readPath)
          evidence.controlledRetainedHandler = { syntheticPersistedEvent: true, cachedCreateRefusedDuringProtectedRead: true, noAutomaticCredential: true }
        }
        if (outcome === 'account-refresh') stage = 'keyboard: authorized privacy'
        await commonChecks('authorized-before-creation')
        if (outcome === 'account-refresh') stage = 'keyboard: authorized screenshot'
        await page.screenshot({ path: resolve(directory, `browser-${runId}-${outcome}-authorized.png`), fullPage: true })
        if (outcome === 'account-refresh') stage = 'keyboard: secure viewport'
        const viewport = await page.evaluate(() => ({ secure: isSecureContext, fits: document.documentElement.scrollWidth <= innerWidth, width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
        if (outcome === 'account-refresh') evidence.viewport = viewport
        expect({ secure: viewport.secure, fits: viewport.fits }).toEqual({ secure: true, fits: true })
        if (outcome === 'account-refresh') stage = 'keyboard: Axe'
        const axe = await new AxeBuilder({ page }).include('.first-google-passkey').analyze()
        if (outcome === 'account-refresh') { evidence.axeViolationCount = axe.violations.length; evidence.axeRuleIds = axe.violations.map(item => item.id) }
        expect(axe.violations.map(item => item.id)).toEqual([])
        stage = outcome + ': explicit creation'
        await activate('Create my first passkey')
        if (outcome === 'raw500' || accountCase) {
          if (outcome === 'account-refresh') stage = 'keyboard: await unconfirmed live-region'
          await page.getByText('The outcome is unconfirmed. Check it before starting again.', { exact: true }).waitFor()
          expect(nativeFinishStatus).toBe(200)
          expect((await stores.administrator.query('SELECT count(*)::int n FROM passkey WHERE user_id=$1', [original.user_id])).rows[0].n).toBe(1)
          if (outcome === 'account-refresh') {
            const roleCount = await page.getByRole('status').filter({ hasText: 'The outcome is unconfirmed. Check it before starting again.' }).count()
            evidence.unconfirmedRoleCount = roleCount; expect(roleCount).toBe(1)
            announcedTransitions.push('unconfirmed')
          }
          if (accountCase) {
            stage = 'account-refresh: arm real account request failure'
            if (outcome === 'account-refused') await page.route(origin + readPath, safeRoute('revoke-before-refresh', async route => {
              const response = await route.fetch({ timeout: 10000 })
              if (response.status() !== 200 || !beforeResponseConsumedKey) throw new Error('Protected receipt witness unavailable')
              const deleted = await stores!.administrator.query('DELETE FROM session WHERE id=$1 AND user_id=$2 RETURNING id', [original.id, original.user_id])
              accountFault.sessionRevoked = deleted.rowCount === 1
              if (!accountFault.sessionRevoked) throw new Error('Owned session revocation unavailable')
              await route.fulfill({ response })
            }))
            accountFaultPath = accountPath
            accountResponseFault = async (incoming, response, outgoing) => {
              accountFault.requests++
              if (accountFault.requests !== 1) { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); return }
              accountFault.sameOriginFetchMetadata = incoming.headers['sec-fetch-site'] === 'same-origin'
              accountFault.originPresent = incoming.headers.origin !== undefined
              accountFault.refererPresent = incoming.headers.referer !== undefined
              accountFault.upstreamStatus = response.statusCode ?? 0
              if (outcome === 'account-refused') {
                const remaining = await stores!.administrator.query('SELECT id FROM session WHERE id=$1 AND user_id=$2', [original.id, original.user_id])
                accountFault.nativeRefusal = accountFault.sessionRevoked && remaining.rowCount === 0 && response.statusCode === 401
                if (!accountFault.nativeRefusal) throw new Error('Native session refusal unavailable')
                outgoing.writeHead(response.statusCode!, response.headers)
                await bounded(new Promise<void>((done, reject) => {
                  outgoing.once('finish', done)
                  outgoing.once('error', () => reject(new Error('Owned account refusal delivery failed')))
                  response.once('error', () => reject(new Error('Owned account refusal upstream failed')))
                  response.pipe(outgoing)
                }), 10000)
                accountFault.delivered = true; return
              }
              await bounded(new Promise<void>((done, reject) => {
                response.once('end', done)
                response.once('error', () => reject(new Error('Owned account upstream failed')))
                response.once('aborted', () => reject(new Error('Owned account upstream aborted')))
                response.resume()
              }), 10000)
              const rows = await stores!.administrator.query('SELECT id FROM session WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()', [original.id, original.user_id])
              accountFault.originalSessionValid = accountFault.upstreamStatus === 200 && rows.rowCount === 1
                && (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')?.value === originalCookie?.value
              if (!accountFault.originalSessionValid || !beforeResponseConsumedKey) throw new Error('Account refresh native witness unavailable')
              outgoing.writeHead(503, { 'x-tss-raw': 'true', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'text/plain; charset=utf-8' })
              outgoing.end('Controlled account refresh unavailable')
              accountFault.delivered = true
            }
          }
          await activate('Check the outcome')
        }
        if (accountCase) {
          stage = 'account-refresh: real loader settlement'
          await expect.poll(() => accountFault.delivered).toBe(true)
          await page.waitForFunction(() => window.__TSR_ROUTER__?.state.isLoading === false)
          const added = page.getByRole('status').filter({ hasText: 'Your first passkey was added.' })
          const refreshAlert = page.getByRole('alert').filter({ hasText: 'The account view could not refresh. Your passkey was added.' })
          const unavailable = page.getByRole('alert').filter({ hasText: 'Unable to load your account. Try again or sign in again.' })
          await expect.poll(async () => await unavailable.isVisible() || await refreshAlert.isVisible()).toBe(true)
          const view = { added: await added.isVisible(), refreshAlert: await refreshAlert.isVisible(), unavailable: await unavailable.isVisible(),
            createControls: await page.getByRole('button', { name: 'Create my first passkey', exact: true }).count(), prepares, finishes }
          evidence.accountRefreshView = view
          await commonChecks('real-account-refresh-failure')
          if (outcome === 'account-refused') {
            stage = 'account-refused: fail closed on real revoked session'
            expect(view).toEqual({ added: false, refreshAlert: false, unavailable: true, createControls: 0, prepares: 1, finishes: 1 })
            expect(await page.locator('.first-google-passkey').count()).toBe(0)
            expect(await page.getByRole('button', { name: 'Sign out', exact: true }).count()).toBe(0)
            expect(await page.getByText('Browser protocol fixture', { exact: true }).count()).toBe(0)
            expect(accountFault.nativeRefusal).toBe(true)
            results.push({ outcome, actualNative401: true, sessionRevoked: true, privatePanelRemoved: true, prepares, finishes }); continue
          }
          stage = 'account-refresh: retain confirmed truth'
          expect(view).toEqual({ added: true, refreshAlert: true, unavailable: false, createControls: 0, prepares: 1, finishes: 1 })
          expect(accountFault.requests).toBe(1)
        }
        if (outcome === 'account-refresh') stage = 'keyboard: await added live-region'
        await page.getByText('Your first passkey was added.', { exact: true }).waitFor()
        if (outcome === 'account-refresh') {
          stage = 'keyboard: await ancillary refresh alert'
          await page.getByRole('alert').filter({ hasText: 'The account view could not refresh. Your passkey was added.' }).waitFor()
          stage = 'keyboard: added live-region'
          const roleCount = await page.getByRole('status').filter({ hasText: 'Your first passkey was added.' }).count()
          evidence.addedRoleCount = roleCount; expect(roleCount).toBe(1)
          expect(accountFault.requests).toBe(1)
          expect(await page.getByRole('button', { name: 'Create my first passkey', exact: true }).count()).toBe(0)
          announcedTransitions.push('added', 'ancillary-refresh-alert')
          expect(keyboardActivations).toEqual(['Verify with Google', 'Create my first passkey', 'Check the outcome'])
          evidence.keyboard = { activations: keyboardActivations, announcedTransitions, actualCommittedKey: beforeResponseConsumedKey, refreshCalls: 1, confirmedAddedRetained: true }
          stage = 'account-refresh: eventual healthy reload'
          await page.reload()
          await expect.poll(() => page.locator('.additional-passkey:not(.first-google-passkey) li').count()).toBe(1)
          await page.getByRole('status').filter({ hasText: 'Your first passkey was added.' }).waitFor()
          expect({ prepares, finishes }).toEqual({ prepares: 1, finishes: 1 })
          evidence.healthyAccountReload = true
        }
        expect(finishes).toBe(1)
        const finalCookie = (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
        expect(finalCookie?.value === originalCookie?.value).toBe(true)
        expect((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE id=$1 AND user_id=$2', [original.id, original.user_id])).rows[0].n).toBe(1)
        stage = outcome + ': logout and primary key login'
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await page.waitForURL(url => url.pathname === '/login')
        await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click()
        await page.waitForURL(url => url.pathname === '/account')
        await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
        const row = (await stores.administrator.query('SELECT id,user_id,auth_method FROM session WHERE user_id=$1', [original.user_id])).rows
        expect(row.length === 1 && row[0].id !== original.id && row[0].auth_method === 'passkey').toBe(true)
        await commonChecks('same-user-key-login')
        results.push({ outcome, finishes, nativeFinishStatus, preSubstitutionReceipt: { checked: outcome === 'raw500' || accountCase, confirmed: beforeResponseConsumedKey }, preservedSession: true, sameUserKeyLogin: true, noAutoCreationOnReload: true, axeViolations: 0 })
      } finally {
        for (const release of releases) release()
        try { await restoreBrowser?.() } catch { cleanupFailures.push('browser-deferred') }
        try { await bounded((async () => { while (routeCalls.size) await Promise.all([...routeCalls]) })(), 12000) } catch { cleanupFailures.push('route-drain') }
        try { await bounded((async () => { while (proxyCalls.size) await Promise.all([...proxyCalls]) })(), 12000) } catch { cleanupFailures.push('proxy-drain') }
        callbackFault = undefined
        accountResponseFault = undefined; accountFaultPath = undefined
        caseObservations.push({ outcome, providerNavigations, prepares, routeFailures, routeFailureStages, unexpectedRequests, pageErrors, headerChecks, headerFailures,
          callbackProxyInvoked, callbackProxyDelivered, nativeCallbackStatus, beforeResponseAuthorized, proxyFailures })
        if (routeFailures) cleanupFailures.push('route-handler')
        await cdp.detach(); await context.close()
      }
    }
    evidence.results = results
    evidence.peer = await app.googleEvidence()
    evidence.completed = true
  } catch (error) {
    evidence.completed = false; evidence.failureStage = stage; evidence.timeoutFailure = error instanceof Error && error.name === 'TimeoutError'
    throw new Error('Compiled first-Google-passkey fixture failed at ' + stage)
  } finally {
    callbackFault = undefined
    accountResponseFault = undefined; accountFaultPath = undefined
    try { await bounded((async () => { while (proxyCalls.size) await Promise.all([...proxyCalls]) })(), 12000) } catch { cleanupFailures.push('proxy-drain') }
    for (const [name, close] of [['browser', () => browser?.close()], ['proxy', () => proxy && new Promise<void>(done => { proxy!.closeAllConnections(); proxy!.close(() => done()) })],
      ['web', () => app?.cleanup()], ['stores', () => stores?.cleanup()]] as const) {
      try { await close() } catch { cleanupFailures.push(name) }
    }
    evidence.stores = stores?.evidence; evidence.cleanupFailures = cleanupFailures
    evidence.privacyChecks = privacyChecks
    const finalChildLeak = app ? containsCanary(app.output()) : false
    evidence.finalChildOutputCanaryCheck = { checked: app !== undefined, leaked: finalChildLeak }
    if (finalChildLeak) cleanupFailures.push('child-output-canary')
    if (proxyFailures) cleanupFailures.push('proxy-handler')
    await writeFile(resolve(directory, `browser-${runId}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
    if (cleanupFailures.length) throw new Error('Owned first Google browser cleanup failed')
  }
}, 120000)
