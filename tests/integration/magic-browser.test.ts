import { expect, test } from 'vitest'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { assertAuthScreenAccessibility } from '../helpers/auth-screen-accessibility'
import { startDisposableStores, startDisposableHatchet } from '../fixtures/db/disposable-stores'
import { startMailHttpPeer } from '../fixtures/mail-http'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

// Removing the request UI, bypassing the worker, clearing the fragment only
// after Router construction, or publishing success before native commit breaks
// this actual compiled journey. No source issuer or fabricated session is used.
for (const [mode, name] of [
  ['bound', 'compiled_magic_mailbox_login_clears_fragment_before_router'],
  ['signup', 'compiled_magic_mailbox_signup_requires_browser_uv_passkey'],
  ['request-errors', 'compiled_magic_request_refuses_malformed_email_without_effects'],
  ['consume-errors', 'compiled_magic_consume_charges_six_malformed_proofs_once'],
  ['browser-states', 'compiled_magic_browser_lifecycle_and_accessibility'],
  ['denial', 'compiled_magic_ambiguous_platform_denial_allows_native_retry'],
  ['lost-response', 'compiled_magic_lost_success_then_used_proof_never_creates_second_session'],
  ['unavailable', 'compiled_magic_absent_configuration_reports_unavailable_methods'],
  ['expired', 'compiled_magic_delivered_expired_link_is_refused_without_identity'],
  ['same-document', 'compiled_magic_same_document_arrival_precedes_router_and_resets_intent'],
  ['arrival-matrix', 'compiled_magic_arrival_forms_replacement_stale_render_and_fallback'],
  ['clear-failure', 'compiled_magic_failed_native_clear_never_initializes_router_or_auth'],
  ['async-replacement', 'compiled_magic_late_consume_and_final_json_cannot_replace_new_arrival'],
  ['client-replacement', 'compiled_magic_late_helper_and_native_ceremony_cannot_replace_new_arrival'],
  ['restore', 'compiled_magic_persisted_restore_never_resurrects_proof_and_css_zoom_reflows'],
  ['pending-leave', 'compiled_magic_actual_leave_aborts_pending_native_ceremony'],
  ['arrival-uninteracted', 'compiled_magic_native_fragment_arrival_without_prior_interaction'],
  ['history-scroll', 'compiled_magic_history_restores_distinct_scroll_without_resurrecting_proof'],
  ['passkey-login', 'compiled_passkey_enrollment_logout_login_retains_authenticator'],
  ['additional-passkey', 'compiled_additional_passkey_existing_proof_new_key_logout_login'],
] as const) test(name, async () => {
  const runId = randomUUID()
  const bound = mode === 'bound' || mode === 'lost-response', enrollment = mode === 'signup' || mode === 'denial' || mode === 'passkey-login' || mode === 'additional-passkey'
  const email = bound ? 'bound@example.test' : 'first-browser@example.test'
  let stage = 'fixture setup'
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let engine: Awaited<ReturnType<typeof startDisposableHatchet>> | undefined
  let peer: Awaited<ReturnType<typeof startMailHttpPeer>> | undefined
  let app: ReturnType<typeof startWeb> | undefined
  let proxy: ReturnType<typeof createServer> | undefined
  let worker: ReturnType<typeof spawn> | undefined, workerExit: Promise<number | null> | undefined
  let browser: Browser | undefined
  let passkeyCdp: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newCDPSession']>> | undefined
  let passkeyAuthenticatorId: string | undefined
    let output = '', consoleFailures = 0, proofLeak = false, consumePosts = 0
    const passkeyDiagnostics: string[] = []
    let accountConsolePath = '', accountConsoleActive = false, accountConsoleSignals = 0
  let clientIp = '192.0.2.83'
    const evidence: Record<string, unknown> = { runId }
    let primaryFailed = false
  try {
    const port = await unusedLoopbackPort(), origin = `https://localhost:${port}`
    stage = 'TLS peer setup'
    peer = await startMailHttpPeer({ appOrigin: origin })
    stage = 'disposable stores acquisition'
    stores = await startDisposableStores()
    stage = 'disposable migration'
    await stores.migrate()
    stage = 'disposable grants and bound User'
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
	      GRANT SELECT,INSERT ON public.passkey TO runtime;
	      GRANT UPDATE (counter) ON TABLE public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.additional_passkey_intent TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
      GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    if (bound) await stores.administrator.query(`INSERT INTO "user"(id,name,email,email_verified,recovery_generation) VALUES ('browser-bound','Browser fixture','bound@example.test',true,0)`)
    stage = 'disposable Hatchet acquisition'
    if (bound || enrollment || mode === 'browser-states' || mode === 'expired' || mode === 'async-replacement' || mode === 'client-replacement' || mode === 'pending-leave') engine = await startDisposableHatchet()
    const key = randomBytes(32), keysJson = JSON.stringify({ browser: key.toString('base64') }); key.fill(0)
    stage = 'compiled web setup'
    app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
      RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'magic-browser', TRUSTED_PROXY_IPS: '127.0.0.2',
      AUTH_SECRET: randomBytes(48).toString('hex'), AUTH_MAIL_KEY_ID: mode === 'unavailable' ? undefined : 'browser', AUTH_MAIL_KEYS_JSON: mode === 'unavailable' ? undefined : keysJson,
      AUTH_MAIL_PROFILE_JSON: mode === 'unavailable' ? undefined : JSON.stringify({ appOrigin: origin, apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'browser',
        from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }), REQUEST_TIMEOUT_MS: '10000' })
    const upstreamPort = (await bounded(app.ready)).port
    const certificate = await readFile(peer.certificate)
    stage = 'owned HTTPS proxy setup'
    proxy = createServer({ cert: certificate, key: await readFile(peer.privateKey) }, (incoming, outgoing) => {
      if (incoming.headers.host !== `localhost:${port}`) { outgoing.writeHead(400); outgoing.end(); return }
      proofLeak ||= peer!.containsProof(incoming.url ?? '')
      if (incoming.method === 'POST' && incoming.url === '/auth/magic/consume') consumePosts++
      const call = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, method: incoming.method, path: incoming.url,
        localAddress: '127.0.0.2', headers: { ...incoming.headers, 'x-forwarded-proto': 'https', 'x-real-ip': clientIp } },
      response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing) })
      call.on('error', () => { outgoing.writeHead(502); outgoing.end() }); incoming.pipe(call)
    })
    await new Promise<void>((done, reject) => { proxy!.once('error', () => reject(new Error('Owned HTTPS listen failed'))); proxy!.listen(port, '127.0.0.1', done) })
    stage = 'compiled worker setup'
    if (engine) {
    worker = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/helpers/mail-process.mjs')).href, resolve('.output/worker/index.mjs')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: peer.certificate,
        AUTH_MAIL_RELAY_DATABASE_URL: stores.mailRelayUrl, AUTH_MAIL_WORKER_DATABASE_URL: stores.mailWorkerUrl,
        AUTH_MAIL_KEY_ID: 'browser', AUTH_MAIL_KEYS_JSON: keysJson,
        AUTH_MAIL_PROJECT_ID: 'fixture', AUTH_MAIL_CREDENTIAL_ID: 'browser', AUTH_MAIL_API_ORIGIN: peer.origin, AUTH_MAIL_PLUNK_SECRET: 'sk_controlled_local_fixture_only',
        HATCHET_CLIENT_TOKEN: engine.config.token, HATCHET_CLIENT_HOST_PORT: engine.config.host_port, HATCHET_CLIENT_API_URL: engine.config.api_url, HATCHET_CLIENT_TLS_STRATEGY: 'none',
      },
    })
    worker.stdout!.on('data', chunk => { output += String(chunk) }); worker.stderr!.on('data', chunk => { output += String(chunk) })
    workerExit = new Promise((done, reject) => { worker!.once('error', () => reject(new Error('Owned worker failed'))); worker!.once('close', done) })
    }
    // Trust only the owned certificate public key in this launched Chromium.
    // No global CA changes and no blanket ignoreHTTPSErrors.
    const spki = createHash('sha256').update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    stage = 'owned Chromium setup'
    browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`],
      channel: mode === 'restore' || mode === 'passkey-login' || mode === 'additional-passkey' ? 'chromium' : undefined,
      ignoreDefaultArgs: mode === 'restore' || mode === 'passkey-login' || mode === 'additional-passkey' ? ['--disable-back-forward-cache'] : undefined })
    evidence.browser = { version: browser.version(), platform: process.platform, architecture: process.arch, playwright: '1.62.1',
      implementation: mode === 'restore' || mode === 'passkey-login' || mode === 'additional-passkey' ? 'chromium-new-headless' : 'chromium-headless-shell' }
    async function newContext(options?: Parameters<Browser['newContext']>[0], routerObserver = true) {
      const context = await browser!.newContext(options)
      await context.route('**/*', route => {
        const url = route.request().url(); proofLeak ||= peer!.containsProof(url)
        return [origin, peer!.origin].includes(new URL(url).origin) ? route.continue() : route.abort()
      })
      if (routerObserver) await context.addInitScript(() => {
        let nativeRouter: unknown, first = true
        Object.defineProperty(window, '__magicFirstRouterClean', { value: false, writable: true })
        Object.defineProperty(window, '__TSR_ROUTER__', { configurable: true,
          get: () => nativeRouter,
          set: value => {
            if (first) { first = false; Reflect.set(window, '__magicFirstRouterClean', location.hash === '') }
            nativeRouter = value
          },
        })
      })
      return context
    }
    const requesting = await newContext(), receiving = await newContext({ viewport: { width: 320, height: 720 } })
    if (mode === 'additional-passkey') await receiving.addInitScript(() => {
      const state = { documentId: crypto.randomUUID(), nativePageshowSeen: false, persisted: false,
        panelRegistrations: 0, nativePanelHides: 0, controlledPanelHides: 0, witnessFailure: false }
      Reflect.set(window, '__additionalLifecycleWitness', state)
      window.addEventListener('pageshow', event => {
        if (event.isTrusted) { state.nativePageshowSeen = true; state.persisted = event.persisted }
      })
      const wrapped = new WeakMap<object, EventListener>()
      window.addEventListener = new Proxy(window.addEventListener, {
        apply(target, receiver, args) {
          const [type, listener] = args
          if (receiver === window && type === 'pagehide' && typeof listener === 'function'
            && (new Error().stack ?? '').includes('/assets/auth-panels-')) {
            let observer = wrapped.get(listener)
            if (!observer) {
              observer = function (event) {
                const result = Reflect.apply(listener, window, [event])
                if (event.isTrusted) {
                  state.nativePanelHides++
                  try {
                    const prior: unknown = JSON.parse(sessionStorage.getItem('__additionalNativeDepartures') ?? '[]')
                    const entries = Array.isArray(prior) ? prior.filter(value => typeof value === 'string').slice(-7) : []
                    sessionStorage.setItem('__additionalNativeDepartures', JSON.stringify([...entries, state.documentId]))
                  } catch { state.witnessFailure = true }
                } else state.controlledPanelHides++
                return result
              }
              wrapped.set(listener, observer); state.panelRegistrations++
            }
            return Reflect.apply(target, receiver, [type, observer, ...args.slice(2)])
          }
          return Reflect.apply(target, receiver, args)
        },
      })
      window.removeEventListener = new Proxy(window.removeEventListener, {
        apply(target, receiver, args) {
          const [type, listener] = args
          return Reflect.apply(target, receiver, receiver === window && type === 'pagehide' && typeof listener === 'function'
            ? [type, wrapped.get(listener) ?? listener, ...args.slice(2)] : args)
        },
      })
    })
    if (mode === 'passkey-login') await receiving.addInitScript(() => {
      Object.defineProperty(window, '__passkeyBfcacheRestored', { value: false, writable: true })
      window.addEventListener('pageshow', event => { if (event.persisted) Reflect.set(window, '__passkeyBfcacheRestored', true) })
    })
    if (mode === 'denial') await receiving.addInitScript(() => {
      if (!navigator.credentials) return
      let deny = true
      const original = navigator.credentials.create.bind(navigator.credentials)
      navigator.credentials.create = options => {
        if (deny) { deny = false; return Promise.reject(new DOMException('Controlled platform denial', 'NotAllowedError')) }
        return original(options)
      }
    })
    if (mode === 'lost-response') await receiving.addInitScript(() => {
      let drop = true
      const original = window.fetch
      window.fetch = async function (resource, init) {
        const response = await original.call(window, resource, init)
        if (drop && resource === '/auth/magic/consume' && response.ok) {
          drop = false
          // Native server commit/cookie already happened. Simulate only the
          // caller losing its success result, without inspecting the body.
          throw new Error('Controlled lost result')
        }
        return response
      }
    })
    const requestPage = await requesting.newPage(), receivePage = await receiving.newPage()
    if (enrollment) {
      passkeyCdp = await receiving.newCDPSession(receivePage)
      await passkeyCdp.send('WebAuthn.enable')
      const added = await passkeyCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
      passkeyAuthenticatorId = added.authenticatorId
    }
    for (const page of [requestPage, receivePage]) {
      page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(7000)
      page.on('pageerror', error => { consoleFailures++; passkeyDiagnostics.push(error.message); proofLeak ||= peer!.containsProof(error.message) })
      page.on('console', message => {
        if (message.type() === 'error') {
          const location = message.location().url
          if ((mode === 'passkey-login' || mode === 'additional-passkey') && accountConsoleActive && location
            && new URL(location).pathname === accountConsolePath) accountConsoleSignals++
          else consoleFailures++
        }
        passkeyDiagnostics.push(message.text()); proofLeak ||= peer!.containsProof(message.text())
      })
    }
    const requestPath = await authRpcPath('requestMagicLink'), requestStatuses: number[] = []
    requestPage.on('response', response => { if (new URL(response.url()).pathname === requestPath) requestStatuses.push(response.status()) })
    if (mode === 'unavailable') {
      stage = 'unavailable configured methods'
      await requestPage.goto(origin + '/login?lang=en')
      await requestPage.getByText('Email sign-in is currently unavailable.', { exact: true }).waitFor()
      expect(await requestPage.getByRole('textbox').count()).toBe(0)
      expect(await requestPage.getByRole('button', { name: 'Continue with Google', exact: true }).isDisabled()).toBe(true)
      await requestPage.getByRole('link', { name: 'Français', exact: true }).click()
      await requestPage.getByText('La connexion par e-mail est indisponible pour le moment.', { exact: true }).waitFor()
      expect(await requestPage.getByRole('button', { name: 'Créer une passkey', exact: true }).count()).toBe(0)
      evidence.unavailableMethods = true; stage = 'complete'; return
    }
    if (mode === 'same-document' || mode === 'arrival-matrix' || mode === 'arrival-uninteracted' || mode === 'history-scroll') {
      stage = 'compiled same-document arrival'
      const { assertCompiledMagicArrival } = await import('../helpers/magic-same-document')
      await assertCompiledMagicArrival(origin, () => newContext({}, false), evidence,
        mode === 'arrival-matrix' ? 'matrix' : mode === 'arrival-uninteracted' ? 'uninteracted' : mode === 'history-scroll' ? 'scroll' : 'anchor')
      stage = 'complete'; return
    }
    if (mode === 'clear-failure') {
      stage = 'initial native clear refusal'
      const { assertCompiledMagicClearFailure } = await import('../helpers/magic-same-document')
      await assertCompiledMagicClearFailure(origin, () => newContext({}, false), evidence)
      stage = 'complete'; return
    }
    if (mode === 'restore') {
      const { assertMagicRestore } = await import('../helpers/magic-restore')
      evidence.backForwardCacheDefaultDisabledRemoved = true
      await assertMagicRestore({ origin, runId, peer, context: () => newContext({ viewport: { width: 640, height: 900 } }),
        setStage: value => { stage = value }, evidence })
      stage = 'complete'; return
    }
    if (mode === 'browser-states') {
      await mkdir('.superpowers/sdd/2026-09-10-functional-auth/task-8c-evidence', { recursive: true })
      const { qualifyMagicBrowserStates } = await import('../helpers/magic-browser-states')
      const states: Record<string, unknown> = {}; evidence.browserStates = states
      await qualifyMagicBrowserStates({ origin, runId, requestPath, stores, peer,
        context: () => newContext({ viewport: { width: 320, height: 720 } }),
        selectClient: index => { clientIp = `192.0.2.${index}` }, setStage: value => { stage = value },
        scan: value => { proofLeak ||= peer!.containsProof(value) }, evidence: states })
      expect(states.violations).toEqual([])
      expect(proofLeak || peer.containsProof(app.output()) || peer.containsProof(output)).toBe(false)
      evidence.browserStatesQualified = true; stage = 'complete'; return
    }
    if (mode === 'client-replacement' || mode === 'pending-leave') {
      const { assertMagicClientReplacement } = await import('../helpers/magic-client-replacement')
      await assertMagicClientReplacement({ origin, stores, peer, context: () => newContext(),
        selectClient: index => { clientIp = `192.0.2.${index}` }, setStage: value => { stage = value },
        scan: value => { proofLeak ||= peer!.containsProof(value) }, evidence, leaveOnly: mode === 'pending-leave' })
      expect(proofLeak || peer.containsProof(app.output()) || peer.containsProof(output)).toBe(false)
      stage = 'complete'; return
    }
    if (mode === 'async-replacement') {
      const { assertMagicAsyncReplacement } = await import('../helpers/magic-async-replacement')
      await assertMagicAsyncReplacement({ origin, stores, peer, context: () => newContext(),
        selectClient: index => { clientIp = `192.0.2.${index}` }, setStage: value => { stage = value },
        scan: value => { proofLeak ||= peer!.containsProof(value) }, evidence })
      expect(proofLeak || peer.containsProof(app.output()) || peer.containsProof(output)).toBe(false)
      stage = 'complete'; return
    }
    if (mode === 'request-errors' || mode === 'consume-errors') {
      stage = mode
      const statuses: number[] = [], bodyIsSafe: boolean[] = [], cookiesAbsent: boolean[] = []
      await requestPage.goto(origin + '/login?lang=en')
      const values = mode === 'request-errors' ? ['', 'not-an-email'] : Array.from({ length: 6 }, () => 'malformed')
      for (const value of values) {
        const result = await requestPage.evaluate(async ({ path, body }) => {
          const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, body })
          const content = await response.text()
          return { status: response.status, safe: content === 'Authentication rejected' || content === 'Too Many Requests' }
        }, { path: mode === 'request-errors' ? requestPath : '/auth/magic/consume',
          body: mode === 'request-errors' ? await rpcBody({ email: value, locale: 'en' }) : JSON.stringify({ token: value, intendedEmail: 'nobody@example.test' }) })
        statuses.push(result.status); bodyIsSafe.push(result.safe)
        cookiesAbsent.push((await requesting.cookies()).length === 0)
      }
      const effects = (await stores.administrator.query('SELECT (SELECT count(*) FROM auth_email_command)::int AS intentions,(SELECT count(*) FROM session)::int AS sessions,(SELECT count(*) FROM "user")::int AS users')).rows[0]
      evidence.entry = { statuses, bodyIsSafe, cookiesAbsent, effects }
      expect(statuses).toEqual(mode === 'request-errors' ? [401, 401] : [401, 401, 401, 401, 401, 429])
      expect(bodyIsSafe.every(Boolean) && cookiesAbsent.every(Boolean)).toBe(true)
      expect(effects).toEqual({ intentions: 0, sessions: 0, users: 0 })
      evidence.entryErrorsQualified = true; stage = 'complete'; return
    }
    stage = 'request page load'
    await requestPage.goto(origin + '/login?lang=en', { waitUntil: 'domcontentloaded' })
    stage = 'request UI feature absence'
    // Safe Boolean diagnosis even when the initial RED has no email field.
    expect(await requestPage.getByRole('textbox', { name: /^Email address/ }).count(), 'compiled magic request field exists').toBe(1)
    evidence.requestFieldExists = true
    stage = 'request email entry'
    await requestPage.getByRole('textbox', { name: /^Email address/ }).fill(email)
    stage = 'request explicit submit'
    await requestPage.getByRole('button', { name: 'Send a sign-in link', exact: true }).click()
    stage = 'request acknowledgement'
    try { await requestPage.getByRole('status').filter({ hasText: 'If this address can be used, a sign-in link has been requested.' }).waitFor() }
    finally {
      evidence.requestStatuses = requestStatuses
      evidence.requestUi = await requestPage.evaluate(() => ({
        sameRoute: location.pathname === '/login', noEmailQuery: !new URLSearchParams(location.search).has('email'),
        invalidEmail: document.body.textContent?.includes('Enter a valid email address.') === true,
        requestFailed: document.body.textContent?.includes('The link request could not be completed.') === true,
        accepted: document.body.textContent?.includes('If this address can be used, a sign-in link has been requested.') === true,
      }))
      evidence.intentions = (await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command')).rows[0].n
      evidence.providerCalls = peer.evidence().calls
    }
    stage = 'production worker mailbox delivery'
    await expect.poll(() => peer!.hasMailFor(email), { timeout: 35000 }).toBe(true)
    expect(peer.evidence()).toEqual({ calls: 1, directFragment: true })
    evidence.delivery = peer.evidence()
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(0)
    stage = 'mailbox browser handoff and early router ordering'
    // Never pass a delivered URL/token into a Playwright command or error.
    await receivePage.goto(peer.mailboxUrl, { waitUntil: 'domcontentloaded' })
    await receivePage.getByRole('textbox', { name: /^Email address/ }).waitFor()
    await assertAuthScreenAccessibility(receivePage)
    expect(await receivePage.evaluate(() => Reflect.get(window, '__magicFirstRouterClean') === true && location.hash === '' && location.pathname === '/auth/magic/confirm')).toBe(true)
    evidence.firstRouterClean = true
    expect(peer.hasMailFor(email)).toBe(false)
    expect(peer.containsProof(await receivePage.content())).toBe(false)
    if (mode === 'expired') {
      const lifetime = (await stores.administrator.query('SELECT extract(epoch FROM expires_at-created_at)::float8 AS seconds FROM auth_email_command WHERE recipient=$1', [email])).rows[0].seconds
      evidence.lifetimeSeconds = lifetime
      expect(lifetime).toBe(600)
      let reportedMinute = -1
      await expect.poll(async () => {
        const row = (await stores!.administrator.query('SELECT expires_at <= clock_timestamp() AS expired, greatest(ceil(extract(epoch FROM expires_at-clock_timestamp())),0)::int AS remaining FROM auth_email_command WHERE recipient=$1', [email])).rows[0]
        const minute = Math.ceil(row.remaining / 60)
        if (minute !== reportedMinute) { reportedMinute = minute; console.log('MAGIC_EXPIRY_REMAINING_SECONDS ' + row.remaining) }
        return row.expired
      }, { timeout: 620000, interval: 5000 }).toBe(true)
      evidence.expiredByDatabaseClock = true
    }
    stage = 'typed intended email and native commit'
    await receivePage.getByRole('textbox', { name: /^Email address/ }).fill(email)
    const expiredResponse = mode === 'expired' ? receivePage.waitForResponse(response => new URL(response.url()).pathname === '/auth/magic/consume') : undefined
    await receivePage.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
    if (mode === 'expired') {
      stage = 'native expired proof refusal'
      const status = (await expiredResponse!).status()
      evidence.expiredConsumeStatus = status
      expect(status).toBe(401)
      await receivePage.waitForFunction(() => document.querySelector('input')?.getAttribute('aria-invalid') === 'true')
      expect((await stores.administrator.query('SELECT (SELECT count(*) FROM "user")::int AS users,(SELECT count(*) FROM session)::int AS sessions')).rows[0]).toEqual({ users: 0, sessions: 0 })
      expect((await receiving.cookies()).some(cookie => cookie.name.includes('session_token'))).toBe(false)
      evidence.deliveredExpiredProofRefused = true; stage = 'complete'; return
    }
    if (mode === 'lost-response') {
      stage = 'lost committed result and explicit used-proof retry'
      await receivePage.getByRole('alert').filter({ hasText: 'Sign-in could not be completed.' }).waitFor()
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(1)
      await receivePage.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
      await receivePage.waitForFunction(() => document.querySelector('input')?.getAttribute('aria-invalid') === 'true')
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(1)
      expect(consumePosts).toBe(2)
      expect((await stores.administrator.query("SELECT state='consumed' AND verifier_hash IS NULL AS retired FROM email_delivery")).rows[0].retired).toBe(true)
      evidence.committedResultLossThenUsedRefusal = true; stage = 'complete'; return
    }
    if (enrollment) {
      stage = 'unbound enrollment before identity'
      await receivePage.getByText('Create a passkey to finish your first sign-up.', { exact: true }).waitFor()
      expect((await stores.administrator.query('SELECT (SELECT count(*) FROM "user")::int AS users,(SELECT count(*) FROM passkey)::int AS keys,(SELECT count(*) FROM session)::int AS sessions')).rows[0]).toEqual({ users: 0, keys: 0, sessions: 0 })
      expect((await stores.administrator.query("SELECT state='active' AND verifier_hash IS NOT NULL AS usable FROM email_delivery")).rows[0].usable).toBe(true)
      evidence.noIdentityBeforeEnrollment = true
      stage = 'explicit browser enrollment control'
      await expect.poll(() => receivePage.getByRole('button', { name: 'Create a passkey', exact: true }).isEnabled()).toBe(true)
      await assertAuthScreenAccessibility(receivePage)
      await receivePage.getByRole('button', { name: 'Create a passkey', exact: true }).click()
      if (mode === 'denial') {
        await receivePage.getByRole('alert').filter({ hasText: 'It may have been cancelled, declined, or timed out.' }).waitFor()
        expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n).toBe(0)
        expect((await receivePage.content()).includes('Controlled platform denial')).toBe(false)
        await receivePage.getByRole('button', { name: 'Create a passkey', exact: true }).click()
        evidence.ambiguousDenialRetried = true
      }
      stage = 'browser ceremony and native finalization'
    }
    await receivePage.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
    expect(await receivePage.evaluate(() => location.pathname === '/account' && location.search === '?lang=en' && location.hash === '')).toBe(true)
    expect(consumePosts).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1 AND s.auth_method=\'magic-link\' AND s.auth_state=\'ACTIVE\'', [email])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM passkey')).rows[0].n).toBe(enrollment ? 1 : 0)
    expect((await stores.administrator.query("SELECT state='consumed' AND verifier_hash IS NULL AND ciphertext IS NULL AS retired FROM email_delivery")).rows[0].retired).toBe(true)
    const sessionCookie = (await receiving.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
    expect({ secure: sessionCookie?.secure, httpOnly: sessionCookie?.httpOnly, sameSite: sessionCookie?.sameSite }).toEqual({ secure: true, httpOnly: true, sameSite: 'Lax' })
    await receivePage.reload(); await receivePage.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
    if (mode === 'additional-passkey') {
      if (!passkeyCdp || !passkeyAuthenticatorId) throw new Error('Owned passkey authenticator unavailable')
      const { assertCompiledAdditionalPasskey } = await import('../helpers/additional-passkey-browser')
      await assertCompiledAdditionalPasskey({ origin, page: receivePage, context: receiving, cdp: passkeyCdp,
        authenticatorId: passkeyAuthenticatorId, stores, evidence, setStage: value => { stage = value },
        newContext: () => newContext({ viewport: { width: 320, height: 720 } }, false),
        scanRuntime: values => values.some(value => passkeyDiagnostics.some(text => text.includes(value)) || app!.output().includes(value) || output.includes(value)),
        expectedConsole: (active, path) => { accountConsoleActive = active; accountConsolePath = active ? path : '' },
        selectClient: index => { clientIp = `192.0.2.${index}` } })
      proofLeak ||= peer.containsProof(await receivePage.content()) || peer.containsProof(app.output()) || peer.containsProof(output)
      expect({ proofLeak, consoleFailures }).toEqual({ proofLeak: false, consoleFailures: 0 })
      stage = 'complete'; return
    }
    if (mode === 'passkey-login') {
      if (!passkeyCdp || !passkeyAuthenticatorId) throw new Error('Owned passkey authenticator unavailable')
      const { assertCompiledPasskeyLogin } = await import('../helpers/passkey-login-browser')
      await assertCompiledPasskeyLogin({ origin, page: receivePage, context: receiving, cdp: passkeyCdp,
        authenticatorId: passkeyAuthenticatorId, stores, evidence, setStage: value => { stage = value },
        newContext: () => newContext({ viewport: { width: 320, height: 720 } }, false),
        scanRuntime: values => values.some(value => passkeyDiagnostics.some(text => text.includes(value)) || app!.output().includes(value) || output.includes(value)),
        accountConsole: (active, path) => { accountConsoleActive = active; accountConsolePath = active ? path : '' },
        accountConsoleSignals: () => accountConsoleSignals,
        selectClient: index => { clientIp = `192.0.2.${index}` } })
      proofLeak ||= peer.containsProof(await receivePage.content()) || peer.containsProof(app.output()) || peer.containsProof(output)
      expect({ proofLeak, consoleFailures }).toEqual({ proofLeak: false, consoleFailures: 0 })
      stage = 'complete'; return
    }
    if (mode === 'signup') {
      stage = 'first personal Workspace consumer'
      await receivePage.getByRole('link', { name: 'My personal workspace', exact: true }).click()
      await receivePage.getByRole('button', { name: 'Create my workspace', exact: true }).click()
      await receivePage.getByRole('textbox', { name: /^Display name/ }).waitFor()
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n).toBe(1)
      evidence.workspaceReady = true
    }
    proofLeak ||= peer.containsProof(await receivePage.content()) || peer.containsProof(app.output()) || peer.containsProof(output)
    expect({ proofLeak, consoleFailures }).toEqual({ proofLeak: false, consoleFailures: 0 })
    evidence[mode === 'bound' ? 'boundJourney' : 'signupJourney'] = true
    stage = 'complete'
  } catch (error) {
    primaryFailed = true
    evidence.primaryFailed = true
    // Retain only a bounded source location from an actual known-helper frame.
    // Never serialize an error message, stack, cause, URL or assertion value.
    if (error instanceof Error && typeof error.stack === 'string') {
      for (const frame of error.stack.split('\n').slice(1)) {
        const match = /^\s*at .*[\\/](magic-(same-document|browser-states)|passkey-login-browser|additional-passkey-browser)\.ts:(\d+):\d+\)?$/.exec(frame)
        if (match && Number(match[3]) > 0 && Number(match[3]) <= 2000) {
          evidence.failureLocation = { helper: match[1], line: Number(match[3]) }
          break
        }
      }
    }
    // Playwright errors may carry redirect URLs. Never publish/cause/serialize
    // that error; a fixed stage and Boolean assertions are sufficient evidence.
    throw new Error('Magic browser qualification failed at: ' + stage)
  } finally {
    const cleanupFailures: string[] = []
    for (const [name, close] of [
      ['browser', () => browser?.close()],
      ['worker', async () => { if (worker && worker.exitCode === null && worker.signalCode === null) { worker.send('shutdown'); try { await bounded(workerExit!, 15000) } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL') } } if (workerExit) await bounded(workerExit) }],
      ['proxy', async () => { proxy?.closeAllConnections(); if (proxy?.listening) await new Promise<void>(done => proxy!.close(() => done())) }],
      ['web', () => app?.cleanup()], ['engine', () => engine?.cleanup()], ['stores', () => stores?.cleanup()], ['peer', () => peer?.close()],
    ] as const) { try { await close() } catch { cleanupFailures.push(name) } }
    const evidenceDirectory = mode === 'additional-passkey' ? '.superpowers/sdd/2026-09-10-functional-auth/task-9b-evidence' : mode === 'passkey-login'
      ? '.superpowers/sdd/2026-09-10-functional-auth/task-9a-evidence'
      : '.superpowers/sdd/2026-09-10-functional-auth/task-8c-evidence'
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(resolve(evidenceDirectory, `browser-${runId}.json`), JSON.stringify({ ...evidence, stage, consumePosts, proofLeak, consoleFailures, cleanupFailures, stores: stores?.evidence, engine: engine?.evidence }, null, 2) + '\n', { flag: 'wx' })
    if (!primaryFailed) expect(cleanupFailures).toEqual([])
  }
}, mode === 'expired' ? 750000 : mode === 'additional-passkey' ? 540000 : mode === 'browser-states' ? 300000 : 180000)
