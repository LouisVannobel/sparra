import { request as httpRequest, type ClientRequest, type ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, vi } from 'vitest'
import { Schema } from 'effect'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { messages, sessionManagementMessages } from '../../src/ui/auth/messages'

const enrollment = vi.hoisted(() => ({ token: '' }))
const nativeMarker = Schema.Struct({ documentId: Schema.String.check(Schema.isUUID()), attemptId: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literals(['get-start', 'signal-abort', 'native-rejection', 'native-fulfilled', 'settled', 'pagehide']),
  errorName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/))) })
const documentIdSchema = Schema.String.check(Schema.isUUID())
const pendingAttemptSchema = Schema.Struct({ documentId: documentIdSchema, id: Schema.Int.check(Schema.isGreaterThan(0)),
  hasSignal: Schema.Boolean, aborted: Schema.Boolean, settled: Schema.Boolean })
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); enrollment.token = args[3].toString('base64url'); return result
  } }
})

test.each(['clock-skew', 'cancel-race', 'en', 'fr'] as const)('compiled session-management %s: native two-context revocation, truthful reconciliation and invalidation', async variant => {
  const locale = variant === 'fr' ? 'fr' : 'en'
  const runId = randomUUID(), directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-10a-evidence'), t = sessionManagementMessages[locale]
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined, web: ReturnType<typeof startWeb> | undefined
  let browser: Browser | undefined, context: BrowserContext | undefined, second: BrowserContext | undefined, page: Page | undefined, secondPage: Page | undefined, cdp: CDPSession | undefined
  let certificateDirectory: string | undefined
  let proxy: ReturnType<typeof createServer> | undefined, pool: Pool | undefined, app: ReturnType<typeof createApplicationAuth> | undefined
  let limiter: ReturnType<typeof createAuthRateLimiter> | undefined, stage = 'setup', ip = 1, counter = 0
  let fault: 'none' | 'commit500' | 'no-commit500' | 'hold-list' | 'begin503' = 'none', held = false, release = () => {}
  let listBeginPath = '', listFinishPath = '', revokeBeginPath = '', revokeFinishPath = '', accountPath = ''
  const pendingProxy = new Set<Promise<void>>(), failures: string[] = [], privacyCanaries = new Set<string>(), observations: Record<string, unknown>[] = []
  const upstreamRequests = new Set<ClientRequest>()
  const nativeEvents: { sequence: number; kind: string; documentId?: string; attemptId?: number; errorName?: string; loaderId?: string; path?: string;
    frameId?: string; locale?: string | null; executionContextId?: number; uniqueContextId?: string }[] = []
  const defaultContexts = new Map<number, { frameId?: string; uniqueContextId: string }>()
  const ingress = { beginSessionList: 0, finishSessionList: 0, beginSessionRevocation: 0, finishSessionRevocation: 0 }
  const clockProofs: { action: string; count: number; live: boolean; remainingMs: number; databaseNow: number; nodeDatabaseDeltaMs: number }[] = []
  let ingressWatch: string[] | undefined
  let browserEvidence: Record<string, unknown> | undefined
  const startedAt = performance.now()
  const progressPath = resolve(directory, `browser-${runId}-progress.jsonl`)
  const counts = { listBegin: 0, listFinish: 0, revokeBegin: 0, revokeFinish: 0, account: 0, assertion: 0, nativeAborts: 0, pageErrors: 0, proxyErrors: 0, foreignRequests: 0 }
  let consoleText = '', capturedBodyLeak = false, nativeCookiePublished = false
  const leaks = (text: string) => [...privacyCanaries].some(value => value.length >= 8 && text.includes(value))
  const cookies = (headers: Headers) => headers.getSetCookie().filter(value => !/;\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
  async function checkpoint(next: string) {
    stage = next
    await appendFile(progressPath, JSON.stringify({ runId, variant, stage, elapsedMs: Math.round(performance.now() - startedAt),
      storeRunId: stores?.evidence.runId ?? null, certificateDirectory: certificateDirectory ?? null }) + '\n')
  }
  function watchCommands() {
    if (ingressWatch) throw new Error('Owned command observation already active')
    const before = { ...ingress }, unexpected: string[] = []; ingressWatch = unexpected
    return () => {
      ingressWatch = undefined
      expect(unexpected).toEqual([]); expect(ingress).toEqual(before)
      return { before, after: { ...ingress }, unexpected }
    }
  }
  function nativeRequest(origin: string, cookie = '') {
    const request = Object.assign(new Request(origin + '/native-fixture', { method: 'POST', headers: { origin, cookie, 'x-real-ip': `198.18.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }),
      { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return request
  }
  async function addCookie(target: BrowserContext, header: string, origin: string) {
    for (const part of header.split('; ')) {
      const split = part.indexOf('='); if (split < 1) continue
      privacyCanaries.add(part.slice(split + 1))
      await target.addCookies([{ name: part.slice(0, split), value: part.slice(split + 1), url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }])
    }
  }
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(progressPath, '', { flag: 'wx' })
    await checkpoint('bootstrap: stores starting')
    stores = await startDisposableStores()
    await checkpoint('bootstrap: stores ready, migration starting')
    await stores.migrate()
    await checkpoint('bootstrap: migration complete')
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime; GRANT INSERT ON public.auth_session_revocation TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime; GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    const port = await unusedLoopbackPort(), origin = `https://localhost:${port}`, secret = randomBytes(48).toString('hex')
    certificateDirectory = await mkdtemp(join(tmpdir(), `session-browser-${runId}-`))
    const certificatePath = join(certificateDirectory, 'cert.pem'), privateKeyPath = join(certificateDirectory, 'key.pem')
    await checkpoint('bootstrap: certificate starting')
    const openssl = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl'
    await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKeyPath, '-out', certificatePath,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } })
    const certificate = await readFile(certificatePath), proxyPrivateKey = await readFile(privateKeyPath)
    const spki = createHash('sha256').update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    await checkpoint('bootstrap: certificate ready, native enrollment starting')
    privacyCanaries.add(secret); privacyCanaries.add(stores.hmac); privacyCanaries.add(new URL(stores.runtimeUrl).password); privacyCanaries.add(new URL(stores.redisUrl).password)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'session-browser-bootstrap', TRUSTED_PROXY_IPS: '127.0.0.1' })); await limiter.connect()
    const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
      from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: secret })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)
    const email = `sessions-${runId}@example.test`
    await app.requestMagicLink(nativeRequest(origin), { email, locale })
    privacyCanaries.add(enrollment.token)
    const proof = { token: enrollment.token, intendedEmail: email }
    const optionsResponse = await magicConsumeResponse(nativeRequest(origin), proof, app, limiter)
    expect(optionsResponse.status).toBe(200)
    const registration = await optionsResponse.json(), key = registrationCredentialFixture(registration.options, origin)
    const enrolled = await magicEnrollmentResponse(nativeRequest(origin, cookies(optionsResponse.headers)), { ...proof, response: key.response }, app, limiter)
    expect(enrolled.status).toBe(200)
    const originalCookie = cookies(enrolled.headers), principal = await app.requirePrincipal(nativeRequest(origin, originalCookie))
    expect(await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal)).not.toBeNull()
    async function nativeLogin() {
      counter = (await stores!.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [principal.userId])).rows[0].counter
      const begun = await app!.beginPasskeySignIn(nativeRequest(origin))
      const result = await app!.finishPasskeySignIn(nativeRequest(origin, cookies(begun.headers)), { response: key.authenticationResponse(begun.options, { counter: ++counter }) })
      const cookie = cookies(result.headers), current = await app!.requirePrincipal(nativeRequest(origin, cookie))
      return { cookie, sessionId: current.sessionId }
    }
    const target = await nativeLogin()
    await checkpoint('bootstrap: native enrollment and second session ready')
    await checkpoint('web: starting')
    web = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
      RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'session-browser', TRUSTED_PROXY_IPS: '127.0.0.2', AUTH_SECRET: secret, REQUEST_TIMEOUT_MS: '10000' })
    const upstream = (await bounded(web.ready)).port
    await checkpoint('web: ready, RPC lookup starting')
    ;[listBeginPath, listFinishPath, revokeBeginPath, revokeFinishPath, accountPath] = await bounded(Promise.all([
      authRpcPath('beginSessionList'), authRpcPath('finishSessionList'), authRpcPath('beginSessionRevocation'), authRpcPath('finishSessionRevocation'), authRpcPath('getAccount'),
    ]), 15000)
    await checkpoint('web: RPC lookup complete, proxy starting')
    function unavailable(outgoing: ServerResponse) {
      outgoing.writeHead(500, { 'x-tss-raw': 'true', 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer' }); outgoing.end('Owned response loss')
    }
    proxy = createServer({ cert: certificate, key: proxyPrivateKey }, (incoming, outgoing) => {
      const path = incoming.url?.split('?')[0], selected = fault
      const command = path === listBeginPath ? 'beginSessionList' : path === listFinishPath ? 'finishSessionList'
        : path === revokeBeginPath ? 'beginSessionRevocation' : path === revokeFinishPath ? 'finishSessionRevocation' : undefined
      if (command) { ingress[command]++; ingressWatch?.push(command) }
      if (path === revokeFinishPath && (selected === 'commit500' || selected === 'no-commit500') || path === listFinishPath && selected === 'hold-list'
        || path === listBeginPath && selected === 'begin503') fault = 'none'
      const work = (async () => {
        if (path === listBeginPath && selected === 'begin503') {
          incoming.resume(); outgoing.writeHead(503, { 'x-tss-raw': 'true', 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer' }); outgoing.end('Owned service unavailable'); return
        }
        if (path === revokeFinishPath && selected === 'no-commit500') { incoming.resume(); unavailable(outgoing); return }
        await new Promise<void>((done, reject) => {
          const call = httpRequest({ hostname: '127.0.0.1', port: upstream, localAddress: '127.0.0.2', method: incoming.method, path: incoming.url, signal: AbortSignal.timeout(15000),
            headers: { ...incoming.headers, 'x-real-ip': `198.19.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }, response => {
            void (async () => {
              if (variant === 'clock-skew' && (path === listBeginPath || path === revokeBeginPath) && response.statusCode === 200) {
                const action = path === listBeginPath ? 'LIST' : 'REVOKE'
                // Observe committed DB proof before forwarding the real Begin
                // stream. Never pause/resume an already pending CTAP request.
                const proof = (await bounded(stores!.administrator.query(`SELECT count(*)::int n, bool_and(expires_at > clock_timestamp()) live,
                  min(extract(epoch FROM (expires_at-clock_timestamp()))*1000)::float8 AS remaining_ms,
                  extract(epoch FROM clock_timestamp())*1000 AS database_now
                  FROM verification WHERE identifier LIKE $1 AND value::jsonb->>'action'=$2`,
                ['application-session-v1:' + Buffer.from(principal.userId, 'utf8').toString('hex') + ':%', action]), 15000)).rows[0]
                const witness = { action, count: Number(proof.n), live: proof.live === true, remainingMs: Number(proof.remaining_ms),
                  databaseNow: Number(proof.database_now), nodeDatabaseDeltaMs: Math.abs(Date.now() - Number(proof.database_now)) }
                clockProofs.push(witness)
                observations.push({ checkpoint: 'clock-skew-before-begin-forward', ...witness })
                expect({ count: witness.count, live: witness.live }).toEqual({ count: 1, live: true })
                expect(witness.remainingMs).toBeGreaterThan(240000); expect(witness.nodeDatabaseDeltaMs).toBeLessThan(10000)
              }
              if (path === revokeFinishPath && selected === 'commit500' || path === listFinishPath && selected === 'hold-list') {
                const chunks: Buffer[] = []; let size = 0
                await bounded(new Promise<void>((resolve, reject) => {
                  response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1048576) { response.destroy(); reject(new Error('Owned response exceeds limit')) } else chunks.push(chunk) })
                  response.once('end', resolve); response.once('error', reject)
                }), 10000)
                expect(response.statusCode).toBe(200)
                if (selected === 'commit500') unavailable(outgoing)
                else {
                  held = true; await bounded(new Promise<void>(resolve => { release = resolve }), 15000)
                  outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(Buffer.concat(chunks))
                }
              } else { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); await bounded(new Promise<void>((resolve, reject) => {
                response.once('end', resolve); response.once('error', reject); response.once('aborted', () => reject(new Error('Owned response aborted')))
              }), 15000) }
              done()
            })().catch(reject)
          })
          upstreamRequests.add(call); call.once('close', () => upstreamRequests.delete(call))
          call.once('error', reject); incoming.pipe(call)
        })
      })().catch(() => { counts.proxyErrors++; outgoing.destroy() })
      pendingProxy.add(work); void work.finally(() => pendingProxy.delete(work))
    })
    await bounded(new Promise<void>((done, reject) => { proxy!.once('error', reject); proxy!.listen(port, '127.0.0.1', done) }), 15000)
    await checkpoint('web: HTTPS proxy ready')
    await checkpoint('browser: launch starting')
    const launchInputs = { headless: true, timeout: 30000, args: [`--ignore-certificate-errors-spki-list=${spki}`] }
    browser = await chromium.launch(launchInputs)
    await checkpoint('browser: launched')
    context = await browser.newContext({ viewport: { width: 320, height: 720 } }); second = await browser.newContext()
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(15000)
    second.setDefaultTimeout(15000); second.setDefaultNavigationTimeout(15000)
    for (const ctx of [context, second]) await ctx.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      counts.foreignRequests++; return route.abort()
    })
    await context.addInitScript(({ finish }) => {
      const native = window.fetch
      // Only the selected late-success discriminator ignores its browser abort;
      // the response still comes from the actual compiled/native backend.
      Reflect.set(window, '__sessionIgnoreNextAbort', false)
      window.fetch = (input, init) => {
        if (typeof input === 'string' && new URL(input, location.href).pathname === finish && Reflect.get(window, '__sessionIgnoreNextAbort')) {
          Reflect.set(window, '__sessionIgnoreNextAbort', false); return native(input, { ...init, signal: AbortSignal.timeout(15000) })
        }
        const supplied = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const signal = supplied ? AbortSignal.any([supplied, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
        return native(input, { ...init, signal })
      }
      const witness = { documentId: crypto.randomUUID(), started: 0, aborted: 0, settled: 0, delayNextRejection: false, delayed: false }
      const attempts: { id: number; signal?: AbortSignal | null; settled: boolean }[] = []
      const emit = (attemptId: number, kind: string, errorName?: string) => {
        console.debug('SESSION_NATIVE_WITNESS:' + JSON.stringify({ documentId: witness.documentId, attemptId, kind, ...(errorName ? { errorName } : {}) }))
      }
      Reflect.set(window, '__sessionCredentialEvents', witness)
      Reflect.set(window, '__sessionCredentialAttempts', attempts)
      Reflect.set(window, '__sessionReleaseOldRejection', () => {})
      window.addEventListener('pagehide', () => { const last = attempts.at(-1); if (last) emit(last.id, 'pagehide') })
      const get = navigator.credentials.get.bind(navigator.credentials)
      navigator.credentials.get = options => {
        const attempt = { id: ++witness.started, signal: options?.signal, settled: false }; attempts.push(attempt)
        emit(attempt.id, 'get-start')
        const delay = witness.delayNextRejection; witness.delayNextRejection = false
        options?.signal?.addEventListener('abort', () => {
          witness.aborted++; emit(attempt.id, 'signal-abort')
        }, { once: true })
        return get(options).then(value => { emit(attempt.id, 'native-fulfilled'); return value }).catch(error => {
          const name = error instanceof Error || error instanceof DOMException ? error.name : 'UnknownError'
          emit(attempt.id, 'native-rejection', /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'UnknownError')
          if (!delay) throw error
          witness.delayed = true
          return new Promise<never>((_resolve, reject) => { Reflect.set(window, '__sessionReleaseOldRejection', () => reject(error)) })
        }).finally(() => { attempt.settled = true; witness.settled++; emit(attempt.id, 'settled') })
      }
    }, { finish: listFinishPath })
    await addCookie(context, originalCookie, origin); await addCookie(second, target.cookie, origin)
    page = await context.newPage(); secondPage = await second.newPage(); cdp = await context.newCDPSession(page)
    await checkpoint('CDP: authenticator setup starting')
    cdp.on('Runtime.consoleAPICalled', event => {
      const value: unknown = event.args.length === 1 ? event.args[0].value : undefined
      if (typeof value !== 'string' || !value.startsWith('SESSION_NATIVE_WITNESS:')) return
      try {
        const marker = Schema.decodeUnknownSync(nativeMarker)(JSON.parse(value.slice('SESSION_NATIVE_WITNESS:'.length)), { onExcessProperty: 'error' })
        nativeEvents.push({ sequence: nativeEvents.length + 1, ...marker, executionContextId: event.executionContextId })
        if (marker.kind === 'signal-abort') counts.nativeAborts++
      } catch { failures.push('invalid-native-marker') }
    })
    cdp.on('Page.frameNavigated', event => {
      if (event.frame.parentId) return
      let path = 'other', language: string | null = null
      try {
        const url = new URL(event.frame.url)
        if (['/account', '/workspace', '/login'].includes(url.pathname)) path = url.pathname
        if (url.searchParams.get('lang') === 'en' || url.searchParams.get('lang') === 'fr') language = url.searchParams.get('lang')
      } catch {}
      nativeEvents.push({ sequence: nativeEvents.length + 1, kind: 'frame-navigation', frameId: event.frame.id, loaderId: event.frame.loaderId, path, locale: language })
    })
    cdp.on('Runtime.executionContextCreated', event => {
      // CDP declares auxData as a string map; decode the Chromium runtime
      // projection instead of casting its boolean isDefault field.
      let auxiliary: { readonly isDefault?: boolean; readonly frameId?: string }
      try { auxiliary = Schema.decodeUnknownSync(Schema.Struct({ isDefault: Schema.optional(Schema.Boolean), frameId: Schema.optional(Schema.String) }))(event.context.auxData) }
      catch { return }
      if (auxiliary.isDefault !== true) return
      const frameId = auxiliary.frameId
      defaultContexts.set(event.context.id, { frameId, uniqueContextId: event.context.uniqueId })
      nativeEvents.push({ sequence: nativeEvents.length + 1, kind: 'default-context-created', executionContextId: event.context.id, frameId, uniqueContextId: event.context.uniqueId })
    })
    cdp.on('Runtime.executionContextDestroyed', event => {
      const prior = defaultContexts.get(event.executionContextId)
      if (prior) nativeEvents.push({ sequence: nativeEvents.length + 1, kind: 'default-context-destroyed', executionContextId: event.executionContextId, ...prior })
      defaultContexts.delete(event.executionContextId)
    })
    cdp.on('Runtime.executionContextsCleared', () => {
      nativeEvents.push({ sequence: nativeEvents.length + 1, kind: 'contexts-cleared' }); defaultContexts.clear()
    })
    await bounded(cdp.send('Runtime.enable'), 15000)
    await bounded(cdp.send('Page.enable'), 15000)
    const version = await bounded(cdp.send('Browser.getVersion'), 15000)
    browserEvidence = { getVersion: version, product: version.product, revision: version.revision, protocolVersion: version.protocolVersion,
      executableObservation: 'UNAVAILABLE', effectiveLaunchFlagsObservation: 'UNAVAILABLE', nativeTerminationDirectlyObserved: false }
    const require = createRequire(import.meta.url), playwrightPackagePath = require.resolve('playwright/package.json')
    const corePackagePath = createRequire(playwrightPackagePath).resolve('playwright-core/package.json')
    const packageVersion = Schema.Struct({ version: Schema.Literal('1.62.1') })
    const playwrightPackage = Schema.decodeUnknownSync(packageVersion)(JSON.parse(await readFile(playwrightPackagePath, 'utf8')))
    const corePackage = Schema.decodeUnknownSync(packageVersion)(JSON.parse(await readFile(corePackagePath, 'utf8')))
    const defaultsHash = createHash('sha256').update(await readFile(resolve(dirname(corePackagePath), 'lib/coreBundle.js'))).digest('hex')
    const sourceTupleMatches = version.product === 'HeadlessChrome/151.0.7922.34' && version.revision.replace(/^@/, '') === '782af9cb30a53f54487e5d2e44738645a8ec457c'
    browserEvidence = { ...browserEvidence, playwright: playwrightPackage.version, playwrightCore: corePackage.version,
      sourceTupleMatches, expectedChromiumVersion: '151.0.7922.34', expectedChromiumRevision: '782af9cb30a53f54487e5d2e44738645a8ec457c',
      launchConfigurationEvidence: { classification: 'configuration-derived, not runtime-observed', explicitInputs: launchInputs,
        installedDefaultsReference: 'playwright-core/lib/coreBundle.js', installedDefaultsSha256: defaultsHash,
        limitation: 'Browser.getBrowserCommandLine refused without enable-automation; no alternative retrieval or flag change attempted.' }, webAuthnEnableUI: false }
    if (!sourceTupleMatches) throw new Error('Owned Chromium qualification tuple drift')
    await bounded(cdp.send('WebAuthn.enable', { enableUI: false }), 15000)
    const { authenticatorId } = await bounded(cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }), 15000)
    async function syncCredential() {
      const count = (await stores!.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [principal.userId])).rows[0].counter
      counter = count
      await bounded(cdp!.send('WebAuthn.clearCredentials', { authenticatorId }), 15000)
      const credential = key.virtualAuthenticatorCredential('localhost', registration.options.user.id, count)
      privacyCanaries.add(credential.privateKey)
      await bounded(cdp!.send('WebAuthn.addCredential', { authenticatorId, credential }), 15000)
    }
    await syncCredential()
    await checkpoint('CDP: authenticator ready')
    cdp.on('WebAuthn.credentialAsserted', () => { counts.assertion++ })
    page.on('console', message => { consoleText += message.text() }); page.on('pageerror', () => { counts.pageErrors++ })
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === listBeginPath) counts.listBegin++; if (path === listFinishPath) counts.listFinish++
      if (path === revokeBeginPath) counts.revokeBegin++; if (path === revokeFinishPath) counts.revokeFinish++
      if (path === accountPath) counts.account++
    })
    page.on('response', response => {
      if (![listBeginPath, listFinishPath, revokeBeginPath, revokeFinishPath].includes(new URL(response.url()).pathname)) return
      nativeCookiePublished ||= !!response.headers()['set-cookie']
      void response.text().then(text => { capturedBodyLeak ||= leaks(text) }).catch(() => {})
    })
    async function activate(label: string) {
      const button = page!.getByRole('button', { name: label, exact: true }); await expect.poll(() => button.isEnabled()).toBe(true)
      await button.focus(); await page!.keyboard.press('Enter')
    }
    async function view(label: string = t.refresh) {
      await checkpoint('LIST: starting')
      const response = page!.waitForResponse(response => new URL(response.url()).pathname === listFinishPath && response.status() === 200)
      await activate(label); await response
      await expect.poll(() => page!.locator('.auth-sessions').getAttribute('aria-busy')).toBe('false')
      await checkpoint('LIST: complete')
    }
    async function documentId() {
      return Schema.decodeUnknownSync(documentIdSchema)(await page!.evaluate(() => Reflect.get(window, '__sessionCredentialEvents').documentId))
    }
    async function pendingAttempt() {
      const attempt = Schema.decodeUnknownSync(pendingAttemptSchema)(await page!.evaluate(() => {
        const attempts: { id: number; signal?: AbortSignal | null; settled: boolean }[] = Reflect.get(window, '__sessionCredentialAttempts')
        const current = attempts.at(-1)
        return { documentId: Reflect.get(window, '__sessionCredentialEvents').documentId, id: current?.id,
          hasSignal: current?.signal instanceof AbortSignal, aborted: current?.signal?.aborted, settled: current?.settled }
      }), { onExcessProperty: 'error' })
      expect(attempt.hasSignal && !attempt.aborted && !attempt.settled).toBe(true)
      return attempt
    }
    async function freshViewReady() {
      const region = page!.getByRole('region', { name: t.title, exact: true })
      await expect.poll(() => region.getByRole('button', { name: t.view, exact: true }).isEnabled()).toBe(true)
      await region.getByText(t.idle, { exact: true }).waitFor()
      expect(await region.locator('.auth-session-list li').count()).toBe(0)
    }
    async function otherStatus() { return secondPage!.evaluate(async path => (await fetch(path, { headers: { 'x-tsr-serverFn': 'true' }, signal: AbortSignal.timeout(15000) })).status, accountPath) }
    async function revoke(id: string) {
      const control = page!.locator(`.auth-session-list li[data-session-id="${id}"]`).getByRole('button', { name: t.revoke, exact: true })
      await control.focus(); await page!.keyboard.press('Enter')
    }
    async function currentSnapshot() { return createHash('sha256').update(JSON.stringify((await stores!.administrator.query('SELECT * FROM session WHERE id=$1', [principal.sessionId])).rows)).digest('hex') }
    async function check(label: string) {
      const html = await page!.content(), storage = await page!.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }))
      expect(leaks(html) || leaks(consoleText) || leaks(web!.output()) || leaks(JSON.stringify(storage)) || capturedBodyLeak).toBe(false)
      expect(storage.local.length).toBe(0); expect(storage.session.filter(([name]) => name !== 'tsr-scroll-restoration-v1_3').length).toBe(0)
      expect(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await checkpoint('Axe: ' + label + ' starting')
      const violations = (await bounded(new AxeBuilder({ page: page! }).analyze(), 30000)).violations.map(value => ({ id: value.id, impact: value.impact }))
      expect(violations).toEqual([])
      await checkpoint('Axe: ' + label + ' complete')
      await bounded(page!.screenshot({ path: resolve(directory, `sessions-${runId}-${label}.png`), fullPage: true }), 15000)
      observations.push({ checkpoint: label, width: 320, privacy: true, axeViolations: 0 })
    }
    await checkpoint('anonymous/native boundary: starting')
    for (const [name, data] of [['beginSessionList', {}], ['beginSessionRevocation', { sessionId: target.sessionId }]] as const) {
      const response = await browser.newContext().then(async anonymous => {
        try {
          anonymous.setDefaultTimeout(15000); anonymous.setDefaultNavigationTimeout(15000)
          const guest = await anonymous.newPage(); await guest.goto(origin + '/login?lang=en')
          return await guest.evaluate(async ({ path, body }) => {
            const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, body, signal: AbortSignal.timeout(15000) })
            return { status: response.status, headers: Object.fromEntries(response.headers) }
          }, { path: await authRpcPath(name), body: await rpcBody(data) })
        }
        finally { await anonymous.close() }
      })
      expect(response.status).toBe(401)
      expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers.pragma).toBe('no-cache'); expect(response.headers['referrer-policy']).toBe('no-referrer')
    }
    await checkpoint('anonymous/native boundary: complete')
    await checkpoint('initial SSR and keyboard: starting')
    await page.goto(origin + '/account?lang=' + locale)
    await secondPage.goto(origin + '/account?lang=' + locale)
    expect(await page.evaluate(async () => (await fetch('/api/auth/application/session-management', { method: 'POST', signal: AbortSignal.timeout(15000) })).status)).toBe(404)
    expect(await page.locator('.auth-session-list li').count()).toBe(0); expect(counts.listBegin).toBe(0)
    let reached = false
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab')
      if (await page.getByRole('button', { name: t.view, exact: true }).evaluate(element => element === document.activeElement)) { reached = true; break }
    }
    expect(reached).toBe(true)
    const accountReads = counts.account, before = await currentSnapshot()
    if (variant === 'clock-skew') {
      // Change only the page's wall-clock reading, not native WebAuthn, Node,
      // database time, timers or accepted responses. This is the first LIST.
      await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 600000 })
      const finishResponses: { action: string; status: number; finished: boolean }[] = []
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (path !== listFinishPath && path !== revokeFinishPath) return
        const entry = { action: path === listFinishPath ? 'LIST' : 'REVOKE', status: response.status(), finished: false }
        finishResponses.push(entry)
        void response.finished().then(error => { entry.finished = error === null }).catch(() => {})
      })
      for (const action of ['LIST', 'REVOKE'] as const) {
        await checkpoint('browser clock ahead: ' + action)
        const started = await page.evaluate(() => Number(Reflect.get(window, '__sessionCredentialEvents').started))
        const attempt = { documentId: await documentId(), id: started + 1 }
        const assertions = counts.assertion, ingressBefore = { ...ingress }
        if (action === 'LIST') expect(started).toBe(0)
        if (action === 'LIST') await activate(t.view)
        else await revoke(target.sessionId)
        await expect.poll(() => page!.evaluate(() => Number(Reflect.get(window, '__sessionCredentialEvents').started))).toBe(started + 1)
        const proof = clockProofs.find(proof => proof.action === action)
        if (!proof) throw new Error('Live DB proof observation before Begin forwarding missing')
        const browserAheadMs = await page.evaluate(() => Date.now()) - proof.databaseNow
        expect(browserAheadMs).toBeGreaterThan(590000)
        observations.push({ checkpoint: 'clock-skew-live-proof', action, firstListCold: action === 'LIST' && started === 0,
          documentId: attempt.documentId, attemptId: attempt.id, databaseProofLive: proof.live, remainingMs: proof.remainingMs,
          browserAheadMs, nodeDatabaseDeltaMs: proof.nodeDatabaseDeltaMs, automaticPresenceAlwaysTrue: true })
        // Both the old refusal and the accepted result become non-busy. Do not
        // leave a waitForResponse promise rejecting when old code skips Finish.
        await expect.poll(() => page!.locator('.auth-sessions').getAttribute('aria-busy')).toBe('false')
        await expect.poll(() => counts.assertion).toBe(assertions + 1)
        const events = nativeEvents.filter(event => event.documentId === attempt.documentId && event.attemptId === attempt.id)
        expect(events.some(event => event.kind === 'native-fulfilled')).toBe(true)
        const result = { action, nativeSigned: true,
          finishCalls: action === 'LIST' ? ingress.finishSessionList - ingressBefore.finishSessionList : ingress.finishSessionRevocation - ingressBefore.finishSessionRevocation,
          accepted: await page.getByText(action === 'LIST' ? t.listed : t.confirmed, { exact: true }).count() === 1,
          clientRefused: await page.getByText(t.refused, { exact: true }).count() === 1 }
        observations.push({ checkpoint: 'clock-skew-outcome', ...result })
        expect(result).toEqual({ action, nativeSigned: true, finishCalls: 1, accepted: true, clientRefused: false })
        await expect.poll(() => finishResponses.some(response => response.action === action && response.status === 200 && response.finished)).toBe(true)
        expect(await currentSnapshot()).toBe(before); expect(counts.account).toBe(accountReads)
      }
      expect(await otherStatus()).toBe(401)
      expect((await stores.administrator.query('SELECT count(*)::int n FROM auth_session_revocation WHERE actor_user_id=$1 AND target_session_id=$2', [principal.userId, target.sessionId])).rows[0].n).toBe(1)
      observations.push({ checkpoint: 'clock-skew-native-effects', exactOtherCookie401: true, originalNoTouch: true, auditFacts: 1, finishResponses })
      expect(counts.proxyErrors + counts.pageErrors + counts.foreignRequests).toBe(0)
      expect(nativeCookiePublished || capturedBodyLeak).toBe(false)
      return
    }
    await checkpoint('initial LIST: starting')
    await page.keyboard.press('Enter'); await page.getByText(t.listed, { exact: true }).waitFor()
    await checkpoint('initial LIST: complete')
    expect(await currentSnapshot()).toBe(before); expect(counts.account).toBe(accountReads)
    expect(await page.locator(`li[data-session-id="${principal.sessionId}"] button`).count()).toBe(0)
    await check('listed')
    if (variant === 'cancel-race') {
      stage = 'old rejection settles after new native ceremony begins'
      const witness = () => page!.evaluate(() => {
        const value = Reflect.get(window, '__sessionCredentialEvents')
        const attempts: { id: number; signal?: AbortSignal | null; settled: boolean }[] = Reflect.get(window, '__sessionCredentialAttempts')
        return { started: Number(value.started), aborted: Number(value.aborted), settled: Number(value.settled), delayed: Boolean(value.delayed),
          attempts: attempts.map(attempt => ({ id: attempt.id, hasSignal: attempt.signal instanceof AbortSignal, aborted: attempt.signal?.aborted ?? null, settled: attempt.settled })) }
      })
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
      const before = await witness()
      await page.evaluate(() => { Reflect.get(window, '__sessionCredentialEvents').delayNextRejection = true })
      try {
        await activate(t.refresh); await expect.poll(async () => (await witness()).started).toBe(before.started + 1)
        await activate(t.cancel); await expect.poll(async () => (await witness()).delayed).toBe(true)
        await activate(t.refresh); await expect.poll(async () => (await witness()).started).toBe(before.started + 2)
        await page.evaluate(() => { Reflect.get(window, '__sessionReleaseOldRejection')() })
        await expect.poll(async () => (await witness()).attempts.find(attempt => attempt.id === before.started + 1)?.settled).toBe(true)
        // Complete rejection propagation through SimpleWebAuthn and the panel's
        // finally before cancelling the second still-pending native operation.
        await page.evaluate(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
        const beforeCancel = await witness(), currentAttempt = beforeCancel.attempts.find(attempt => attempt.id === before.started + 2)
        expect(currentAttempt).toEqual({ id: before.started + 2, hasSignal: true, aborted: false, settled: false })
        observations.push({ checkpoint: 'second-native-before-cancel', attempt: currentAttempt, oldAttemptSettled: true, eventLoopTurn: true })
        await activate(t.cancel)
        await page.getByText(t.cancelled, { exact: true }).waitFor()
        await expect.poll(async () => (await witness()).attempts.find(attempt => attempt.id === before.started + 2)?.aborted, { timeout: 1200 }).toBe(true)
        observations.push({ checkpoint: 'ceremony-identity', delegatedNativeGet: true, oldRejectionDelayed: true, newNativeSignalAborted: true })
      } finally {
        observations.push({ checkpoint: 'ceremony-identity-observation', before, after: await witness() })
        await page.evaluate(() => { Reflect.get(window, '__sessionReleaseOldRejection')() })
        await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
      }
      return
    }
    stage = 'actual other-cookie revocation'
    expect(await otherStatus()).toBe(200)
    await revoke(target.sessionId); await page.getByText(t.confirmed, { exact: true }).waitFor()
    expect(await otherStatus()).toBe(401)
    expect(await currentSnapshot()).toBe(before); expect(counts.account).toBe(accountReads)
    observations.push({ checkpoint: 'native-two-context', otherCookie401: true, originalNoTouch: true, ancillaryAccountRefreshes: 0 })
    stage = 'native target beyond page1 and lost noncommitted response'
    const uncertain = await nativeLogin(); await addCookie(second, uncertain.cookie, origin)
    for (let i = 0; i < 26; i++) await nativeLogin()
    await syncCredential(); await view(); await view(t.next)
    fault = 'no-commit500'; const finishesBefore = counts.revokeFinish
    await revoke(uncertain.sessionId); await page.getByText(t.unconfirmed, { exact: true }).waitFor()
    await activate(t.check); await page.getByText(t.active, { exact: true }).waitFor()
    expect(counts.revokeFinish).toBe(finishesBefore + 1)
    expect(await page.locator(`li[data-session-id="${uncertain.sessionId}"]`).count()).toBe(0)
    await stores.administrator.query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [uncertain.sessionId])
    await activate(t.check); await page.getByText(t.ineligible, { exact: true }).waitFor()
    expect((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE id=$1', [uncertain.sessionId])).rows[0].n).toBe(1)
    stage = 'committed response loss'
    const committed = await nativeLogin(); await addCookie(second, committed.cookie, origin); await syncCredential(); await view()
    fault = 'commit500'; await revoke(committed.sessionId); await page.getByText(t.unconfirmed, { exact: true }).waitFor()
    expect((await stores.administrator.query('SELECT count(*)::int n FROM auth_session_revocation WHERE actor_user_id=$1 AND target_session_id=$2', [principal.userId, committed.sessionId])).rows[0].n).toBe(1)
    await activate(t.check); await page.getByText(t.absent, { exact: true }).waitFor()
    expect(await otherStatus()).toBe(401)
    await check('uncertain-absent')
    stage = 'unavailable and native proof refusal'
    fault = 'begin503'; await activate(t.refresh); await page.getByText(t.unavailable, { exact: true }).waitFor()
    const persistedKey = (await stores.administrator.query('SELECT public_key FROM passkey WHERE user_id=$1', [principal.userId])).rows[0].public_key
    await stores.administrator.query("UPDATE passkey SET public_key='AQ==' WHERE user_id=$1", [principal.userId])
    try { await activate(t.refresh); await page.getByText(t.refused, { exact: true }).waitFor() }
    finally { await stores.administrator.query('UPDATE passkey SET public_key=$2 WHERE user_id=$1', [principal.userId, persistedKey]) }
    stage = 'unsupported browser control'
    const unsupported = await browser.newContext()
    try {
      await unsupported.addCookies(await context.cookies())
      await unsupported.addInitScript(() => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }) })
      const unsupportedPage = await unsupported.newPage(); await unsupportedPage.goto(origin + '/account?lang=' + locale)
      await unsupportedPage.getByRole('region', { name: t.title, exact: true }).getByText(t.unsupported, { exact: true }).waitFor()
      expect(await unsupportedPage.getByRole('button', { name: t.view, exact: true }).isDisabled()).toBe(true)
    } finally { await unsupported.close() }
    await checkpoint('retained-document synthetic pagehide: starting')
    await bounded(cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false }), 15000)
    const retainedStarted = await page.evaluate(() => Number(Reflect.get(window, '__sessionCredentialEvents').started))
    await activate(t.refresh)
    await expect.poll(() => page!.evaluate(() => Number(Reflect.get(window, '__sessionCredentialEvents').started))).toBeGreaterThan(retainedStarted)
    const retained = await pendingAttempt(), retainedWatch = watchCommands()
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })) })
    expect(await documentId()).toBe(retained.documentId)
    await expect.poll(() => page!.evaluate(id => {
      const attempts: { id: number; signal?: AbortSignal | null }[] = Reflect.get(window, '__sessionCredentialAttempts')
      return attempts.find(attempt => attempt.id === id)?.signal?.aborted
    }, retained.id)).toBe(true)
    const retainedEvents = () => nativeEvents.filter(event => event.documentId === retained.documentId && event.attemptId === retained.id)
    await expect.poll(() => {
      const events = retainedEvents(), rejection = events.find(event => event.kind === 'native-rejection' && event.errorName === 'AbortError')
      const settled = events.find(event => event.kind === 'settled')
      return !!rejection && !!settled && rejection.sequence < settled.sequence
    }).toBe(true)
    expect(retainedEvents().some(event => event.kind === 'native-fulfilled')).toBe(false)
    await freshViewReady()
    const retainedRequests = retainedWatch()
    observations.push({ checkpoint: 'retained-document-pagehide-handler', stimulus: 'synthetic PageTransitionEvent(pagehide, persisted=false)',
      scriptCancellationWitness: { documentRetained: true, documentId: retained.documentId, attemptId: retained.id,
        signalFalseToTrue: true, rejection: 'AbortError', settled: true, events: retainedEvents() },
      nativeTerminationObservation: { directlyObserved: false }, privateRowsCleared: true, noUnexpectedRequestsThroughReady: retainedRequests,
      label: 'Synthetic pagehide dispatch in a retained document; real product handler and real delegated native cancellation.' })
    await bounded(cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true }), 15000)
    await view(t.view)
    await checkpoint('retained-document synthetic pagehide: complete')

    stage = 'hard navigation application outcomes'
    for (const navigation of ['workspace', 'locale'] as const) {
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
      const beforeStarted = await page.evaluate(() => Number(Reflect.get(window, '__sessionCredentialEvents').started))
      await activate(t.refresh); await page.getByText(t.verifying, { exact: true }).waitFor()
      await expect.poll(() => page!.evaluate(() => Number(Reflect.get(window, '__sessionCredentialEvents').started))).toBeGreaterThan(beforeStarted)
      const pending = await pendingAttempt(), stopWatching = watchCommands()
      const sequenceBeforeNavigation = nativeEvents.length
      const oldFrame = nativeEvents.filter(event => event.kind === 'frame-navigation').at(-1)
      if (!oldFrame?.loaderId || !oldFrame.frameId) throw new Error('Owned old frame identity unavailable')
      const exactEvents = () => nativeEvents.filter(event => event.documentId === pending.documentId && event.attemptId === pending.id)
      expect(exactEvents().some(event => event.kind === 'signal-abort' || event.kind === 'native-rejection' || event.kind === 'native-fulfilled')).toBe(false)
      const oldContextId = exactEvents().find(event => event.kind === 'get-start')?.executionContextId
      const expectedPath = navigation === 'workspace' ? '/workspace' : '/account', expectedLocale = navigation === 'workspace' ? locale : locale === 'en' ? 'fr' : 'en'
      if (navigation === 'workspace') await page.getByRole('navigation', { name: locale === 'fr' ? 'Navigation principale' : 'Main navigation' }).getByRole('link', { name: locale === 'fr' ? 'Espace' : 'Workspace', exact: true }).click()
      else await page.goto(origin + expectedPath + '?lang=' + expectedLocale)
      const replacementDocumentId = await documentId(), destination = new URL(page.url())
      expect(replacementDocumentId === pending.documentId).toBe(false)
      expect({ path: destination.pathname, locale: destination.searchParams.get('lang') }).toEqual({ path: expectedPath, locale: expectedLocale })
      const replacement = nativeEvents.find(event => event.kind === 'frame-navigation' && event.sequence > sequenceBeforeNavigation
        && event.frameId === oldFrame.frameId && event.path === expectedPath && event.locale === expectedLocale && event.loaderId !== oldFrame.loaderId)
      expect(replacement).toBeDefined()
      await page.goto(origin + '/account?lang=' + locale)
      const returnedDocumentId = await documentId(), returned = new URL(page.url())
      expect({ path: returned.pathname, locale: returned.searchParams.get('lang') }).toEqual({ path: '/account', locale })
      expect(returnedDocumentId === pending.documentId).toBe(false)
      await freshViewReady()
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
      const requestsThroughReentry = stopWatching(), freshBaseline = { ...ingress }, assertionsBefore = counts.assertion
      await view(t.view)
      expect(ingress).toEqual({ ...freshBaseline, beginSessionList: freshBaseline.beginSessionList + 1, finishSessionList: freshBaseline.finishSessionList + 1 })
      expect(counts.assertion).toBe(assertionsBefore + 1)
      observations.push({ checkpoint: 'hard-navigation-application-outcome', navigation, documentId: pending.documentId, attemptId: pending.id,
        replacementDocumentId, returnedDocumentId, oldLoader: oldFrame.loaderId, newLoader: replacement!.loaderId,
        scriptCancellationWitness: { status: exactEvents().some(event => event.kind === 'signal-abort' || event.kind === 'native-rejection') ? 'OBSERVED' : 'NOT_OBSERVED', events: exactEvents() },
        nativeTerminationObservation: { directlyObserved: false, sourceQualification: 'separate revision-matched ROOT report' },
        oldDefaultContextLifecycle: nativeEvents.filter(event => event.sequence > sequenceBeforeNavigation
          && (event.kind === 'contexts-cleared' || event.kind === 'default-context-destroyed' && event.executionContextId === oldContextId)),
        hardNavigationSafetyOutcome: { replacement: true, expectedPath, expectedLocale, requestsThroughReentry,
          privateResultNotResurrectedOnReadyReentry: true, freshExplicitNativeCeremony: true } })
    }
    stage = 'cancellation and reload'
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
    const priorFinish = counts.listFinish
    await activate(t.refresh); await page.getByText(t.verifying, { exact: true }).waitFor(); await activate(t.cancel)
    await page.getByText(t.cancelled, { exact: true }).waitFor(); expect(counts.listFinish).toBe(priorFinish)
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
    const priorBegin = counts.listBegin
    await page.reload(); await page.getByRole('button', { name: t.view, exact: true }).waitFor()
    expect(await page.locator('.auth-session-list li').count()).toBe(0); expect(counts.listBegin).toBe(priorBegin)
    await view(t.view)
    stage = 'real principal401 defeats late actual success'
    await page.evaluate(() => { Reflect.set(window, '__sessionIgnoreNextAbort', true) })
    fault = 'hold-list'; held = false
    await activate(t.refresh); await expect.poll(() => held).toBe(true)
    expect(await page.evaluate(() => Reflect.get(window, '__sessionIgnoreNextAbort'))).toBe(false)
    await activate(t.cancel)
    await stores.administrator.query('DELETE FROM session WHERE id=$1', [principal.sessionId])
    await activate(t.refresh); await page.getByText(messages[locale].accountLoadFailed, { exact: true }).waitFor()
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === listFinishPath && response.status() === 200)
    release()
    expect(await (await lateResponse).finished()).toBeNull()
    await page.evaluate(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
    await bounded(Promise.all([...pendingProxy]), 10000)
    expect(await page.locator('.auth-sessions').count()).toBe(0)
    expect(nativeCookiePublished || capturedBodyLeak).toBe(false)
    expect(counts.proxyErrors).toBe(0); expect(counts.pageErrors).toBe(0); expect(counts.foreignRequests).toBe(0)
    observations.push({ checkpoint: 'actual401-late-success', privateRowsCleared: true, lateActual200Ignored: true,
      ignoreUiAbortConsumed: true, clientResponseFinished: true, eventLoopTurn: true, nativeCookiePublished: false })
  } catch (error) {
    failures.push(stage)
    throw error
  } finally {
    ingressWatch = undefined
    try { await checkpoint('cleanup: starting') } catch { failures.push('cleanup-progress') }
    release()
    try { await bounded(Promise.allSettled([...pendingProxy]), 10000) }
    catch {
      failures.push('cleanup-pending-proxy')
      for (const request of upstreamRequests) request.destroy()
      proxy?.closeAllConnections()
      try { await bounded(Promise.allSettled([...pendingProxy]), 2000) } catch { failures.push('cleanup-pending-proxy-tail') }
    }
    for (const [name, close] of [['browser', () => browser?.close()], ['proxy', async () => {
      if (!proxy) return
      proxy.closeAllConnections()
      if (proxy.listening) await bounded(new Promise<void>((done, reject) => proxy!.close(error => error ? reject(error) : done())), 6000)
    }],
      ['web', () => web?.cleanup()], ['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()], ['stores', () => stores?.cleanup()]] as const) {
      try { await close() } catch { failures.push('cleanup-' + name) }
    }
    if (certificateDirectory) {
      try {
        const target = await realpath(certificateDirectory), parent = await realpath(tmpdir())
        if (dirname(target) !== parent || !basename(target).startsWith(`session-browser-${runId}-`)) throw new Error('Owned certificate path mismatch')
        await rm(target, { recursive: true })
      } catch { failures.push('cleanup-certificate') }
    }
    try { await checkpoint('cleanup: complete') } catch { failures.push('cleanup-progress') }
    await writeFile(resolve(directory, `browser-${runId}.json`), JSON.stringify({ runId, variant, locale, stage, failures, observations, counts, ingress, browserEvidence, nativeEvents, certificateDirectory, progressPath,
      stores: stores?.evidence, scope: 'compiled Chromium with native fixture-enrolled key and native cookies; virtual authenticator, not physical device/Safari/screen-reader proof' }, null, 2) + '\n', { flag: 'wx' })
    expect(failures.filter(value => value.startsWith('cleanup-'))).toEqual([])
  }
}, 300000)
