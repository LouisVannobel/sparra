import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { startGoogleProtocolPeer, type GoogleFixtureOptions } from '../helpers/google-protocol-peer.mjs'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { pgRelay } from '../fixtures/db/pg-relay'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { googleAdmission } from '../../src/modules/auth/admission.server'
import * as admissionFactory from '../../src/modules/auth/admission.server'
import { createAuthAdapter } from '../../src/modules/auth/adapter.server'
import { authSchemaOptions } from '../../src/modules/auth/schema-options.server'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let pool: Pool
let tx: ReturnType<typeof createTransactions>
let limiter: ReturnType<typeof createAuthRateLimiter>
let auth: ReturnType<typeof createApplicationAuth>
let createApplicationAuth: typeof import('../../src/modules/auth/auth.server').createApplicationAuth
let readAuthConfig: typeof import('../../src/modules/auth/auth.server').readAuthConfig
let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>
const origin = 'http://localhost:3000'
beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrateAccountKeyPrefix()
  await stores.administrator.query(`INSERT INTO "user" (id,name,email,email_verified,recovery_generation)
    VALUES ('migrated-user','Migrated fixture','migrated-subject@example.test',true,5);
    INSERT INTO account (id,issuer,provider_id,account_id,user_id)
    VALUES ('migrated-account','https://accounts.google.com','google','migrated-subject','migrated-user')`)
  await stores.migrate()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(url => Number(new URL(url).port)) })
  ;({ createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server'))
  pool = new Pool({ connectionString: stores.runtimeUrl, max: 4 })
  tx = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'google-fixture', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  await limiter.connect()
  auth = createApplicationAuth(tx, readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  const failures: unknown[] = []
  for (const close of [() => auth?.close(), () => limiter?.close(), () => pool?.end(), () => peer?.close()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (stores) {
    try { await stores.cleanup() }
    finally {
      const directory = resolvePath('.output/test-evidence/account-key')
      await mkdir(directory, { recursive: true })
      await writeFile(resolvePath(directory, `google-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2))
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Google integration cleanup failed')
})
let nextClientIp = 1
let abortDuringExchange: AbortController | undefined
const availableEmails = new Map<string, string>()
const concurrentEmails = new Map<string, string[]>()
function request(path: string, method = 'GET', cookie = '', signal?: AbortSignal) {
  const incoming = Object.assign(new Request(origin + path, { method, signal, headers: { origin, cookie, 'x-real-ip': `192.0.2.${nextClientIp++}` } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10_000 })
  return incoming
}
function cookies(headers: Headers) { return headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
function rejectedWithStatus(work: unknown, status: string | number) {
  return Promise.resolve(work).then(() => false, error => error !== null && typeof error === 'object' && 'status' in error && error.status === status)
}
test('native Google initiation binds its state to a nonce after consuming the server-function body', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('Initiation fixture forbids outbound fetch') })
  try {
    const incoming = Object.assign(new Request(origin + '/_serverFn/fixture', {
      method: 'POST', body: JSON.stringify({ locale: 'en' }),
      headers: { origin, 'content-type': 'application/json', 'x-real-ip': `192.0.2.${nextClientIp++}` },
    }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10_000 })
    await incoming.json()
    const start = await auth.beginGoogleSignIn(incoming, 'en')
    const url = new URL(start.url)
    expect(incoming.bodyUsed).toBe(true)
    expect(url.origin).toBe('https://accounts.google.com')
    expect(Boolean(url.searchParams.get('state'))).toBe(true)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(Boolean(url.searchParams.get('code_challenge'))).toBe(true)
    expect(start.headers.getSetCookie().length).toBeGreaterThan(0)
    expect(Boolean(url.searchParams.get('nonce'))).toBe(true)
  } finally { vi.unstubAllGlobals() }
})
async function ceremony(subject: string = randomUUID(), application = auth, executionOwner = tx, fixture: GoogleFixtureOptions = {}) {
  const start = await application.beginGoogleSignIn(request('/_serverFn/fixture', 'POST'))
  const url = new URL(start.url)
  expect(url.origin).toBe('https://accounts.google.com')
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback/google')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  executionOwner.assertNoActiveAuthTransaction()
  const code = peer.register(start.url, subject, { email: concurrentEmails.get(subject)?.shift() ?? availableEmails.get(subject), ...fixture })
  peer.onPost(() => abortDuringExchange?.abort())
  const callback = request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(start.headers), abortDuringExchange?.signal)
  const response = await application.callback(callback)
  return { response, callback, cookie: cookies(response.headers) }
}
test('real Google code callback admits a BA-created session; private reader retains exact session identity and logout revokes', async () => {
  expect(await auth.readPrincipal(request('/account')) === null).toBe(true)
  const flow = await ceremony()
  expect(flow.response.status).toBe(302)
  expect(flow.response.headers.get('location') === origin + '/account').toBe(true)
  expect(flow.cookie.includes('__Secure-better-auth.session_token=')).toBe(true)
  const accountRequest = request('/account', 'GET', flow.cookie)
  const principal = await auth.readPrincipal(accountRequest)
  expect(Boolean(principal && typeof principal.userId === 'string' && typeof principal.sessionId === 'string' && principal.name === 'Protocol fixture' && /@example.test$/.test(principal.email))).toBe(true)
  expect(Object.keys(principal ?? {}).sort()).toEqual(['email','name','sessionId','userId'])
  expect((await stores.administrator.query('SELECT id FROM session WHERE user_id=$1',[principal!.userId])).rows).toEqual([{ id: principal!.sessionId }])
  const storedAccount = (await stores.administrator.query("SELECT provider_id,account_id,to_jsonb(a) ? 'issuer' AS has_issuer FROM account a WHERE user_id=$1", [principal!.userId])).rows[0]
  expect(storedAccount.has_issuer).toBe(false)
  expect(storedAccount.provider_id).toBe('google')
  expect((await stores.administrator.query('SELECT provider_identity FROM session WHERE id=$1', [principal!.sessionId])).rows[0].provider_identity).toEqual({ issuer: 'https://accounts.google.com', subject: storedAccount.account_id })
  expect(/token|authState|recoveryGeneration|providerIdentity/.test(JSON.stringify(principal))).toBe(false)
  const loggedOut = await auth.logout(request('/_serverFn/fixture', 'POST', flow.cookie))
  expect(loggedOut.headers.getSetCookie().some(cookie => cookie.includes('Max-Age=0'))).toBe(true)
  expect(await auth.readPrincipal(accountRequest) === null).toBe(true)
})
test.each(['MFA_PENDING', 'RECOVERY_RESTRICTED', 'expired', 'idle', 'generation', 'recovering'])('reader rejects %s after real admitted issuance', async state => {
  const flow = await ceremony()
  const accountRequest = request('/account', 'GET', flow.cookie)
  const principal = await auth.readPrincipal(accountRequest)
  expect(principal).not.toBeNull()
  if (state === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=1 WHERE id=$1', [principal!.userId])
  else if (state === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [principal!.userId])
  else if (state === 'expired') await stores.administrator.query("UPDATE session SET expires_at=now()-interval '1 second' WHERE user_id=$1", [principal!.userId])
  else if (state === 'idle') await stores.administrator.query("UPDATE session SET last_activity_at=now()-interval '12 hours 1 second' WHERE user_id=$1", [principal!.userId])
  else await stores.administrator.query('UPDATE session SET auth_state=$1 WHERE user_id=$2', [state, principal!.userId])
  expect(await auth.readPrincipal(accountRequest) === null).toBe(true)
  expect(await rejectedWithStatus(auth.requirePrincipal(accountRequest), 401)).toBe(true)
})
test('callback replay cannot publish a new usable session', async () => {
  const flow = await ceremony()
  const replay = await auth.callback(flow.callback)
  expect(replay.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false)
})

test('interleaved built-in callbacks retain distinct selected Google subjects and original sessions', async () => {
  const subjects = [randomUUID(), randomUUID()]
  const flows = await Promise.all(subjects.map(subject => ceremony(subject)))
  const principals = await Promise.all(flows.map(flow => auth.readPrincipal(request('/account', 'GET', flow.cookie))))
  expect(principals.map(principal => principal?.email)).toEqual(subjects.map(subject => subject + '@example.test'))
  expect(new Set(principals.map(principal => principal?.userId)).size).toBe(2)
  const stored = (await stores.administrator.query('SELECT provider_identity, token, expires_at-created_at AS lifetime FROM session WHERE user_id=ANY($1)', [principals.map(principal => principal!.userId)])).rows
  expect(stored.map(row => row.provider_identity.subject).sort()).toEqual([...subjects].sort())
  expect(new Set(stored.map(row => row.token)).size).toBe(2)
  expect(stored.every(row => row.lifetime.days === 7)).toBe(true)
})

test('session insertion failure returns no cookie and no accepted session', async () => {
  await stores.administrator.query("CREATE FUNCTION fixture_reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejection' USING ERRCODE='23514'; END $$; CREATE TRIGGER fixture_reject_session BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION fixture_reject_session()")
  try {
    const subject = randomUUID()
    const flow = await ceremony(subject)
    expect(flow.response.status).toBeGreaterThanOrEqual(400)
    expect(flow.response.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false)
    expect(await auth.readPrincipal(request('/account', 'GET', flow.cookie)) === null).toBe(true)
  } finally { await stores.administrator.query('DROP TRIGGER fixture_reject_session ON session; DROP FUNCTION fixture_reject_session()') }
})

test.each(['before-write', 'before-command-complete', 'after-command-complete'] as const)('issuance COMMIT proof cut %s cannot publish a cookie', async cut => {
  const relay = await pgRelay(stores.runtimeUrl, cut, true)
  peer.allowPort(Number(new URL(relay.url).port))
  const cutPool = new Pool({ connectionString: relay.url, max: 1 })
  cutPool.on('error', () => {})
  const cutOwner = createTransactions(cutPool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const application = createApplicationAuth(cutOwner, readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
  try {
    const flow = await ceremony(randomUUID(), application, cutOwner)
    expect(relay.sessionInserts()).toBe(1)
    expect(flow.response.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false)
  } finally {
    const failures: unknown[] = []
    for (const close of [() => application.close(), () => cutPool.end(), () => relay.close()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Cut application cleanup failed')
  }
})

test('request-local native seam delegates one subject and rejects stale recovery generation, wrong ownership and overrides', async () => {
  const subject = randomUUID()
  const flow = await ceremony(subject)
  const principal = await auth.readPrincipal(request('/account', 'GET', flow.cookie))
  const base = betterAuth({ ...authSchemaOptions, baseURL: origin, secret: randomBytes(48).toString('hex'), logger: { disabled: true },
    database: (options: BetterAuthOptions) => createAuthAdapter(tx, options), socialProviders: { google: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' } } })
  const context = await base.$context
  const originalResolver = vi.spyOn(context.socialProviders[0], 'accountSubject')
  const middleware = googleAdmission(tx, provider => provider).hooks.before[0].handler
  const input = { context, path: '/callback/:id', params: { id: 'google' }, headers: new Headers() }
  const options = { deadlineAtMs: Date.now()+10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() }
  try {
  await tx.runAuthInvocation(options, async () => {
    const fresh = await middleware(input)
    const next = fresh.context.context
    expect(next.socialProviders).not.toBe(context.socialProviders)
    expect(next.socialProviders[0]).not.toBe(context.socialProviders[0])
    expect(next.internalAdapter).not.toBe(context.internalAdapter)
    const resolve = next.socialProviders[0].accountSubject
    const profile = { sub: subject }
    await resolve({ profile, tokens: {} })
    expect(await rejectedWithStatus(resolve({ profile, tokens: {} }), 'UNAUTHORIZED')).toBe(true)
    expect(originalResolver).toHaveBeenCalledTimes(1)
  })
  const other = await ceremony()
  const otherPrincipal = await auth.readPrincipal(request('/account', 'GET', other.cookie))
  for (const mode of ['missing', 'wrong-owner', 'token', 'all', 'storage', 'remember']) {
    await tx.runAuthInvocation({ ...options, correlationId: randomUUID() }, async () => {
      const fresh = (await middleware(input)).context.context
      if (mode !== 'missing') await fresh.socialProviders[0].accountSubject({ profile: { sub: subject }, tokens: {} })
      expect(await rejectedWithStatus(fresh.internalAdapter.createSession(mode === 'wrong-owner' ? otherPrincipal!.userId : principal!.userId,
        mode === 'remember' ? false : undefined, mode === 'token' ? { token: 'forbidden' } : undefined,
        mode === 'all' ? true : undefined, mode === 'storage' ? undefined : { deferSecondaryStorageWrites: false }), 'UNAUTHORIZED')).toBe(true)
    })
  }
  await tx.runAuthInvocation({ ...options, correlationId: randomUUID() }, async () => {
    const fresh = await middleware(input)
    await fresh.context.context.socialProviders[0].accountSubject({ profile: { sub: subject }, tokens: {} })
    await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [principal!.userId])
    expect(await rejectedWithStatus(fresh.context.context.internalAdapter.createSession(principal!.userId, undefined, undefined, undefined, { deferSecondaryStorageWrites: false }), 'UNAUTHORIZED')).toBe(true)
  })
  } finally { originalResolver.mockRestore() }
})

test.each(['recovering', 'unlinked'])('captured Google account %s before admission cannot issue a cookie', async mutation => {
  const subject = randomUUID(), flow = await ceremony(subject)
  const principal = await auth.readPrincipal(request('/account', 'GET', flow.cookie))
  if (mutation === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [principal!.userId])
  if (mutation === 'unlinked') await stores.administrator.query('DELETE FROM account WHERE user_id=$1', [principal!.userId])
  const rejected = await ceremony(subject)
  expect(rejected.response.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false)
})

test('foreign provider rewrite fails in SQL and a still-valid Google binding can log in', async () => {
  const subject = randomUUID(), flow = await ceremony(subject)
  const principal = await auth.readPrincipal(request('/account', 'GET', flow.cookie))
  const before = (await stores.administrator.query('SELECT id,provider_id,account_id,user_id FROM account WHERE user_id=$1', [principal!.userId])).rows
  await expect(stores.administrator.query("UPDATE account SET provider_id='other' WHERE user_id=$1", [principal!.userId])).rejects.toMatchObject({ code: '23514' })
  expect((await stores.administrator.query('SELECT id,provider_id,account_id,user_id FROM account WHERE user_id=$1', [principal!.userId])).rows).toEqual(before)
  const resumed = await ceremony(subject)
  expect((await auth.readPrincipal(request('/account', 'GET', resumed.cookie)))?.userId).toBe(principal!.userId)
})

test('a migrated canonical account logs in with the exact original User/account IDs and generation', async () => {
  const flow = await ceremony('migrated-subject')
  const principal = await auth.requirePrincipal(request('/account', 'GET', flow.cookie))
  expect(principal.userId).toBe('migrated-user')
  expect((await stores.administrator.query('SELECT id,provider_id,account_id,user_id FROM account WHERE user_id=$1', [principal.userId])).rows).toEqual([
    { id: 'migrated-account', provider_id: 'google', account_id: 'migrated-subject', user_id: 'migrated-user' },
  ])
  expect((await stores.administrator.query('SELECT recovery_generation,provider_identity FROM session WHERE id=$1', [principal.sessionId])).rows[0]).toEqual({ recovery_generation: 5, provider_identity: { issuer: 'https://accounts.google.com', subject: 'migrated-subject' } })
})

async function nativeAdmissionContext() {
  const native = betterAuth({ ...authSchemaOptions, baseURL: origin, secret: randomBytes(48).toString('hex'), logger: { disabled: true },
    database: (options: BetterAuthOptions) => createAuthAdapter(tx, options), socialProviders: { google: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' } } })
  return { context: await native.$context, path: '/callback/:id', params: { id: 'google' }, headers: new Headers() }
}

test.each(['unlinked', 'rebound', 'replaced-user', 'recovering', 'generation'])('native session issuance rejects %s after subject capture', async mutation => {
  const subject = randomUUID(), flow = await ceremony(subject)
  const principal = await auth.requirePrincipal(request('/account', 'GET', flow.cookie))
  const input = await nativeAdmissionContext()
  const options = { deadlineAtMs: Date.now()+10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() }
  await tx.runAuthInvocation(options, async () => {
    const next = (await googleAdmission(tx, provider => provider).hooks.before[0].handler(input)).context.context
    await next.socialProviders[0].accountSubject({ profile: { sub: subject }, tokens: {} })
    let selectedUser = principal.userId
    if (mutation === 'unlinked') await stores.administrator.query('DELETE FROM account WHERE user_id=$1', [principal.userId])
    if (mutation === 'rebound') {
      selectedUser = 'migrated-user'
      await stores.administrator.query('UPDATE account SET user_id=$1 WHERE account_id=$2', [selectedUser, subject])
    }
    if (mutation === 'replaced-user') {
      selectedUser = randomUUID()
      await stores.administrator.query('DELETE FROM "user" WHERE id=$1', [principal.userId])
      await stores.administrator.query('INSERT INTO "user" (id,name,email) VALUES ($1,\'Replacement\',$2)', [selectedUser, principal.email])
      await stores.administrator.query("INSERT INTO account (id,provider_id,account_id,user_id) VALUES ($1,'google',$2,$3)", [randomUUID(), subject, selectedUser])
    }
    if (mutation === 'recovering') await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [principal.userId])
    if (mutation === 'generation') await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [principal.userId])
    const before = (await stores.administrator.query('SELECT id FROM session ORDER BY id')).rows
    expect(await rejectedWithStatus(next.internalAdapter.createSession(selectedUser, undefined, undefined, undefined, { deferSecondaryStorageWrites: false }), 'UNAUTHORIZED')).toBe(true)
    expect((await stores.administrator.query('SELECT id FROM session ORDER BY id')).rows).toEqual(before)
  })
})

test('native admission refreshes database time after a real User lock wait and only issues once', async () => {
  const subject = randomUUID(), flow = await ceremony(subject)
  const principal = await auth.requirePrincipal(request('/account', 'GET', flow.cookie))
  const input = await nativeAdmissionContext()
  await tx.runAuthInvocation({ deadlineAtMs: Date.now()+10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() }, async () => {
    const next = (await googleAdmission(tx, provider => provider).hooks.before[0].handler(input)).context.context
    await next.socialProviders[0].accountSubject({ profile: { sub: subject }, tokens: {} })
    await stores.administrator.query('BEGIN')
    let locked = true
    let issuing: ReturnType<typeof next.internalAdapter.createSession> | undefined
    try {
      await stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [principal.userId])
      issuing = next.internalAdapter.createSession(principal.userId, undefined, undefined, undefined, { deferSecondaryStorageWrites: false })
      void issuing.catch(() => {})
      let waiting = false
      for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
        waiting = (await stores.administrator.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND cardinality(pg_blocking_pids(pid))>0) AS waiting")).rows[0].waiting
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      const releasedAt: Date = (await stores.administrator.query('SELECT clock_timestamp() AS now')).rows[0].now
      await stores.administrator.query('COMMIT'); locked = false
      const admitted = await issuing
      expect(admitted).not.toBeNull()
      const stored = (await stores.administrator.query('SELECT authenticated_at,provider_identity FROM session WHERE id=$1', [admitted!.id])).rows[0]
      expect(stored.authenticated_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime())
      expect(stored.provider_identity).toEqual({ issuer: 'https://accounts.google.com', subject })
      expect(await rejectedWithStatus(next.internalAdapter.createSession(principal.userId, undefined, undefined, undefined, { deferSecondaryStorageWrites: false }), 'UNAUTHORIZED')).toBe(true)
    } finally {
      if (locked) await stores.administrator.query('ROLLBACK')
      await issuing?.catch(() => {})
    }
  })
})

test('concurrent first logins for one native key leave one identity and no losing User/session/cookie', async () => {
  const directPool = new Pool({ connectionString: stores.directRuntimeUrl, max: 4 })
  const directOwner = createTransactions(directPool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const application = createApplicationAuth(directOwner, readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
  const subject = randomUUID(), emails = [`first-${subject}@example.test`, `second-${subject}@example.test`]
  concurrentEmails.set(subject, [...emails])
  // Different available emails make account uniqueness, not email uniqueness,
  // arbitrate the race. The fixture holds only these new account insertions.
  await stores.administrator.query("CREATE FUNCTION fixture_account_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(174174); RETURN NEW; END $$; CREATE TRIGGER fixture_account_race BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION fixture_account_race()")
  await stores.administrator.query('SELECT pg_advisory_lock(174174)')
  let pending: Promise<Awaited<ReturnType<typeof ceremony>>[]> | undefined
  try {
    pending = Promise.all([ceremony(subject, application, directOwner), ceremony(subject, application, directOwner)])
    void pending.catch(() => {})
    let waiting = 0
    for (let attempt = 0; attempt < 60 && waiting !== 2; attempt++) {
      waiting = (await stores.administrator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='runtime' AND wait_event='advisory'")).rows[0].n
      if (waiting !== 2) await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(waiting).toBe(2)
    await stores.administrator.query('SELECT pg_advisory_unlock(174174)')
    const flows = await pending
    const principals = await Promise.all(flows.map(flow => application.readPrincipal(request('/account', 'GET', flow.cookie))))
    expect(principals.filter(Boolean)).toHaveLength(1)
    expect(flows.filter(flow => flow.cookie.includes('session_token=')).length).toBe(1)
    const survivor = principals.find(principal => principal !== null)!
    expect((await stores.administrator.query('SELECT id FROM "user" WHERE email=ANY($1)', [emails])).rows).toEqual([{ id: survivor.userId }])
    expect((await stores.administrator.query('SELECT user_id FROM account WHERE provider_id=\'google\' AND account_id=$1', [subject])).rows).toEqual([{ user_id: survivor.userId }])
    expect((await stores.administrator.query('SELECT id FROM session WHERE user_id=$1', [survivor.userId])).rows).toEqual([{ id: survivor.sessionId }])
  } finally {
    const failures: unknown[] = []
    for (const close of [() => stores.administrator.query('SELECT pg_advisory_unlock(174174)'), () => pending?.catch(() => {}),
      () => stores.administrator.query('DROP TRIGGER fixture_account_race ON account; DROP FUNCTION fixture_account_race()'),
      () => application.close(), () => directPool.end()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    concurrentEmails.delete(subject)
    if (failures.length) throw new AggregateError(failures, 'Concurrent application cleanup failed')
  }
})

test('the exact textual subject survives an available email change, while the same email cannot link another subject', async () => {
  const subject = '0009007199254740993'
  const flow = await ceremony(subject)
  const principal = await auth.requirePrincipal(request('/account', 'GET', flow.cookie))
  const original = (await stores.administrator.query('SELECT id,provider_id,account_id,user_id FROM account WHERE user_id=$1', [principal.userId])).rows
  availableEmails.set(subject, 'available-changed@example.test')
  const changed = await ceremony(subject)
  expect((await auth.requirePrincipal(request('/account', 'GET', changed.cookie))).userId).toBe(principal.userId)
  expect((await stores.administrator.query('SELECT id,provider_id,account_id,user_id FROM account WHERE user_id=$1', [principal.userId])).rows).toEqual(original)
  expect((await stores.administrator.query('SELECT provider_identity FROM session WHERE user_id=$1', [principal.userId])).rows.every(row => row.provider_identity.issuer === 'https://accounts.google.com' && row.provider_identity.subject === subject)).toBe(true)
  const different = randomUUID()
  availableEmails.set(different, principal.email)
  const rejected = await ceremony(different)
  expect(rejected.cookie.includes('session_token=')).toBe(false)
  expect(await auth.readPrincipal(request('/account', 'GET', rejected.cookie)) === null).toBe(true)
  expect((await stores.administrator.query('SELECT id FROM account WHERE account_id=$1', [different])).rows).toEqual([])
  expect((await stores.administrator.query('SELECT id FROM "user" WHERE email=$1', [principal.email])).rows).toEqual([{ id: principal.userId }])
})

test('cancellation during provider exchange cannot create or publish an accepted session', async () => {
  abortDuringExchange = new AbortController()
  const subject = randomUUID()
  try {
    const flow = await ceremony(subject)
    expect(flow.response.headers.getSetCookie().some(cookie => cookie.includes('session_token='))).toBe(false)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [subject+'@example.test'])).rows[0].n).toBe(0)
  } finally { abortDuringExchange = undefined }
})

test.each([
  ['audience', { claims: { aud: 'other-client' } }],
  ['additional-audience', { claims: { aud: ['fixture.apps.googleusercontent.com','other-client'] } }],
  ['authorized-party', { claims: { azp: 'other-client' } }],
  ['issuer', { claims: { iss: 'https://example.test' } }],
  ['numeric-subject', { claims: { sub: 123 } }],
  ['non-ascii-subject', { claims: { sub: 'caf\u00e9' } }],
  ['long-subject', { claims: { sub: 'x'.repeat(256) } }],
  ['nonce', { claims: { nonce: 'different-nonce' } }],
  ['missing-nonce', { omitClaims: ['nonce'] }],
  ['missing-expiry', { omitClaims: ['exp'] }],
  ['missing-issued-at', { omitClaims: ['iat'] }],
  ['missing-subject', { omitClaims: ['sub'] }],
  ['expired', { claims: { exp: 1 } }],
  ['fractional-expiry', { claims: { exp: 123.5 } }],
  ['not-before', { claims: { nbf: 9999999999 } }],
  ['algorithm', { alg: 'HS256' }],
  ['malformed-token', { fields: { id_token: 'malformed' } }],
  ['malformed-json', { scenario: 'malformed-json' }],
  ['error-object', { scenario: 'error-object' }],
  ['redirect', { scenario: 'redirect' }],
  ['missing-id-token', { fields: { id_token: null } }],
  ['invalid-optional-refresh', { fields: { refresh_token: 123 } }],
  ['unrepresentable-expiry', { fields: { expires_in: 1e300 } }],
] satisfies [string, GoogleFixtureOptions][])('Google protocol rejects %s before creating an authenticated identity', async (_label, fixture) => {
  const subject = randomUUID(), before = peer.evidence().posts
  const flow = await ceremony(subject, auth, tx, fixture)
  expect(flow.cookie.includes('session_token=')).toBe(false)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM account WHERE account_id=$1',[subject])).rows[0].n).toBe(0)
  expect(peer.evidence().posts).toBe(before+1)
})

test('selected claims policy permits singleton audience and future iat below exp', async () => {
  const flow = await ceremony(randomUUID(), auth, tx, { claims: { aud: ['fixture.apps.googleusercontent.com'], azp: 'fixture.apps.googleusercontent.com', iat: Math.floor(Date.now()/1000)+60 } })
  expect(await auth.readPrincipal(request('/account','GET',flow.cookie))).not.toBeNull()
})

test('a nonextensible invocation Request fails before native state or exchange', async () => {
  const incoming = request('/_serverFn/fixture','POST'), before = peer.evidence().posts
  Object.preventExtensions(incoming)
  await expect(auth.beginGoogleSignIn(incoming)).rejects.toThrow()
  expect(peer.evidence().posts).toBe(before)
})

test('missing native state nonce rejects before the owned token exchange', async () => {
  const start = await auth.beginGoogleSignIn(request('/_serverFn/fixture','POST'))
  const url = new URL(start.url), code = peer.register(start.url)
  const changed = await stores.administrator.query("UPDATE verification SET value=(value::jsonb - 'idTokenNonce')::text WHERE value::jsonb->>'idTokenNonce'=$1", [url.searchParams.get('nonce')])
  expect(changed.rowCount).toBe(1)
  const before = peer.evidence().posts
  const response = await auth.callback(request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(start.headers)))
  expect(cookies(response.headers).includes('session_token=')).toBe(false)
  expect(peer.evidence().posts).toBe(before)
})

test('an overlapping use of the exact same Request cannot replace its bound invocation', async () => {
  const incoming = request('/_serverFn/fixture','POST')
  const outcomes = await Promise.allSettled([auth.beginGoogleSignIn(incoming), auth.beginGoogleSignIn(incoming)])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
})

test('real resource disposal joins Google exchange before limiter and physical pool release', async () => {
  const { createWebResources } = await import('../../src/platform/runtime.server')
  const resources = createWebResources({ APP_ORIGIN: origin, NODE_ENV: 'test', DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
    RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'google-lifecycle', TRUSTED_PROXY_IPS: '127.0.0.1', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })
  const ready = await resources.ready(), application = ready.auth!
  const events: string[] = []
  const closeAuth = application.close, closeLimiter = ready.limiter.close, endPool = Pool.prototype.end
  const authSpy = vi.spyOn(application, 'close').mockImplementation(async () => { events.push('auth-start'); await closeAuth(); events.push('auth-closed') })
  const limiterSpy = vi.spyOn(ready.limiter, 'close').mockImplementation(async () => { events.push('limiter-start'); await closeLimiter(); events.push('limiter-closed') })
  const poolSpy = vi.spyOn(Pool.prototype, 'end').mockImplementation(function (this: Pool) {
    events.push('pool')
    return new Promise<void>(resolve => endPool.call(this, resolve))
  })
  let flow: Promise<Response> | undefined, disposal: Promise<void> | undefined
  try {
    const start = await application.beginGoogleSignIn(request('/_serverFn/fixture','POST')), url = new URL(start.url)
    const code = peer.register(start.url, randomUUID(), { scenario: 'body-held' })
    peer.onPost(() => { disposal = resources.dispose() })
    flow = application.callback(request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(start.headers)))
    const response = await flow
    await disposal
    expect(cookies(response.headers).includes('session_token=')).toBe(false)
    expect(events).toEqual(['auth-start','auth-closed','limiter-start','limiter-closed','pool'])
    expect(ready.isReady()).toBe(false)
    expect(peer.evidence()).toMatchObject({ activeClientSockets: 0, activeRequests: 0 })
  } finally {
    peer.onPost(undefined)
    try {
      try { await resources.dispose() } finally { await flow?.catch(() => {}) }
    } finally { authSpy.mockRestore(); limiterSpy.mockRestore(); poolSpy.mockRestore() }
  }
})

test('native onRequest replacement loses the private binding and refuses exchange', async () => {
  const original = admissionFactory.googleAdmission
  let replacements = 0
  const changed = vi.spyOn(admissionFactory, 'googleAdmission').mockImplementation((...args) => ({
    ...original(...args),
    async onRequest(incoming: Request) { replacements++; return { request: new Request(incoming) } },
  }))
  let application: ReturnType<typeof createApplicationAuth> | undefined
  try {
    application = createApplicationAuth(tx, readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
    const start = await application.beginGoogleSignIn(request('/_serverFn/fixture','POST')), url = new URL(start.url)
    const code = peer.register(start.url), before = peer.evidence().posts
    const response = await application.callback(request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(start.headers)))
    expect(replacements).toBe(1)
    expect(cookies(response.headers).includes('session_token=')).toBe(false)
    expect(peer.evidence().posts).toBe(before)
  } finally { try { await application?.close() } finally { changed.mockRestore() } }
})

test('disposal during real initialization cannot expose an unregistered auth instance', async () => {
  const { createWebResources } = await import('../../src/platform/runtime.server')
  const resources = createWebResources({ APP_ORIGIN: origin, NODE_ENV: 'test', DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
    RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'google-initialization', TRUSTED_PROXY_IPS: '127.0.0.1', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })
  const ready = resources.ready(); void ready.catch(() => {})
  const disposal = resources.dispose()
  expect(await ready.then(() => false, () => true)).toBe(true)
  await disposal
  expect(resources.dispose()).toBe(disposal)
})

test('cleanup failure waits for both native builders before real resource finalizers advance', async () => {
  const peerBefore = peer.evidence()
  const transportFactory = await import('../../src/modules/auth/google-transport.server')
  const originalFactory = transportFactory.createGoogleTransport
  let owned: ReturnType<typeof originalFactory> | undefined
  // Observe the actual instance returned to createApplicationAuth; no fake
  // transport, close method, native builder or resource layer is substituted.
  const factorySpy = vi.spyOn(transportFactory, 'createGoogleTransport').mockImplementation(() => {
    owned = originalFactory(); return owned
  })
  const { createWebResources } = await import('../../src/platform/runtime.server')
  const resources = createWebResources({ APP_ORIGIN: origin, NODE_ENV: 'test', DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
    RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'google-failure-join', TRUSTED_PROXY_IPS: '127.0.0.1', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })
  const releases: (() => void)[] = [], started = [false, false], settled = [false, false]
  const gates = [0,1].map(() => new Promise<void>(resolve => { releases.push(resolve) }))
  let outcomes: Promise<boolean>[] = [], disposal: Promise<void> | undefined
  const restores: (() => void)[] = []
  try {
    const ready = await resources.ready(), application = ready.auth!
    expect(Boolean(owned)).toBe(true)
    let authFinalizerEntered = false, limiterEntered = false, poolEntered = false
    const closeAuth = application.close, closeLimiter = ready.limiter.close, endPool = Pool.prototype.end
    const authSpy = vi.spyOn(application, 'close').mockImplementation(() => { authFinalizerEntered = true; return closeAuth() })
    const limiterSpy = vi.spyOn(ready.limiter, 'close').mockImplementation(() => { limiterEntered = true; return closeLimiter() })
    const poolSpy = vi.spyOn(Pool.prototype, 'end').mockImplementation(function (this: Pool) {
      poolEntered = true; return new Promise<void>(resolve => endPool.call(this, resolve))
    })
    restores.push(() => authSpy.mockRestore(), () => limiterSpy.mockRestore(), () => poolSpy.mockRestore())
    const deadlineAtMs = Date.now()+5000, controller = new AbortController()
    outcomes = gates.map((gate, index) => owned!.exchange({ code: `held-builder-${index}`, redirectURI: origin+'/api/auth/callback/google', options: async () => {
      started[index] = true; await gate
      return { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' }
    } }, { deadlineAtMs, cleanupTimeoutMs: 1000, signal: controller.signal,
      assert() { if (Date.now() >= deadlineAtMs) throw new Error('Fixture invocation ended') },
    }).then(() => { settled[index] = true; return false }, () => { settled[index] = true; return true }))
    expect(started).toEqual([true,true])
    const closing = owned!.close()
    let closeSettled = false
    const closeOutcome = closing.then(() => { closeSettled = true; return false }, () => { closeSettled = true; return true })
    expect(owned!.close() === closing).toBe(true)
    disposal = resources.dispose(); void disposal.catch(() => {})
    await expect.poll(() => authFinalizerEntered).toBe(true)
    // One real 1000ms cleanup allowance expires while both original native
    // builders are still independently awaiting their options functions.
    await new Promise(resolve => setTimeout(resolve, 1100))
    releases[0]()
    expect(await outcomes[0]).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect({ closeSettled, limiterEntered, poolEntered, builders: [...settled] }).toEqual({ closeSettled: false, limiterEntered: false, poolEntered: false, builders: [true,false] })
    releases[1]()
    expect(await outcomes[1]).toBe(true)
    expect(await closeOutcome).toBe(true)
    expect(await disposal.then(() => false, () => true)).toBe(true)
    expect({ limiterEntered, poolEntered, builders: [...settled] }).toEqual({ limiterEntered: true, poolEntered: true, builders: [true,true] })
    expect(peer.evidence()).toMatchObject({ posts: peerBefore.posts, dnsStarted: peerBefore.dnsStarted, activeClientSockets: 0, activeRequests: 0 })
  } finally {
    for (const release of releases) release()
    try {
      await Promise.all(outcomes)
      // The cleanup-allowance rejection is the asserted outcome above; every
      // original builder has settled before allowing normal fixture teardown.
      await (disposal ?? resources.dispose()).catch(() => {})
    } finally { for (const restore of restores) restore(); factorySpy.mockRestore() }
  }
})
