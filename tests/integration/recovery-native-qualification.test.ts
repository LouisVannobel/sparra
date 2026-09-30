import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { Schema } from 'effect'
import { test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { bounded, unusedLoopbackPort } from '../helpers/web-process'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { classifyQualificationEndpoint, createRecoveryNativeQualification, qualificationPath,
  type QualificationFault, type RecoveryNativeQualification } from '../helpers/recovery-native-qualification'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'

const intercepted = vi.hoisted(() => ({ qualifier: undefined as RecoveryNativeQualification | undefined,
  native: undefined as ((request: Request) => Promise<unknown>) | undefined,
  ambient: undefined as ((request: Request) => Promise<void>) | undefined,
  enrollmentToken: '', factories: 0 }))
vi.mock('better-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth')>()
  return { ...actual, betterAuth(options: Parameters<typeof actual.betterAuth>[0]) {
    const qualifier = intercepted.qualifier
    if (!qualifier || options.databaseHooks?.session) throw new Error('Qualification factory interception unavailable')
    const auth = actual.betterAuth({ ...options, plugins: [...options.plugins ?? [], qualifier.plugin],
      databaseHooks: { ...options.databaseHooks, ...qualifier.databaseHooks() } })
    intercepted.factories++
    intercepted.native = request => auth.api.qualifyRecoveryNative({ request, headers: request.headers, asResponse: true })
    intercepted.ambient = async request => {
      qualifier.captureAmbient(await auth.api.getSession({ request, headers: request.headers, asResponse: false,
        query: { disableCookieCache: true, disableRefresh: true } }))
    }
    return auth
  } }
})
vi.mock('@better-auth/passkey', async importOriginal => {
  const actual = await importOriginal<typeof import('@better-auth/passkey')>()
  return { ...actual, passkey(options: Parameters<typeof actual.passkey>[0]) {
    const qualifier = intercepted.qualifier
    if (!qualifier) throw new Error('Qualification passkey construction unavailable')
    const plugin = actual.passkey(qualifier.registration(options))
    qualifier.capturePasskey(plugin)
    return plugin
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args)
    if (!intercepted.qualifier) throw new Error('Qualification admission unavailable')
    return intercepted.qualifier.admission(plugin)
  } }
})
vi.mock('../../src/modules/auth/http-boundary.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/http-boundary.server')>()
  return { ...actual, assertEndpointClassification(...args: Parameters<typeof actual.assertEndpointClassification>) {
    classifyQualificationEndpoint(actual.assertEndpointClassification, ...args)
  } }
})
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); intercepted.enrollmentToken = args[3].toString('base64url'); return result
  } }
})

const browserReceipt = Schema.Struct({ status: Schema.Int, responseDate: Schema.optional(Schema.String), receivedAtMs: Schema.Int,
  body: Schema.Struct({ ok: Schema.optional(Schema.Boolean),
  selector: Schema.optional(Schema.String), phase: Schema.optional(Schema.String), nativePrivateRefused: Schema.optional(Schema.Boolean),
  options: Schema.optional(Schema.Unknown), keyId: Schema.optional(Schema.String), challengeId: Schema.optional(Schema.String),
  tested: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.Literal('Qualification native clear refusal')) }) })
const inputSchema = Schema.Struct({ action: Schema.Literals(['prepare', 'status', 'activate', 'clear-error', 'finish-modeled', 'seed-expired',
  'q2-register-options', 'q2-register', 'q2-assert-options', 'q2-assert', 'q3-finish']),
  selector: Schema.optional(Schema.String), gate: Schema.optional(Schema.String), seedAmbient: Schema.optional(Schema.Boolean),
  afterCommitFailure: Schema.optional(Schema.Boolean), input: Schema.optional(Schema.Unknown) })
type BrowserInput = typeof inputSchema.Type
function check(value: unknown): asserts value { if (!value) throw new Error('Qualification assertion failed (sensitive values suppressed)') }
function gate() {
  let release = () => {}, ready = () => {}
  const wait = new Promise<void>(resolve => { release = resolve }), arrived = new Promise<void>(resolve => { ready = resolve })
  return { release, ready, wait, arrived }
}
const fixtureCookies = (headers: Headers) => headers.getSetCookie().filter(value => !/;\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
async function browserCall(page: Page, input: BrowserInput) {
  const receipt = await page.evaluate(async body => {
    const result = await fetch('/q1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: result.status, responseDate: result.headers.get('date') ?? undefined, receivedAtMs: Date.now(), body: await result.json() }
  }, input)
  try { return Schema.decodeUnknownSync(browserReceipt, { onExcessProperty: 'error' })(receipt) }
  catch { throw new Error('Qualification browser receipt refused') }
}

async function runQualification(variant: 'shared-control' | 'isolated' | 'isolated-finish-delivery' | 'q2' | 'q3') {
  const mode = variant === 'shared-control' ? 'shared-control' : 'isolated'
  const finishDelivery = variant === 'isolated-finish-delivery'
  const runId = randomUUID(), startedAt = performance.now(), beforeFactories = intercepted.factories
  const directory = resolve(variant === 'q3' ? '.superpowers/sdd/2026-09-10-functional-auth/task-10B-Q3-evidence'
    : variant === 'q2' ? '.superpowers/sdd/2026-09-10-functional-auth/task-10B-Q2-evidence'
    : '.superpowers/sdd/2026-09-10-functional-auth/task-10B-Q1-evidence')
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined, pool: Pool | undefined
  let owner: ReturnType<typeof createTransactions> | undefined, app: ReturnType<typeof createApplicationAuth> | undefined
  let limiter: ReturnType<typeof createAuthRateLimiter> | undefined, browser: Browser | undefined, context: BrowserContext | undefined
  let bridge: ReturnType<typeof createServer> | undefined, certificateDirectory: string | undefined
  let origin = '', userId = '', stage = 'setup', ip = 1
  const pending = new Set<Promise<void>>(), gates = new Map<string, ReturnType<typeof gate>>()
  const browserPending: Promise<unknown>[] = []
  let browserRejections = 0, browserVersion: string | undefined
  function track<T>(work: Promise<T>): Promise<T> { browserPending.push(work); void work.catch(() => { browserRejections++ }); return work }
  const errors = { page: 0, proxy: 0, foreign: 0 }, assertions: string[] = [], cleanupFailures: string[] = []
  const headerEvidence: { action: string; status: number; selector?: string; names: string[]; attributesValid: boolean }[] = []
  const hookFaultEvidence: { fault: 'update-after' | 'delete-after'; events: string[]; snapshotUnchanged: boolean }[] = []
  let retainedP2Date: string | undefined, retainedP2SentAtMs: number | undefined
  let oldKeyBaselineCounter: number | undefined
  const retainedDateExpiryEvidence: { cookie: 'token' | 'auxiliary'; transmittedDate: string; sentAtMs: number; receivedAtMs: number;
    dateAgeAtSendMs: number; persistedDeadlineMs: number; declaredExpiresMs: number; browserExpiresMs: number;
    beyondPersistedDeadlineMs: number; declaredExpiryAdjustmentMs: number; counterexample: boolean }[] = []
  const canaries = new Set<string>()
  let browserConsole = '', rawBootstrap: Headers | undefined
  let delayedOrdinary: Headers | undefined, delayedOrdinaryFinish: Headers | undefined
  const sensitive = (value: string) => [...canaries].some(secret => secret.length >= 8 && value.includes(secret))
  function request(cookie = '', requestOrigin = origin) {
    const value = Object.assign(new Request(origin + qualificationPath, { method: 'POST', headers: { origin: requestOrigin, cookie,
      'x-real-ip': `198.18.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 15000 }); return value
  }
  const native = (value: Request) => { check(intercepted.native); return intercepted.native(value) }
  const qualifier = () => { check(intercepted.qualifier); return intercepted.qualifier }
  async function cookieHeader() {
    check(context)
    return (await context.cookies()).map(cookie => { canaries.add(cookie.value); return `${cookie.name}=${cookie.value}` }).join('; ')
  }
  async function snapshot() {
    check(stores)
    const rows = await stores.administrator.query(`SELECT * FROM (
      SELECT 'user' kind,to_jsonb(u) value FROM "user" u WHERE id=$1 UNION ALL
      SELECT 'session',to_jsonb(s) FROM session s WHERE user_id=$1 UNION ALL
      SELECT 'witness',to_jsonb(w) FROM qualification_recovery_witness w WHERE user_id=$1
      ${variant === 'q2' || variant === 'q3' ? `UNION ALL SELECT 'passkey',to_jsonb(p) FROM passkey p WHERE user_id=$1
        UNION ALL SELECT 'account',to_jsonb(a) FROM account a WHERE user_id=$1
        UNION ALL SELECT 'verification',to_jsonb(v) FROM verification v` : ''}
    ) entries ORDER BY kind,value::text`, [userId])
    return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex')
  }
  function expectedCookieNames(selector: string) {
    const prefix = `__Secure-q1-recovery.${mode === 'shared-control' ? 'shared' : selector}.`
    return { prefix, token: prefix + 'session_token', auxiliary: prefix + 'qualification_aux' }
  }
  async function inspectHeaders(action: string, response: Response, selector?: string) {
    const entries = response.headers.getSetCookie(), names: string[] = []
    // Qualification-only header budget, not an adopted product default.
    check(entries.length <= 8 && entries.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) <= 8192)
    for (const value of entries) {
      const first = value.split(';')[0], split = first.indexOf('=')
      names.push(first.slice(0, split)); canaries.add(first.slice(split + 1))
      check(/;\s*HttpOnly(?:;|$)/i.test(value) && /;\s*Secure(?:;|$)/i.test(value)
        && /;\s*SameSite=Lax(?:;|$)/i.test(value) && /;\s*Path=\/(?:;|$)/i.test(value) && !/;\s*Domain=/i.test(value))
    }
    if (action === 'prepare' && response.status === 200) {
      selector = Schema.decodeUnknownSync(Schema.Struct({ selector: Schema.String }))(await response.clone().json()).selector
      check(stores)
      const rows = await stores.administrator.query('SELECT attempts FROM qualification_recovery_witness WHERE user_id=$1', [userId])
      const attempts = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ selector: Schema.String, preparedUntil: Schema.Number, expiresAt: Schema.Number })))(rows.rows[0]?.attempts)
      const attempt = attempts.find(value => value.selector === selector); check(attempt)
      const expected = expectedCookieNames(selector)
      check(names.length === 2 && new Set(names).size === 2 && names.includes(expected.token) && names.includes(expected.auxiliary))
      for (const value of entries) {
        const name = value.slice(0, value.indexOf('=')), expiry = /;\s*Expires=([^;]+)/i.exec(value)?.[1]
        check(!/;\s*Max-Age=/i.test(value) && expiry)
        const deadline = name === expected.token ? attempt.expiresAt : attempt.preparedUntil
        check(Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) === Math.floor(deadline / 1000) * 1000)
      }
    } else if (action === 'prepare') {
      // Refused third issuance must neither issue nor clear any cookie.
      check(response.status === 503 && entries.length === 0)
    }
    if (action === 'clear-error') {
      check(response.status === 401 && selector)
      const expected = expectedCookieNames(selector)
      const required = [expected.token, expected.prefix + 'session_data', expected.prefix + 'dont_remember', expected.auxiliary]
      const allowed = new Set([...required, expected.prefix + 'oauth_state'])
      check(new Set(names).size === names.length && required.every(name => names.includes(name)) && names.every(name => allowed.has(name)))
      for (const value of entries) {
        const first = value.split(';')[0]
        check(first.slice(first.indexOf('=') + 1) === '' && /;\s*Max-Age=0(?:;|$)/i.test(value))
        const expiry = /;\s*Expires=([^;]+)/i.exec(value)?.[1]
        if (expiry !== undefined) check(Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= Date.now())
      }
    }
    if (action === 'activate' || action === 'status') check(entries.length === 0)
    if (action === 'q2-register-options') {
      const expected = selector && expectedCookieNames(selector).prefix + 'better-auth-passkey'
      check(response.status === 200 ? names.length === 1 && names[0] === expected : names.length === 0)
    }
    if (action === 'q2-register' || action === 'q2-assert-options' || action === 'q2-assert') check(entries.length === 0)
    if (action === 'q3-finish') {
      const ordinaryToken = '__Secure-better-auth.session_token'
      check(response.status === 200 ? names.length === 1 && names[0] === ordinaryToken : entries.length === 0)
    }
    headerEvidence.push({ action, status: response.status, selector, names, attributesValid: true })
  }
  async function ordinaryLogin(credential: ReturnType<typeof registrationCredentialFixture>) {
    check(app && stores)
    const count = (await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [userId])).rows[0].counter
    const start = await app.beginPasskeySignIn(request())
    return (await app.finishPasskeySignIn(request(fixtureCookies(start.headers)), {
      response: credential.authenticationResponse(start.options, { counter: count + 1 }),
    })).headers
  }
  try {
    await mkdir(directory, { recursive: true })
    stores = await startDisposableStores(); await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      ${variant === 'q3' ? 'GRANT DELETE ON public.passkey TO runtime;' : ''}
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime; GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime;
      CREATE TABLE qualification_recovery_witness(user_id text PRIMARY KEY REFERENCES "user"(id), remaining_code integer NOT NULL,
        winner text, finished boolean NOT NULL, attempts jsonb NOT NULL, q2 jsonb);
      GRANT SELECT,INSERT,UPDATE ON qualification_recovery_witness TO runtime`)
    const port = await unusedLoopbackPort(); origin = `https://localhost:${port}`
    certificateDirectory = await mkdtemp(join(tmpdir(), `q1-recovery-${runId}-`))
    const keyPath = join(certificateDirectory, 'key.pem'), certPath = join(certificateDirectory, 'cert.pem')
    const openssl = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl'
    await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } })
    const cert = await readFile(certPath), key = await readFile(keyPath)
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
    owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    intercepted.qualifier = createRecoveryNativeQualification(owner, origin, mode)
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'q1-native', TRUSTED_PROXY_IPS: '127.0.0.1' })); await limiter.connect()
    const secret = randomBytes(48).toString('hex'); canaries.add(secret)
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: secret })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }),
        profile: { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
          from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null } } }, limiter)
    check(intercepted.factories - beforeFactories === 1)
    const email = `q1-${runId}@example.test`
    await app.requestMagicLink(request(), { email, locale: 'en' }); canaries.add(intercepted.enrollmentToken)
    const proof = { token: intercepted.enrollmentToken, intendedEmail: email }
    const options = await magicConsumeResponse(request(), proof, app, limiter); check(options.status === 200)
    const credential = registrationCredentialFixture((await options.json()).options, origin)
    const enrolled = await magicEnrollmentResponse(request(fixtureCookies(options.headers)), { ...proof, response: credential.response }, app, limiter)
    check(enrolled.status === 200); rawBootstrap = enrolled.headers
    const principal = await app.requirePrincipal(request(fixtureCookies(enrolled.headers))); userId = principal.userId
    qualifier().bindUser(userId)
    await stores.administrator.query('INSERT INTO qualification_recovery_witness VALUES($1,1,NULL,false,\'[]\')', [userId])
    check(intercepted.ambient)
    await owner.runAuthInvocation({ deadlineAtMs: Date.now() + 15000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() },
      () => intercepted.ambient!(request(fixtureCookies(enrolled.headers))))
    if (variant === 'q2' || variant === 'q3') {
      await stores.administrator.query(`GRANT SELECT,INSERT,UPDATE ON public.additional_passkey_intent TO runtime;
        GRANT SELECT ON public.workspace TO runtime;
        GRANT EXECUTE ON FUNCTION app_private.resolve_personal_workspace(text,text,boolean) TO runtime`)
      check(Boolean(await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal)))
      const ordinary = await app.beginAdditionalPasskey(request(fixtureCookies(enrolled.headers)))
      const authorized = await app.authorizeAdditionalPasskey(request(fixtureCookies(enrolled.headers)), {
        intentId: ordinary.intentId, response: credential.authenticationResponse(ordinary.options) })
      delayedOrdinary = authorized.headers
      oldKeyBaselineCounter = (await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1 AND credential_id=$2',
        [userId, credential.response.id])).rows[0]?.counter
      check(Number.isSafeInteger(oldKeyBaselineCounter))
    } else {
      delayedOrdinary = await ordinaryLogin(credential)
      delayedOrdinaryFinish = await ordinaryLogin(credential)
    }
    // The production public mount must refuse the extension even though the one native instance knows it.
    check((await app.callback(request())).status === 404)
    const unbound = await native(request()).then(value => value instanceof Response && !value.ok, () => true); check(unbound)
    check(await qualifier().invoke(request(), 'prepare', value => native(new Request(value))).then(() => false, () => true))
    check(await qualifier().invoke(request(), 'prepare', () => native(request())).then(() => false, () => true))
    check(await qualifier().invoke(request('', 'https://foreign.invalid'), 'prepare', native).then(() => false, () => true))
    assertions.push('exact-request-clone-unbound-wrong-origin-and-public-mount-refused')
    bridge = createServer({ cert, key }, (incoming, outgoing) => {
      const work = (async () => {
        if (incoming.socket.remoteAddress !== '127.0.0.1' && incoming.socket.remoteAddress !== '::ffff:127.0.0.1') {
          errors.foreign++; incoming.resume(); outgoing.writeHead(403); outgoing.end(); return
        }
        if (incoming.method === 'GET' && incoming.url === '/') {
          outgoing.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); outgoing.end('<!doctype html><title>Native recovery qualification</title>'); return
        }
        if (incoming.method === 'POST' && incoming.url === '/api/auth' + qualificationPath) {
          incoming.resume(); check(app)
          const refused = await app.callback(new Request(origin + incoming.url, { method: 'POST', headers: { origin } }))
          check(refused.headers.getSetCookie().length === 0)
          outgoing.writeHead(refused.status); outgoing.end(); return
        }
        if (incoming.method !== 'POST' || !['/q1', '/bootstrap', '/ordinary', '/ordinary-finish'].includes(incoming.url ?? '')) {
          incoming.resume(); outgoing.writeHead(404); outgoing.end(); return
        }
        if (incoming.headers.origin !== origin) { incoming.resume(); outgoing.writeHead(403); outgoing.end('{}'); return }
        let response: Response, action: string, requestedSelector: string | undefined, retainedResponseDate: string | undefined
        if (incoming.url === '/bootstrap' || incoming.url === '/ordinary' || incoming.url === '/ordinary-finish') {
          incoming.resume(); action = incoming.url
          response = Response.json({ ok: true }, { headers: incoming.url === '/bootstrap' ? rawBootstrap
            : incoming.url === '/ordinary' ? delayedOrdinary : delayedOrdinaryFinish })
          const held = gates.get(incoming.url)
          if (held) { held.ready(); await bounded(held.wait, 180000) }
        } else {
          const chunks: Buffer[] = []; let length = 0
          for await (const chunk of incoming) { length += chunk.length; check(length <= 4096); chunks.push(chunk) }
          const input = Schema.decodeUnknownSync(inputSchema)(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          action = input.action
          requestedSelector = input.selector
          // This is the original bridge-created Request. The same object crosses the owner and native dispatcher.
          const originalRequest = new Request(origin + qualificationPath, { method: 'POST', headers: { origin,
            cookie: incoming.headers.cookie ?? '', 'sec-fetch-site': incoming.headers['sec-fetch-site']?.toString() ?? 'same-origin' }, signal: AbortSignal.timeout(15000) })
          try { response = await qualifier().invoke(originalRequest, input.action, native, input.selector, input) }
          catch { response = Response.json({ ok: false, phase: 'unconfirmed' }, { status: 503 }) }
          if (variant === 'isolated' && input.action === 'prepare' && input.gate === 'p2') {
            check(response.status === 200 && retainedP2Date === undefined)
            // Model a transport retaining the original Date together with native
            // Set-Cookie. Capture only after the owner settles, before this gate.
            retainedResponseDate = new Date().toUTCString(); retainedP2Date = retainedResponseDate
          }
          if (input.gate) {
            const held = gates.get(input.gate); check(held); held.ready(); await bounded(held.wait, 180000)
          }
        }
        await inspectHeaders(action, response, requestedSelector)
        if (retainedResponseDate) {
          retainedP2SentAtMs = Date.now()
          check(retainedResponseDate === retainedP2Date && retainedP2SentAtMs - Date.parse(retainedResponseDate) >= 3000)
        }
        outgoing.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store',
          ...(retainedResponseDate ? { date: retainedResponseDate } : {}),
          'set-cookie': response.headers.getSetCookie() }); outgoing.end(await response.text())
      })().catch(() => { errors.proxy++; if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end('{}') })
      pending.add(work); void work.finally(() => pending.delete(work))
    })
    await bounded(new Promise<void>((ready, reject) => { bridge!.once('error', reject); bridge!.listen(port, '127.0.0.1', ready) }), 15000)
    browser = await chromium.launch({ headless: true, timeout: 15000, args: [`--ignore-certificate-errors-spki-list=${spki}`] })
    browserVersion = browser.version()
    context = await browser.newContext(); context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000)
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { errors.foreign++; return route.abort() }
      return route.continue()
    })
    context.on('page', page => { page.on('pageerror', () => errors.page++); page.on('console', message => { browserConsole += message.text() }) })
    const page = await context.newPage(), second = await context.newPage(); await Promise.all([page.goto(origin), second.goto(origin)])
    await page.evaluate(() => fetch('/bootstrap', { method: 'POST' }))
    check(await page.evaluate(async path => (await fetch('/api/auth' + path, { method: 'POST' })).status, qualificationPath) === 404)
    if (variant === 'q2' || variant === 'q3') {
      stage = 'q2-preparations'
      const p1 = await browserCall(page, { action: 'prepare' }); check(p1.status === 200 && p1.body.selector)
      const selector = p1.body.selector
      const p2 = await browserCall(second, { action: 'prepare' }); check(p2.status === 200 && p2.body.selector && p2.body.selector !== selector)
      const prepared = await snapshot()
      check((await browserCall(page, { action: 'q2-register-options', selector })).status === 503)
      check((await browserCall(page, { action: 'q2-register', selector, input: { response: credential.response, createSession: false } })).status === 503)
      if (variant === 'q3') check((await browserCall(page, { action: 'q3-finish', selector })).status === 503)
      check(await snapshot() === prepared)
      assertions.push('prepared-cannot-generate-or-complete-native-registration')
      check((await browserCall(page, { action: 'activate', selector })).status === 200)
      const winnerCookie = (await context.cookies()).find(cookie => cookie.name === expectedCookieNames(selector).token)
      check(winnerCookie)
      const recovering = await snapshot()
      check((await browserCall(second, { action: 'q2-register-options', selector: p2.body.selector })).status === 503)
      const ordinaryCookiesOnly = (await cookieHeader()).split('; ').filter(value => !value.startsWith(winnerCookie.name + '=')).join('; ')
      check(await qualifier().invoke(request(ordinaryCookiesOnly), 'q2-register-options', native, selector,
        { seedAmbient: true }).then(() => false, () => true))
      check(await snapshot() === recovering)
      const optionsEventOffset = qualifier().evidence().events.length
      const issued = await browserCall(page, { action: 'q2-register-options', selector, seedAmbient: true })
      check(issued.status === 200)
      const optionsEvents = qualifier().evidence().events.slice(optionsEventOffset)
      check(optionsEvents.includes('q2-options-raw-cookie-names:namespaced-challenge')
        && optionsEvents.includes('q2-options-outer-header-queued-exact-native-challenge')
        && !optionsEvents.includes('q2-options-raw-cookie-invariant-violation'))
      check(await snapshot() !== recovering)
      check((await browserCall(page, { action: 'q2-register-options', selector })).status === 503)
      const beforeMissingCookie = await snapshot()
      check(await qualifier().invoke(request(ordinaryCookiesOnly), 'q2-register', native, selector,
        { seedAmbient: true, input: { response: credential.response, createSession: false } }).then(() => false, () => true))
      check(await snapshot() === beforeMissingCookie)
      assertions.push('same-user-ordinary-cached-session-cannot-replace-missing-restricted-cookie')
      const registerOptions = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.NonEmptyString,
        rp: Schema.Struct({ id: Schema.NonEmptyString }), user: Schema.Struct({ id: Schema.NonEmptyString }) }))(issued.body.options)
      const fresh = registrationCredentialFixture(registerOptions, origin)
      const beforeWrongCookie = await snapshot()
      check(await qualifier().invoke(request((await cookieHeader()).replace(`${winnerCookie.name}=${winnerCookie.value}`,
        `${winnerCookie.name}=${winnerCookie.value}tampered`)), 'q2-register', native, selector,
      { input: { response: fresh.response, createSession: false } }).then(() => false, () => true))
      check(await snapshot() === beforeWrongCookie)
      check(stores)
      const registeredChallengeId = (await stores.administrator.query('SELECT q2 FROM qualification_recovery_witness WHERE user_id=$1',
        [userId])).rows[0].q2.registrationId
      const challengeRow = (await stores.administrator.query('SELECT value,expires_at FROM verification WHERE identifier=$1',
        [registeredChallengeId])).rows[0]
      const swapped = { ...JSON.parse(challengeRow.value), context: 'q2-registration:foreign' }
      await stores.administrator.query('UPDATE verification SET value=$2 WHERE identifier=$1',
        [registeredChallengeId, JSON.stringify(swapped)])
      const swappedSnapshot = await snapshot(), swappedEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: fresh.response, createSession: false } })).status === 503)
      check(await snapshot() === swappedSnapshot)
      const swappedEvents = qualifier().evidence().events.slice(swappedEventOffset)
      check(swappedEvents.includes('q2-register-raw-cookie-names:none')
        && swappedEvents.includes('q2-register-native-failed-response-owner-abort')
        && !swappedEvents.includes('q2-register-raw-cookie-invariant-violation')
        && !swappedEvents.includes('physical-owner-committed'))
      await stores.administrator.query('UPDATE verification SET value=$2 WHERE identifier=$1', [registeredChallengeId, challengeRow.value])
      await stores.administrator.query("UPDATE verification SET expires_at=clock_timestamp()-interval '1 second' WHERE identifier=$1",
        [registeredChallengeId])
      const expiredRegistration = await snapshot(), expiredRegistrationEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: fresh.response, createSession: false } })).status === 503)
      check(await snapshot() === expiredRegistration)
      const expiredRegistrationEvents = qualifier().evidence().events.slice(expiredRegistrationEventOffset)
      check(expiredRegistrationEvents.includes('q2-register-raw-cookie-names:none')
        && expiredRegistrationEvents.includes('q2-register-native-failed-response-owner-abort')
        && !expiredRegistrationEvents.includes('q2-register-raw-cookie-invariant-violation')
        && !expiredRegistrationEvents.includes('physical-owner-committed'))
      await stores.administrator.query('UPDATE verification SET expires_at=$2 WHERE identifier=$1',
        [registeredChallengeId, challengeRow.expires_at])
      const shortRegistrationExpiry = new Date(Date.now() + 4000)
      await stores.administrator.query('UPDATE verification SET expires_at=$2 WHERE identifier=$1',
        [registeredChallengeId, shortRegistrationExpiry])
      const afterVerifyExpirySnapshot = await snapshot(), registrationExpiryEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: fresh.response, createSession: false, fault: 'expire-after-verify' } })).status === 503)
      check(await snapshot() === afterVerifyExpirySnapshot)
      const registrationExpiryEvents = qualifier().evidence().events.slice(registrationExpiryEventOffset)
      check(registrationExpiryEvents.includes('q2-native-registration-verification-consumed')
        && registrationExpiryEvents.includes('q2-registration-real-verification-before-await-expiry')
        && registrationExpiryEvents.includes('q2-registration-post-await-live-expiry-refused')
        && registrationExpiryEvents.includes('q2-register-raw-cookie-names:none')
        && registrationExpiryEvents.includes('q2-register-native-failed-response-owner-abort')
        && !registrationExpiryEvents.includes('q2-register-raw-cookie-invariant-violation')
        && !registrationExpiryEvents.includes('q2-registration-after-observed-consume-and-row')
        && !registrationExpiryEvents.includes('physical-owner-committed'))
      await stores.administrator.query('UPDATE verification SET expires_at=$2 WHERE identifier=$1',
        [registeredChallengeId, challengeRow.expires_at])
      assertions.push('real-native-registration-verification-then-live-challenge-expiry-aborts-owner-with-valid-restricted-session')
      await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [userId])
      const staleGeneration = await snapshot()
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: fresh.response, createSession: false } })).status === 503)
      check(await snapshot() === staleGeneration)
      await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation-1 WHERE id=$1', [userId])
      assertions.push('restricted-cookie-tamper-swapped-context-and-expired-native-registration-challenge-refused')
      assertions.push('stale-user-generation-refused-before-native-registration-effects')
      for (const invalid of [
        registrationCredentialFixture({ ...registerOptions, challenge: randomUUID() }, origin).response,
        registrationCredentialFixture(registerOptions, 'https://wrong.example.test').response,
      ]) {
        const before = await snapshot(), invalidEventOffset = qualifier().evidence().events.length
        check((await browserCall(page, { action: 'q2-register', selector,
          input: { response: invalid, createSession: false } })).status === 503)
        check(await snapshot() === before)
        const invalidEvents = qualifier().evidence().events.slice(invalidEventOffset)
        check(invalidEvents.includes('q2-register-raw-cookie-names:none')
          && invalidEvents.includes('q2-register-native-failed-response-owner-abort')
          && !invalidEvents.includes('q2-register-raw-cookie-invariant-violation')
          && !invalidEvents.includes('physical-owner-committed'))
      }
      assertions.push('native-registration-wrong-challenge-and-origin-consume-rollback')
      const beforeFault = await snapshot(), eventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: fresh.response, createSession: false, fault: 'registration-after' } })).status === 503)
      check(await snapshot() === beforeFault)
      const registrationFaultEvents = qualifier().evidence().events.slice(eventOffset)
      check(registrationFaultEvents.includes('q2-registration-after-observed-consume-and-row')
        && registrationFaultEvents.includes('fault:q2-registration-after')
        && !registrationFaultEvents.includes('physical-owner-committed'))
      const beforeForcedSession = await snapshot()
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: fresh.response, createSession: true } })).status === 503)
      check(await snapshot() === beforeForcedSession)
      const withoutUv = registrationCredentialFixture(registerOptions, origin, false)
      const beforeUv = await snapshot(), uvEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-register', selector,
        input: { response: withoutUv.response, createSession: false } })).status === 503)
      check(await snapshot() === beforeUv)
      const uvEvents = qualifier().evidence().events.slice(uvEventOffset)
      check(uvEvents.includes('q2-native-registration-verification-consumed')
        && uvEvents.includes('q2-registration-uv-rejected-after-native-verify')
        && uvEvents.includes('q2-register-raw-cookie-names:none')
        && uvEvents.includes('q2-register-native-failed-response-owner-abort')
        && !uvEvents.includes('q2-register-raw-cookie-invariant-violation')
        && !uvEvents.includes('q2-registration-after-observed-consume-and-row')
        && !uvEvents.includes('physical-owner-committed'))
      const ordinaryGate = gate(); gates.set('/ordinary', ordinaryGate)
      const heldOrdinary = track(second.evaluate(async () => (await fetch('/ordinary', { method: 'POST' })).status))
      await bounded(ordinaryGate.arrived, 15000)
      check(delayedOrdinary)
      const ordinaryName = '__Secure-better-auth.better-auth-passkey'
      const heldOrdinaryHeader = delayedOrdinary.getSetCookie().find(value => value.startsWith(ordinaryName + '='))
      check(heldOrdinaryHeader)
      const heldOrdinaryPair = heldOrdinaryHeader.split(';')[0]
      const heldOrdinaryValue = heldOrdinaryPair.slice(ordinaryName.length + 1)
      check(heldOrdinaryValue.length > 0)
      canaries.add(heldOrdinaryValue)
      const ordinaryBeforeRelease = (await context.cookies()).find(cookie => cookie.name === ordinaryName)
      check(ordinaryBeforeRelease?.value !== heldOrdinaryValue)
      const challengeBeforeOrdinary = (await context.cookies()).find(cookie => cookie.name === expectedCookieNames(selector).prefix + 'better-auth-passkey')
      check(challengeBeforeOrdinary)
      ordinaryGate.release(); check(await heldOrdinary === 200)
      const installed = await context.cookies()
      check(installed.find(cookie => cookie.name === ordinaryName)?.value === heldOrdinaryValue)
      check(installed.find(cookie => cookie.name === challengeBeforeOrdinary.name)?.value === challengeBeforeOrdinary.value)
      check(await app.readPrincipal(request(await cookieHeader())) === null)
      assertions.push('ordinary-challenge-installed-without-replacing-winning-native-challenge-or-private-authority')
      const registered = await browserCall(page, { action: 'q2-register', selector, input: { response: fresh.response, createSession: false } })
      check(registered.status === 200 && registered.body.keyId)
      const keyId = registered.body.keyId, afterRegister = await snapshot()
      check((await browserCall(page, { action: 'q2-register', selector, input: { response: fresh.response, createSession: false } })).status === 503)
      check(await snapshot() === afterRegister)
      assertions.push('native-registration-uv-callback-and-after-hook-rollbacks-then-once-only-new-key')
      const assertion = await browserCall(page, { action: 'q2-assert-options', selector })
      check(assertion.status === 200 && assertion.body.challengeId)
      const assertionOptions = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.NonEmptyString, rpId: Schema.NonEmptyString }))(assertion.body.options)
      const signed = fresh.authenticationResponse(assertionOptions, { counter: 1 })
      const invalidAssertions = [
        credential.authenticationResponse(assertionOptions, { counter: 3 }),
        fresh.authenticationResponse(assertionOptions, { counter: 1, uv: false }),
        fresh.authenticationResponse(assertionOptions, { counter: 1, challenge: randomUUID() }),
        fresh.authenticationResponse(assertionOptions, { counter: 1, origin: 'https://wrong.example.test' }),
        fresh.authenticationResponse(assertionOptions, { counter: 1, rpId: 'wrong.example.test' }),
      ]
      for (const response of invalidAssertions) {
        const before = await snapshot()
        check((await browserCall(page, { action: 'q2-assert', selector,
          input: { challengeId: assertion.body.challengeId, response } })).status === 503)
        check(await snapshot() === before)
      }
      assertions.push('same-user-old-key-and-uv-challenge-origin-rpid-negative-signed-assertions-refused')
      check(stores)
      const assertionInput = { challengeId: assertion.body.challengeId, response: signed }
      const beforeAssertionAuthority = await snapshot(), assertionAuthorityEventOffset = qualifier().evidence().events.length
      check(await qualifier().invoke(request(ordinaryCookiesOnly), 'q2-assert', native, selector,
        { input: assertionInput }).then(() => false, () => true))
      check(await qualifier().invoke(request((await cookieHeader()).replace(`${winnerCookie.name}=${winnerCookie.value}`,
        `${winnerCookie.name}=${winnerCookie.value}tampered`)), 'q2-assert', native, selector,
      { input: assertionInput }).then(() => false, () => true))
      check((await browserCall(page, { action: 'q2-assert', selector,
        input: { challengeId: randomUUID(), response: signed } })).status === 503)
      check(await snapshot() === beforeAssertionAuthority)
      const assertionAuthorityEvents = qualifier().evidence().events.slice(assertionAuthorityEventOffset)
      check(!assertionAuthorityEvents.includes('q2-assert-native-verification-consumed')
        && !assertionAuthorityEvents.includes('physical-owner-committed'))
      await stores.administrator.query('UPDATE qualification_recovery_witness SET winner=$2 WHERE user_id=$1', [userId, p2.body.selector])
      const losingWinnerSnapshot = await snapshot(), losingWinnerEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-assert', selector, input: assertionInput })).status === 503)
      check(await snapshot() === losingWinnerSnapshot)
      check(!qualifier().evidence().events.slice(losingWinnerEventOffset).includes('q2-assert-native-verification-consumed'))
      await stores.administrator.query('UPDATE qualification_recovery_witness SET winner=$2 WHERE user_id=$1', [userId, selector])
      await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [userId])
      const staleAssertionGeneration = await snapshot(), staleAssertionEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-assert', selector, input: assertionInput })).status === 503)
      check(await snapshot() === staleAssertionGeneration)
      check(!qualifier().evidence().events.slice(staleAssertionEventOffset).includes('q2-assert-native-verification-consumed'))
      await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation-1 WHERE id=$1', [userId])
      const oldKeyId = (await stores.administrator.query('SELECT id FROM passkey WHERE user_id=$1 AND credential_id=$2',
        [userId, credential.response.id])).rows[0]?.id
      check(oldKeyId)
      const assertionRow = (await stores.administrator.query('SELECT value FROM verification WHERE identifier=$1',
        [assertion.body.challengeId])).rows[0]
      check(assertionRow)
      const storedAssertion = JSON.parse(assertionRow.value)
      const bindingChanges = [
        ['purpose', 'foreign-purpose'], ['selector', p2.body.selector], ['sessionId', randomUUID()],
        ['generation', storedAssertion.generation + 1], ['keyId', oldKeyId],
      ] as const
      for (const [field, value] of bindingChanges) {
        await stores.administrator.query('UPDATE verification SET value=$2 WHERE identifier=$1',
          [assertion.body.challengeId, JSON.stringify({ ...storedAssertion, [field]: value })])
        const mismatched = await snapshot(), bindingEventOffset = qualifier().evidence().events.length
        check((await browserCall(page, { action: 'q2-assert', selector, input: assertionInput })).status === 503)
        check(await snapshot() === mismatched)
        const bindingEvents = qualifier().evidence().events.slice(bindingEventOffset)
        check(!bindingEvents.includes('q2-assert-native-verification-consumed')
          && !bindingEvents.includes('physical-owner-committed'))
        await stores.administrator.query('UPDATE verification SET value=$2 WHERE identifier=$1',
          [assertion.body.challengeId, assertionRow.value])
      }
      check(await snapshot() === beforeAssertionAuthority)
      assertions.push('assertion-cookie-winner-generation-handle-purpose-selector-session-and-key-binding-refusals')
      const originalExpiry = (await stores.administrator.query('SELECT expires_at FROM verification WHERE identifier=$1',
        [assertion.body.challengeId])).rows[0].expires_at
      await stores.administrator.query("UPDATE verification SET expires_at=clock_timestamp()-interval '1 second' WHERE identifier=$1",
        [assertion.body.challengeId])
      const expiredSnapshot = await snapshot()
      check((await browserCall(page, { action: 'q2-assert', selector,
        input: { challengeId: assertion.body.challengeId, response: signed } })).status === 503)
      check(await snapshot() === expiredSnapshot)
      await stores.administrator.query('UPDATE verification SET expires_at=$2 WHERE identifier=$1',
        [assertion.body.challengeId, originalExpiry])
      const awaitExpiry = new Date(Date.now() + 1500)
      await stores.administrator.query('UPDATE verification SET expires_at=$2 WHERE identifier=$1',
        [assertion.body.challengeId, awaitExpiry])
      const tailSnapshot = await snapshot(), tailEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-assert', selector,
        input: { challengeId: assertion.body.challengeId, response: signed, fault: 'expire-after-verify' } })).status === 503)
      check(await snapshot() === tailSnapshot)
      const tailEvents = qualifier().evidence().events.slice(tailEventOffset)
      check(tailEvents.includes('q2-assert-real-verification-before-await-expiry')
        && tailEvents.includes('q2-assert-post-await-live-expiry-refused')
        && !tailEvents.includes('q2-assert-native-verification-consumed')
        && !tailEvents.includes('physical-owner-committed'))
      await stores.administrator.query('UPDATE verification SET expires_at=$2 WHERE identifier=$1',
        [assertion.body.challengeId, originalExpiry])
      assertions.push('live-database-expiry-refused-on-entry-and-after-awaited-signed-verification')
      const beforeAssertionFault = await snapshot(), assertionEventOffset = qualifier().evidence().events.length
      check((await browserCall(page, { action: 'q2-assert', selector, input: { challengeId: assertion.body.challengeId,
        response: signed, fault: 'assert-after-writes' } })).status === 503)
      check(await snapshot() === beforeAssertionFault)
      const assertionFaultEvents = qualifier().evidence().events.slice(assertionEventOffset)
      check(assertionFaultEvents.includes('q2-assert-consumed-counter-tested-in-owner')
        && assertionFaultEvents.includes('fault:q2-assert-after-writes')
        && !assertionFaultEvents.includes('physical-owner-committed'))
      const tested = await browserCall(page, { action: 'q2-assert', selector,
        input: { challengeId: assertion.body.challengeId, response: signed } })
      check(tested.status === 200 && tested.body.tested === true && tested.body.keyId === keyId)
      const durable = await stores.administrator.query(`SELECT u.recovering,u.recovery_generation,s.id session_id,s.auth_state,
        (SELECT count(*)::int FROM session WHERE user_id=$1) session_count,
        (SELECT count(*)::int FROM passkey WHERE user_id=$1) key_count,
        (SELECT count(*)::int FROM account WHERE user_id=$1) account_count,
        (SELECT counter FROM passkey WHERE user_id=$1 AND credential_id=$2) old_counter,
        (SELECT counter FROM passkey WHERE id=$3) new_counter
        FROM "user" u JOIN session s ON s.user_id=u.id WHERE u.id=$1`,
      [userId, credential.response.id, keyId])
      const winning = (await stores.administrator.query('SELECT attempts FROM qualification_recovery_witness WHERE user_id=$1',
        [userId])).rows[0].attempts.find((value: { selector: string }) => value.selector === selector)
      check(durable.rows.length === 1 && durable.rows[0].recovering === true && durable.rows[0].session_count === 1
        && durable.rows[0].session_id === winning?.sessionId
        && durable.rows[0].auth_state === 'RECOVERY_RESTRICTED' && durable.rows[0].key_count === 2
        && durable.rows[0].account_count === 0 && durable.rows[0].old_counter === oldKeyBaselineCounter
        && durable.rows[0].new_counter === 1)
      const afterTest = await snapshot()
      check((await browserCall(page, { action: 'q2-assert', selector,
        input: { challengeId: assertion.body.challengeId, response: signed } })).status === 503)
      check(await snapshot() === afterTest)
      check(await app.readPrincipal(request(await cookieHeader())) === null)
      assertions.push('exact-new-key-increasing-counter-consume-tested-rollback-then-success-once-and-replay-refused')
      const nested = qualifier().evidence().nestedAdmissions
      check(nested.options === 1 && nested.registration === 8)
      assertions.push('one-actual-nested-options-admission-and-eight-actual-nested-registration-admissions')
      if (variant === 'q3') {
        stage = 'q3-non-vacuous-setup'
        const abandonedId = randomUUID(), abandonedCredentialId = randomBytes(32).toString('base64url')
        await stores.administrator.query(`INSERT INTO passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up,transports,created_at,aaguid)
          SELECT $2,'qualification-abandoned-representative',public_key,user_id,$3,0,device_type,backed_up,transports,clock_timestamp(),aaguid
          FROM passkey WHERE id=$4 AND user_id=$1`, [userId, abandonedId, abandonedCredentialId, oldKeyId])
        await stores.administrator.query(`INSERT INTO account(id,account_id,provider_id,user_id,scope)
          VALUES($2,$3,'google',$1,'openid email profile')`, [userId, randomUUID(), `qualification-google-${randomUUID()}`])
        await qualifier().invoke(request(), 'seed-expired', native)
        const beforeRows = async (table: 'passkey' | 'account' | 'session' | 'user' | 'qualification_recovery_witness') =>
          (await stores!.administrator.query(`SELECT to_jsonb(t) AS row FROM ${table === 'user' ? '"user"' : table} t WHERE ${table === 'qualification_recovery_witness' ? 'user_id' : table === 'user' ? 'id' : 'user_id'}=$1 ORDER BY to_jsonb(t)::text`, [userId])).rows.map(value => value.row)
        const retainedBefore = (await beforeRows('passkey')).find(row => row.id === keyId)
        const accountBefore = await beforeRows('account')
        const keysBefore = await beforeRows('passkey'), sessionsBefore = await beforeRows('session')
        check(retainedBefore && keysBefore.length === 3 && keysBefore.filter(row => row.id !== keyId).length >= 2
          && accountBefore.length === 1 && accountBefore[0].provider_id === 'google'
          && accountBefore[0].access_token === null && accountBefore[0].refresh_token === null && accountBefore[0].id_token === null
          && sessionsBefore.length >= 2 && sessionsBefore.some(row => row.id === winning.sessionId)
          && sessionsBefore.some(row => Date.parse(row.expires_at) < Date.now()))
        const q3Baseline = await snapshot()
        const priorRecoveryCookie = `${winnerCookie.name}=${winnerCookie.value}`
        const finish = (input?: { fault?: 'key-delete-noop' | 'finish-after' }) =>
          browserCall(page, { action: 'q3-finish', selector, input })
        const refuseWithoutEffects = async (call: () => Promise<unknown>) => {
          const before = await snapshot(), observed = qualifier().evidence()
          const offset = observed.events.length, deletionAdmissions = observed.nestedAdmissions.deletion
          await call()
          const after = qualifier().evidence(), events = after.events.slice(offset)
          check(await snapshot() === before && after.nestedAdmissions.deletion === deletionAdmissions
            && !events.includes('q3-ordinary-session-create-entry') && !events.includes('physical-owner-committed'))
        }
        await refuseWithoutEffects(async () => check(await qualifier().invoke(request(ordinaryCookiesOnly), 'q3-finish', native, selector)
          .then(() => false, () => true)))
        await refuseWithoutEffects(async () => check(await qualifier().invoke(request((await cookieHeader()).replace(priorRecoveryCookie,
          `${winnerCookie.name}=${winnerCookie.value}tampered`)), 'q3-finish', native, selector).then(() => false, () => true)))
        await refuseWithoutEffects(async () => check((await browserCall(second, { action: 'q3-finish', selector: p2.body.selector })).status === 503))
        await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [userId])
        const staleBefore = await snapshot()
        await refuseWithoutEffects(async () => check((await finish()).status === 503))
        check(await snapshot() === staleBefore)
        await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation-1 WHERE id=$1', [userId])
        await stores.administrator.query("UPDATE qualification_recovery_witness SET q2=jsonb_set(q2,'{tested}','false') WHERE user_id=$1", [userId])
        const untestedBefore = await snapshot()
        await refuseWithoutEffects(async () => check((await finish()).status === 503))
        check(await snapshot() === untestedBefore)
        await stores.administrator.query("UPDATE qualification_recovery_witness SET q2=jsonb_set(q2,'{tested}','true') WHERE user_id=$1", [userId])
        check(await snapshot() === q3Baseline)
        assertions.push('q3-missing-tampered-loser-stale-generation-untested-refuse-against-perturbed-baselines')

        const noOpOffset = qualifier().evidence().events.length
        check((await finish({ fault: 'key-delete-noop' })).status === 503)
        const noOpEvents = qualifier().evidence().events.slice(noOpOffset)
        check(noOpEvents.includes('q3-native-key-delete-effect-omitted')
          && noOpEvents.includes('q3-native-delete-status-true')
          && noOpEvents.filter(event => event === 'q3-key-inventory-refused').length === 1
          && !noOpEvents.includes('q3-ordinary-session-create-entry')
          && !noOpEvents.includes('physical-owner-committed') && await snapshot() === q3Baseline)
        assertions.push('q3-success-status-with-omitted-adapter-effect-refused-by-shared-key-inventory')

        const vetoOffset = qualifier().evidence().events.length
        qualifier().setFault('delete-veto')
        try { check((await finish()).status === 503) } finally { qualifier().setFault('none') }
        const vetoEvents = qualifier().evidence().events.slice(vetoOffset)
        const retirement = vetoEvents.indexOf('q3-native-key-retirement-complete')
        const hook = vetoEvents.indexOf('q3-native-session-delete-before-veto-reached')
        const barrier = vetoEvents.indexOf('q3-session-inventory-refused')
        check(retirement >= 0 && hook > retirement && barrier > hook
          && !vetoEvents.includes('q3-ordinary-session-create-entry')
          && !vetoEvents.includes('physical-owner-committed') && await snapshot() === q3Baseline)
        assertions.push('q3-native-session-veto-reached-then-shared-empty-session-barrier-before-transition')

        const afterOffset = qualifier().evidence().events.length
        check((await finish({ fault: 'finish-after' })).status === 503)
        const afterEvents = qualifier().evidence().events.slice(afterOffset)
        check(afterEvents.includes('q3-finish-after-all-effects-verified')
          && afterEvents.includes('q3-finish-after-hold-from-fresh-db-time')
          && afterEvents.includes('q3-ordinary-cookie-staged')
          && afterEvents.includes('fault:q3-finish-after-all-effects')
          && !afterEvents.includes('physical-owner-committed') && await snapshot() === q3Baseline)
        assertions.push('q3-reached-endpoint-after-all-effects-rollback-restores-empty-hold-and-full-inventory')

        await stores.administrator.query("UPDATE \"user\" SET hold_until=clock_timestamp()+interval '30 hours' WHERE id=$1", [userId])
        const laterHold = (await beforeRows('user'))[0].hold_until
        const ordinaryBeforeFinish = (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
        const successBaseline = await snapshot(), successOffset = qualifier().evidence().events.length
        const success = await finish()
        check(success.status === 200 && success.body.ok === true && success.body.phase === 'finished' && success.body.keyId === keyId)
        const successEvents = qualifier().evidence().events.slice(successOffset)
        check(successEvents.includes('q3-native-key-retirement-complete')
          && successEvents.includes('q3-empty-session-barrier-passed')
          && successEvents.includes('q3-ordinary-session-create-entry')
          && successEvents.includes('q3-ordinary-cookie-staged')
          && successEvents.at(-1) === 'physical-owner-committed')
        const keysAfter = await beforeRows('passkey'), accountAfter = await beforeRows('account')
        const sessionsAfter = await beforeRows('session'), userAfter = (await beforeRows('user'))[0]
        const witnessAfter = (await beforeRows('qualification_recovery_witness'))[0]
        check(JSON.stringify(keysAfter) === JSON.stringify([retainedBefore])
          && JSON.stringify(accountAfter) === JSON.stringify(accountBefore)
          && sessionsAfter.length === 1 && sessionsAfter[0].id !== winning.sessionId
          && sessionsBefore.every(row => row.id !== sessionsAfter[0].id && row.token !== sessionsAfter[0].token)
          && sessionsAfter[0].auth_state === 'ACTIVE' && sessionsAfter[0].auth_method === 'recovery'
          && sessionsAfter[0].recovery_generation === durable.rows[0].recovery_generation
          && userAfter.recovering === false && userAfter.recovery_generation === durable.rows[0].recovery_generation
          && userAfter.hold_until === laterHold && witnessAfter.finished === true)
        check(await snapshot() !== successBaseline)
        const ordinaryTokenCookie = (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
        check(ordinaryTokenCookie && ordinaryTokenCookie.value !== ordinaryBeforeFinish?.value)
        const beforeRead = await snapshot(), sessionBeforeRead = sessionsAfter[0]
        const verificationBeforeRead = (await stores.administrator.query('SELECT to_jsonb(v) AS row FROM verification v ORDER BY to_jsonb(v)::text')).rows
        const privatePrincipal = await app.readPrincipal(request(await cookieHeader()))
        check(privatePrincipal?.userId === userId && privatePrincipal.sessionId === sessionBeforeRead.id)
        const sessionsAfterRead = await beforeRows('session')
        check(sessionsAfterRead.length === 1 && sessionsAfterRead[0].id === sessionBeforeRead.id)
        const sessionAfterRead = sessionsAfterRead[0]
        const { last_activity_at: oldActivity, updated_at: oldUpdated, ...otherBefore } = sessionBeforeRead
        const { last_activity_at: newActivity, updated_at: newUpdated, ...otherAfter } = sessionAfterRead
        check(JSON.stringify(otherAfter) === JSON.stringify(otherBefore)
          && Date.parse(newActivity) >= Date.parse(oldActivity) && Date.parse(newUpdated) >= Date.parse(oldUpdated)
          && JSON.stringify(await beforeRows('passkey')) === JSON.stringify(keysAfter)
          && JSON.stringify(await beforeRows('account')) === JSON.stringify(accountAfter)
          && JSON.stringify(await beforeRows('user')) === JSON.stringify([userAfter])
          && JSON.stringify(await beforeRows('qualification_recovery_witness')) === JSON.stringify([witnessAfter])
          && JSON.stringify((await stores.administrator.query('SELECT to_jsonb(v) AS row FROM verification v ORDER BY to_jsonb(v)::text')).rows)
            === JSON.stringify(verificationBeforeRead))
        check(await snapshot() !== beforeRead)
        const replayBaseline = await snapshot(), replayObserved = qualifier().evidence()
        const replayOffset = replayObserved.events.length, replayDeletionAdmissions = replayObserved.nestedAdmissions.deletion
        check(await qualifier().invoke(request(priorRecoveryCookie), 'q3-finish', native, selector).then(() => false, () => true))
        check((await finish()).status === 503)
        const replayAfter = qualifier().evidence(), replayEvents = replayAfter.events.slice(replayOffset)
        check(await snapshot() === replayBaseline && replayAfter.nestedAdmissions.deletion === replayDeletionAdmissions
          && !replayEvents.includes('q3-ordinary-session-create-entry')
          && !replayEvents.includes('q3-ordinary-cookie-staged') && !replayEvents.includes('physical-owner-committed'))
        assertions.push('q3-once-only-native-retirement-monotone-hold-ordinary-cookie-read-and-committed-replay-refusal')
      }
    } else {
    stage = 'preparations'
    const p1 = await browserCall(page, { action: 'prepare' }); check(p1.status === 200 && p1.body.selector)
    const selector = p1.body.selector
    const initialCookies = await context.cookies(), winningNames = expectedCookieNames(selector)
    const tokenBefore = initialCookies.find(cookie => cookie.name === winningNames.token)
    const auxiliaryBefore = initialCookies.find(cookie => cookie.name === winningNames.auxiliary)
    check(tokenBefore); canaries.add(tokenBefore.value)
    check(auxiliaryBefore && auxiliaryBefore.value === 'qualification-only')
    async function inspectWinningAuxiliary(losingSelector?: string) {
      check(context)
      const cookies = await context.cookies()
      const winningAuxiliary = cookies.find(cookie => cookie.name === winningNames.auxiliary)
      check(winningAuxiliary && JSON.stringify(winningAuxiliary) === JSON.stringify(auxiliaryBefore))
      if (losingSelector) {
        const losingNames = expectedCookieNames(losingSelector)
        check(!cookies.some(cookie => cookie.name.startsWith(losingNames.prefix)))
      }
    }
    const ordinaryConfigurationCheck = app.readPrincipal(request(await cookieHeader()))
    const latePreparation = gate(); gates.set('p2', latePreparation)
    const pendingP2 = track(browserCall(second, { action: 'prepare', gate: 'p2' }))
    await bounded(latePreparation.arrived, 15000); await ordinaryConfigurationCheck
    const ordinaryGate = gate(), ordinaryFinishGate = gate(); gates.set('/ordinary', ordinaryGate); gates.set('/ordinary-finish', ordinaryFinishGate)
    const pendingOrdinary = track(second.evaluate(async () => (await fetch('/ordinary', { method: 'POST' })).status))
    const pendingOrdinaryFinish = track(second.evaluate(async () => (await fetch('/ordinary-finish', { method: 'POST' })).status))
    await Promise.all([bounded(ordinaryGate.arrived, 15000), bounded(ordinaryFinishGate.arrived, 15000)])
    const attemptRows = await stores.administrator.query('SELECT attempts FROM qualification_recovery_witness WHERE user_id=$1', [userId])
    const attempts = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ selector: Schema.String, expiresAt: Schema.Number })))(attemptRows.rows[0].attempts)
    const selector2 = attempts[1].selector
    check(Math.abs(tokenBefore.expires - Math.floor(attempts[0].expiresAt / 1000)) <= 1)
    const preparationDeadlines = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ preparedUntil: Schema.Number })))(attemptRows.rows[0].attempts)
    check(Math.abs(auxiliaryBefore.expires - Math.floor(preparationDeadlines[0].preparedUntil / 1000)) <= 1)
    const prior = await snapshot()
    const third = await browserCall(page, { action: 'prepare' }); check(third.status === 503 && await snapshot() === prior)
    assertions.push('max-two-namespaces-refuses-third-before-code-or-cookie-mutation')
    check((await browserCall(page, { action: 'status', selector: randomUUID() })).status === 503)
    check((await browserCall(page, { action: 'status', selector: selector2, seedAmbient: true })).status === 503)
    check((await browserCall(page, { action: 'status', selector, seedAmbient: true })).status === 200)
    check(await qualifier().invoke(request(), 'status', native, selector, { seedAmbient: true }).then(() => false, () => true))
    const tampered = (await cookieHeader()).replace(`${tokenBefore.name}=${tokenBefore.value}`, `${tokenBefore.name}=${tokenBefore.value}tampered`)
    check(await qualifier().invoke(request(tampered), 'status', native, selector).then(() => false, () => true))
    assertions.push('native-authoritative-read-ignores-ambient-ordinary-session-and-selector-alone')
    // Expire only modeled preparation state, never a native session row.
    await stores.administrator.query(`UPDATE qualification_recovery_witness SET attempts=jsonb_set(attempts,'{0,preparedUntil}','0') WHERE user_id=$1`, [userId])
    check((await browserCall(page, { action: 'activate', selector })).status === 503)
    await stores.administrator.query('UPDATE qualification_recovery_witness SET attempts=$2 WHERE user_id=$1', [userId, JSON.stringify(attemptRows.rows[0].attempts)])
    assertions.push('expired-preparation-refused-without-consuming-modeled-code')
    await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [userId])
    check((await browserCall(page, { action: 'status', selector })).status === 503)
    await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation-1 WHERE id=$1', [userId])
    assertions.push('native-status-refuses-stale-session-generation')
    await qualifier().invoke(request(), 'seed-expired', native)
    stage = 'faults-before-activation'
    if (mode === 'isolated' && !finishDelivery) {
      for (const fault of ['update-veto', 'update-token', 'update-lifetime', 'delete-veto', 'update-after', 'delete-after', 'before-commit'] as const satisfies readonly QualificationFault[]) {
        const before = await snapshot(), eventOffset = qualifier().evidence().events.length; qualifier().setFault(fault)
        try { check((await browserCall(page, { action: 'activate', selector })).status === 503) }
        finally { qualifier().setFault('none') }
        const invocationEvents = qualifier().evidence().events.slice(eventOffset), snapshotUnchanged = await snapshot() === before
        if (fault === 'update-after' || fault === 'delete-after') {
          hookFaultEvidence.push({ fault, events: invocationEvents, snapshotUnchanged })
          check(invocationEvents.includes(fault) && invocationEvents.filter(event => event === `fault:${fault}`).length === 1
            && !invocationEvents.includes('physical-owner-committed'))
        }
        check(snapshotUnchanged)
        assertions.push(`${fault}-actual-owner-rollback-user-session-witness-unchanged-no-success-headers`)
      }
      const expiredInvocation = await snapshot()
      check(await qualifier().invoke(request(await cookieHeader()), 'activate', native, selector, { deadlineAtMs: Date.now() - 1 }).then(() => false, () => true))
      check(await snapshot() === expiredInvocation)
      const locker = stores.administrator
      try {
        await locker.query('BEGIN'); await locker.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId])
        check(await qualifier().invoke(request(await cookieHeader()), 'activate', native, selector, { deadlineAtMs: Date.now() + 250 }).then(() => false, () => true))
      } finally { await locker.query('ROLLBACK') }
      check(await snapshot() === expiredInvocation)
      assertions.push('expired-invocation-and-user-lock-deadline-refused-without-mutation')
    }
    stage = 'activate-and-deliver-loser'
    const activation = await browserCall(page, { action: 'activate', selector, afterCommitFailure: mode === 'isolated' })
    check(activation.status === (mode === 'isolated' ? 503 : 200))
    check((await browserCall(page, { action: 'status' })).body.selector === selector)
    check((await browserCall(page, { action: 'status', selector, seedAmbient: true })).status === 200)
    const committed = await snapshot()
    check((await browserCall(page, { action: 'activate', selector })).status === 200 && await snapshot() === committed)
    const state = await stores.administrator.query('SELECT remaining_code,winner FROM qualification_recovery_witness WHERE user_id=$1', [userId])
    check(state.rows[0].remaining_code === 0 && state.rows[0].winner === selector)
    check((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE user_id=$1', [userId])).rows[0].n === 1)
    check(await app.readPrincipal(request(await cookieHeader())) === null)
    if (finishDelivery) {
      check((await browserCall(page, { action: 'finish-modeled', selector })).status === 200)
      check(await app.readPrincipal(request(await cookieHeader())) !== null)
      latePreparation.release(); check((await pendingP2).status === 200)
      await inspectWinningAuxiliary()
      check(await app.readPrincipal(request(await cookieHeader())) !== null)
      check((await browserCall(page, { action: 'status', selector: selector2 })).status === 503)
      check((await browserCall(page, { action: 'status' })).status === 503)
      assertions.push('losing-preparation-headers-arrive-across-modeled-finish-without-destroying-ordinary-cookie-or-restoring-recovery')
      ordinaryGate.release(); ordinaryFinishGate.release(); await Promise.all([pendingOrdinary, pendingOrdinaryFinish])
      check(await app.readPrincipal(request(await cookieHeader())) === null)
      check((await browserCall(page, { action: 'status' })).status === 503)
    } else {
    if (variant === 'isolated') {
      check(retainedP2Date); owner.assertNoActiveAuthTransaction()
      // Establish measurable header age only. The explicit gate, not this clock
      // condition, still determines P2's delivery after activation.
      const waitDeadline = performance.now() + 5000
      while (Date.now() - Date.parse(retainedP2Date) < 3000) {
        check(performance.now() < waitDeadline)
        await new Promise<void>(done => setTimeout(done, 25))
      }
      check(performance.now() <= waitDeadline)
    }
    latePreparation.release(); const deliveredP2 = await pendingP2; check(deliveredP2.status === 200)
    if (variant === 'isolated') {
      check(retainedP2Date && retainedP2SentAtMs !== undefined && deliveredP2.responseDate === retainedP2Date)
      const cookies = await context.cookies(), names = expectedCookieNames(selector2)
      for (const [cookie, name, deadline] of [
        ['token', names.token, attempts[1].expiresAt],
        ['auxiliary', names.auxiliary, preparationDeadlines[1].preparedUntil],
      ] as const) {
        const observed = cookies.find(value => value.name === name); check(observed)
        const browserExpiresMs = observed.expires * 1000, declaredExpiresMs = Math.floor(deadline / 1000) * 1000
        const counterexample = browserExpiresMs > deadline
        retainedDateExpiryEvidence.push({ cookie, transmittedDate: deliveredP2.responseDate, sentAtMs: retainedP2SentAtMs,
          receivedAtMs: deliveredP2.receivedAtMs, dateAgeAtSendMs: retainedP2SentAtMs - Date.parse(retainedP2Date),
          persistedDeadlineMs: deadline, declaredExpiresMs, browserExpiresMs, beyondPersistedDeadlineMs: browserExpiresMs - deadline,
          declaredExpiryAdjustmentMs: browserExpiresMs - declaredExpiresMs, counterexample })
        // Expected counterexample on the exercised Chromium: physical cookie
        // retention exceeds the DB deadline. No positive tolerance hides it.
        check(counterexample && retainedP2SentAtMs - Date.parse(retainedP2Date) >= 3000)
      }
      assertions.push('counterexample-retained-http-date-extends-P2-browser-expiry-beyond-persisted-deadlines')
      assertions.push('physical-cookie-lifetime-and-namespace-readmission-remain-unqualified')
    }
    const discovered = await browserCall(page, { action: 'status' })
    if (mode === 'shared-control') {
      check(discovered.status === 503)
      const tokenAfter = (await context.cookies()).find(cookie => cookie.name === tokenBefore.name)
      check(tokenAfter && tokenAfter.value !== tokenBefore.value)
      assertions.push('negative-control-real-shared-cookie-delayed-P2-destroys-P1-authority')
      ordinaryGate.release(); ordinaryFinishGate.release(); await Promise.all([pendingOrdinary, pendingOrdinaryFinish])
    } else {
      check(discovered.status === 200 && discovered.body.selector === selector)
      const tokenAfter = (await context.cookies()).find(cookie => cookie.name === tokenBefore.name)
      check(tokenAfter?.value === tokenBefore.value)
      await inspectWinningAuxiliary()
      const losingNames = expectedCookieNames(selector2), preparedCookies = await context.cookies()
      check(preparedCookies.some(cookie => cookie.name === losingNames.token) && preparedCookies.some(cookie => cookie.name === losingNames.auxiliary))
      check((await browserCall(second, { action: 'activate', selector: selector2 })).status === 503)
      check((await browserCall(page, { action: 'prepare' })).status === 503)
      assertions.push('P1-original-native-cookie-survives-delayed-P2-P2-refused-expired-complement-removed')
      assertions.push('after-physical-commit-response-failure-reconciles-using-already-present-cookie')
      stage = 'delayed-clear-login-and-modeled-finish'
      const clearGate = gate(); gates.set('clear', clearGate)
      const clear = track(browserCall(second, { action: 'clear-error', selector: selector2, gate: 'clear' }))
      await bounded(clearGate.arrived, 15000)
      check((await browserCall(page, { action: 'status' })).body.selector === selector)
      clearGate.release(); check((await clear).status === 401)
      await inspectWinningAuxiliary(selector2)
      check((await browserCall(page, { action: 'status' })).body.selector === selector)
      ordinaryGate.release(); check(await pendingOrdinary === 200)
      check((await browserCall(page, { action: 'status' })).body.selector === selector)
      check(await app.readPrincipal(request(await cookieHeader())) === null)
      const acrossFinish = gate(); gates.set('finish-clear', acrossFinish)
      const lateClear = track(browserCall(second, { action: 'clear-error', selector: selector2, gate: 'finish-clear' }))
      await bounded(acrossFinish.arrived, 15000)
      const finished = await browserCall(page, { action: 'finish-modeled', selector }); check(finished.status === 200)
      check(await app.readPrincipal(request(await cookieHeader())) !== null)
      acrossFinish.release(); check((await lateClear).status === 401)
      await inspectWinningAuxiliary(selector2)
      check(await app.readPrincipal(request(await cookieHeader())) !== null)
      check((await browserCall(page, { action: 'status', selector })).status === 503)
      // A late ordinary login header can overwrite the ordinary finish cookie.
      // Record truthful loss of ordinary delivery; it cannot resurrect recovery.
      ordinaryFinishGate.release(); check(await pendingOrdinaryFinish === 200)
      check(await app.readPrincipal(request(await cookieHeader())) === null)
      check((await browserCall(page, { action: 'status' })).status === 503)
      assertions.push('losing-native-clear-and-ordinary-login-do-not-replace-restricted-cookie')
      assertions.push('modeled-finish-survives-losing-clear-no-recovery-resurrection')
      assertions.push('late-ordinary-login-after-modeled-finish-can-lose-ordinary-delivery-without-restoring-authority')
    }
    }
    }
    check(errors.page === 0 && errors.proxy === 0 && errors.foreign === 0 && browserRejections === 0 && !sensitive(browserConsole))
    check(qualifier().evidence().admitted === qualifier().evidence().nativeCalls)
    stage = 'completed'
  } finally {
    intercepted.qualifier?.setFault('none')
    for (const held of gates.values()) held.release()
    const close = async (name: string, run: () => Promise<unknown>, ms = 15000) => { try { await bounded(run(), ms) } catch { cleanupFailures.push(name) } }
    await close('browser-pending-requests', () => Promise.allSettled(browserPending))
    await close('browser-context', async () => context?.close())
    await close('browser', async () => browser?.close())
    await close('bridge-work', () => Promise.all([...pending]))
    if (bridge) { bridge.closeAllConnections(); await close('bridge', () => new Promise<void>((done, reject) => bridge!.close(error => error ? reject(error) : done()))) }
    await close('application', async () => app?.close())
    await close('limiter', async () => limiter?.close())
    await close('pool', async () => pool?.end())
    await close('stores', async () => stores?.cleanup(), 120000)
    if (certificateDirectory) await close('certificate-directory', async () => {
      const path = await realpath(certificateDirectory!), parent = await realpath(tmpdir())
      check(dirname(path) === parent && basename(path).startsWith(`q1-recovery-${runId}-`)); await rm(path, { recursive: true })
    })
    await mkdir(directory, { recursive: true })
    const evidence = { runId, variant, mode, stage, elapsedMs: Math.round(performance.now() - startedAt), assertions, errors, cleanupFailures,
      browserVersion, browserRejections,
      retainedDateExpiryEvidence, hookFaultEvidence,
      factoryCount: intercepted.factories - beforeFactories, headers: headerEvidence, native: intercepted.qualifier?.evidence(), stores: stores?.evidence,
      evidenceBoundary: variant === 'q3'
        ? 'MODELED AUTHORITY; native key/session/owner characterization only; no product recovery, provider, code renewal or hold enforcement'
        : 'MODELED AUTHORITY; native factory/cookies/session/owner characterization only; no product recovery or key retirement',
      files: await Promise.all(['tests/helpers/recovery-native-qualification.ts', 'tests/integration/recovery-native-qualification.test.ts'].map(async path =>
        ({ path, sha256: createHash('sha256').update(await readFile(resolve(path))).digest('hex') }))) }
    const rendered = JSON.stringify(evidence, null, 2); check(!sensitive(rendered))
    await writeFile(join(directory, `${variant}-${runId}.json`), rendered, { flag: 'wx' })
    intercepted.qualifier = undefined; intercepted.native = undefined; intercepted.ambient = undefined; intercepted.enrollmentToken = ''
    check(cleanupFailures.length === 0)
  }
}

test.each(['shared-control', 'isolated', 'isolated-finish-delivery'] as const)('Q1 %s real native cookies and owned session transition',
  async variant => runQualification(variant), 300000)
test('Q2 isolated nested native registration and exact new-key UV', async () => runQualification('q2'), 300000)
test('Q3 native complement retirement and final session transition', async () => runQualification('q3'), 300000)
