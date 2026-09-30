import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { bounded } from '../helpers/web-process'
import { createRecoveryGoogleQualification, qualificationGooglePaths, classifyRecoveryGoogleQualification,
  type RecoveryGoogleQualification, type RecoveryGoogleNativeCalls } from '../helpers/recovery-google-qualification'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'

// Each assertion below names a specific wrong admission, correlation, mutation,
// expiry or settlement boundary. This source-only handoff has no observed RED.
const captured = vi.hoisted(() => ({
  qualifier: undefined as RecoveryGoogleQualification | undefined,
  protocol: undefined as ReturnType<typeof import('../../src/modules/auth/google-protocol.server').createGoogleProtocol> | undefined,
  native: undefined as RecoveryGoogleNativeCalls | undefined,
  factories: 0, protocols: 0,
}))
vi.mock('../../src/modules/auth/google-protocol.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/google-protocol.server')>()
  return { ...actual, createGoogleProtocol(...args: Parameters<typeof actual.createGoogleProtocol>) {
    if (captured.protocol) throw new Error('Qualification constructed a second Google protocol')
    const protocol = actual.createGoogleProtocol(...args)
    captured.protocol = protocol; captured.protocols++
    return protocol
  } }
})
vi.mock('better-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth')>()
  return { ...actual, betterAuth(options: Parameters<typeof actual.betterAuth>[0]) {
    const qualifier = captured.qualifier
    if (!qualifier || captured.factories) throw new Error('Qualification factory interception unavailable')
    const auth = actual.betterAuth({ ...options, plugins: [...options.plugins ?? [], qualifier.plugin] })
    captured.factories++
    captured.native = {
      begin: request => auth.api.qualifyRecoveryGoogleBegin({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
      callback: request => auth.api.qualifyRecoveryGoogleCallback({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
      consume: request => auth.api.qualifyRecoveryGoogleConsume({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
      activation: request => auth.api.qualifyRecoveryGoogleActivation({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
    }
    return auth
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0]
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ matcher: before.matcher,
      handler: createAuthMiddleware(async ctx => {
        const qualifier = captured.qualifier
        if (qualifier && qualificationGooglePaths.has(ctx.path) && qualifier.isBound(ctx.request, ctx.path)) {
          return { context: { context: { socialProviders: ctx.context.socialProviders,
            internalAdapter: ctx.context.internalAdapter } } }
        }
        return before.handler({ ...ctx, returnHeaders: false })
      }),
    }] } }
  } }
})
vi.mock('../../src/modules/auth/http-boundary.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/http-boundary.server')>()
  return { ...actual, assertEndpointClassification(...args: Parameters<typeof actual.assertEndpointClassification>) {
    classifyRecoveryGoogleQualification(actual.assertEndpointClassification, ...args)
  } }
})

const origin = 'https://app.example.test'
const cookie = (headers: Headers) => headers.getSetCookie().filter(value => !/;\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function refused(work: Promise<unknown>) { expect(await work.then(() => false, () => true)).toBe(true) }
let clientIp = 1
function request(path: string, method: 'GET' | 'POST', cookies = '', body?: string) {
  const value = Object.assign(new Request(origin + path, { method, body, headers: {
    ...(method === 'POST' ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    cookie: cookies, 'x-real-ip': `198.18.0.${clientIp++}`,
  } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 15000 })
  return value
}
function hold() {
  let arrive = () => {}, release = () => {}
  const arrived = new Promise<void>(resolve => { arrive = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { arrived, wait: async () => { arrive(); await waiting }, release }
}

test('G3 linked Google proof only without auth side effects', async () => {
  const stores = await startDisposableStores()
  let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
  let pool: Pool | undefined
  let limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  const cleanupFailures: string[] = []
  try {
    await stores.migrate()
    await stores.administrator.query(`CREATE TABLE qualification_recovery_google_attempt (
      id uuid PRIMARY KEY, user_id text NOT NULL, generation integer NOT NULL,
      account_id text NOT NULL, provider_id text NOT NULL, account_subject text NOT NULL,
      issuer text NOT NULL, oauth_state text, expires_at timestamptz NOT NULL,
      phase text NOT NULL CHECK (phase IN ('PENDING','EXCHANGING','PROVED','PREPARED')));
      CREATE UNIQUE INDEX qualification_recovery_google_state_unique
        ON qualification_recovery_google_attempt(oauth_state) WHERE oauth_state IS NOT NULL;
      GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT,UPDATE ON qualification_recovery_google_attempt TO runtime`)
    const userId = randomUUID(), accountId = randomUUID(), subject = randomUUID(), email = `g3-${userId}@example.test`
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [userId, 'G3 fixture', email])
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', subject])
    await stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\',clock_timestamp(),clock_timestamp()),($4,$5,$6,clock_timestamp()-interval \'1 hour\',clock_timestamp(),clock_timestamp())',
      [randomUUID(), 'g3-unrelated-live', 'live', randomUUID(), 'g3-expired-canary', 'expired'])
    peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'g3-native', TRUSTED_PROXY_IPS: '127.0.0.1' })); await limiter.connect()
    const qualifier = createRecoveryGoogleQualification(owner, origin, () => captured.protocol)
    captured.qualifier = qualifier
    app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
    const native = captured.native
    if (!native) throw new Error('Generated qualification wrappers unavailable')
    expect([captured.factories, captured.protocols]).toEqual([1, 1])
    expect((await app.callback(request('/qualification/recovery/google/callback', 'GET'))).status).toBe(404)
    const fixedTables = (await stores.administrator.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename NOT IN ('verification','qualification_recovery_google_attempt') ORDER BY tablename`)).rows.map(row => String(row.tablename))
    const immutable = async () => {
      const entries: Array<{ table: string; rows: unknown[] }> = []
      for (const table of fixedTables) {
        const rows = (await stores.administrator.query(
          `SELECT to_jsonb(t) value FROM "${table.replace(/"/g, '""')}" t ORDER BY to_jsonb(t)::text`)).rows
        entries.push({ table, rows })
      }
      return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    }
    const verificationRows = async () => (await stores.administrator.query('SELECT id,identifier,value,expires_at,created_at,updated_at FROM verification ORDER BY identifier,id')).rows
    const attempt = async (id: string) => (await stores.administrator.query('SELECT * FROM qualification_recovery_google_attempt WHERE id=$1', [id])).rows[0]
    const declaredExpiredIds = new Set((await verificationRows()).filter(row => row.identifier === 'g3-expired-canary').map(row => String(row.id)))
    const expectedSurvivors = (s: { state: string }, before: Awaited<ReturnType<typeof verificationRows>>) =>
      before.filter(row => row.identifier !== s.state && !declaredExpiredIds.has(String(row.id)))
    const sorted = (rows: Awaited<ReturnType<typeof verificationRows>>) => [...rows].sort((a, b) =>
      String(a.identifier).localeCompare(String(b.identifier)) || String(a.id).localeCompare(String(b.id)))
    const callbackRows = async (s: { attemptId: string; state: string }, before: Awaited<ReturnType<typeof verificationRows>>,
      disposition: 'rollback' | 'claimed') => {
      const after = await verificationRows()
      const stateBefore = before.filter(row => row.identifier === s.state)
      const stateAfter = after.filter(row => row.identifier === s.state)
      const proofAfter = after.filter(row => row.identifier === qualifier.proofIdentifier(s.attemptId))
      expect(proofAfter.length).toBe(0)
      if (disposition === 'rollback') {
        expect(stateBefore.length === 1 && digest(after) === digest(before)).toBe(true)
        expect((await attempt(s.attemptId)).phase).toBe('PENDING')
      } else {
        expect(stateBefore.length === 1 && stateAfter.length === 0
          && digest(sorted(after)) === digest(sorted(expectedSurvivors(s, before)))).toBe(true)
        expect((await attempt(s.attemptId)).phase).toBe('EXCHANGING')
      }
    }
    const successRows = async (s: { attemptId: string; state: string }, before: Awaited<ReturnType<typeof verificationRows>>) => {
      const after = await verificationRows(), current = await attempt(s.attemptId)
      const proof = after.filter(row => row.identifier === qualifier.proofIdentifier(s.attemptId))
      if (proof.length !== 1) throw new Error('G3 proof inventory mismatch')
      let value: Record<string, unknown>
      try { value = JSON.parse(proof[0].value) }
      catch { throw new Error('G3 proof value invalid') }
      expect(Object.keys(value).sort().join(',') === 'accountId,attemptId,expiresAt,generation,issuer,providerId,purpose,subject,userId'
        && value.purpose === 'qualification-recovery-google' && value.userId === userId
        && value.attemptId === s.attemptId && value.generation === current.generation
        && value.accountId === current.account_id && value.providerId === 'google'
        && value.issuer === 'https://accounts.google.com' && value.subject === current.account_subject
        && value.expiresAt === new Date(current.expires_at).getTime()
        && proof[0].expires_at.getTime() === value.expiresAt).toBe(true)
      expect(digest(sorted(after)) === digest(sorted([...expectedSurvivors(s, before), proof[0]]))).toBe(true)
      expect(current.phase).toBe('PROVED')
    }
    const nativeCounts = () => ({ ...qualifier.evidence(), posts: peer!.evidence().posts })
    const begin = (admission = { userId, generation: 0 }) => qualifier.invoke('begin', request('/qualification/recovery/google/begin', 'POST'), admission, native.begin)
    const callback = (state: string, code: string, stateCookie: string, settings?: Parameters<typeof qualifier.invoke>[4]) =>
      qualifier.invoke('callback', request('/qualification/recovery/google/callback?state=' + encodeURIComponent(state) + '&code=' + encodeURIComponent(code), 'GET', stateCookie), undefined, native.callback, settings)
    const consume = (attemptId: string, admission: { userId: string; attemptId: string; generation: number } | undefined = { userId, attemptId, generation: 0 }, settings?: Parameters<typeof qualifier.invoke>[4]) =>
      qualifier.invoke('consume', request('/qualification/recovery/google/consume', 'POST'), admission, native.consume, settings)
    const activation = (attemptId: string, admission: { userId: string; attemptId: string; generation: number } | undefined = { userId, attemptId, generation: 0 }) =>
      qualifier.invoke('activation', request('/qualification/recovery/google/activation', 'POST'), admission, native.activation)
    const refusedUnchanged = async (attemptId: string, work: () => Promise<unknown>) => {
      const beforeRows = digest(await verificationRows()), beforeAttempt = digest(await attempt(attemptId)), beforeImmutable = await immutable()
      await refused(work())
      const afterRows = digest(await verificationRows()), afterAttempt = digest(await attempt(attemptId)), afterImmutable = await immutable()
      expect(afterRows === beforeRows && afterAttempt === beforeAttempt && afterImmutable === beforeImmutable).toBe(true)
    }
    const prepare = async (attemptId: string) => {
      const beforeRows = await verificationRows(), beforeAttempt = await attempt(attemptId), beforeImmutable = await immutable()
      const receipt = beforeRows.filter(row => row.identifier === qualifier.proofIdentifier(attemptId))
      expect(receipt.length === 1 && beforeAttempt.phase === 'PROVED').toBe(true)
      const result = await consume(attemptId)
      const expectedRows = beforeRows.filter(row => row.id !== receipt[0].id)
      expect(digest(sorted(await verificationRows())) === digest(sorted(expectedRows))).toBe(true)
      expect(digest(await attempt(attemptId)) === digest({ ...beforeAttempt, phase: 'PREPARED' })).toBe(true)
      expect(await immutable()).toBe(beforeImmutable)
      return result
    }
    const activationUnchanged = async (attemptId: string) => {
      const beforeRows = digest(await verificationRows()), beforeAttempt = digest(await attempt(attemptId)), beforeImmutable = await immutable()
      const result = await activation(attemptId)
      const afterRows = digest(await verificationRows()), afterAttempt = digest(await attempt(attemptId)), afterImmutable = await immutable()
      expect(afterRows === beforeRows && afterAttempt === beforeAttempt && afterImmutable === beforeImmutable).toBe(true)
      return result
    }
    const start = async () => {
      const beforeRows = await verificationRows(), beforeImmutable = await immutable()
      const issued = await begin()
      const url = new URL(issued.response.url)
      const state = url.searchParams.get('state')
      const afterRows = await verificationRows(), added = afterRows.filter(row => !beforeRows.some(old => old.id === row.id))
      expect(state !== null && added.length === 1 && added[0].identifier === state
        && digest(sorted(afterRows)) === digest(sorted([...beforeRows, added[0]]))).toBe(true)
      let nativeState: Record<string, unknown>
      try { nativeState = JSON.parse(added[0].value) }
      catch { throw new Error('G3 native state inventory invalid') }
      if (!nativeState || typeof nativeState !== 'object') throw new Error('G3 native state inventory invalid')
      const context = nativeState.serverContext
      expect(nativeState.oauthState === state && nativeState.idTokenNonce === url.searchParams.get('nonce')
        && typeof nativeState.codeVerifier === 'string' && nativeState.codeVerifier.length > 0
        && nativeState.callbackURL === origin + '/qualification/recovery/google'
        && typeof context === 'object' && context !== null && 'purpose' in context && 'attemptId' in context
        && context.purpose === 'qualification-recovery-google' && context.attemptId === issued.response.attemptId).toBe(true)
      expect(await immutable()).toBe(beforeImmutable)
      expect(url.searchParams.get('redirect_uri') === origin + '/qualification/recovery/google/callback').toBe(true)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('nonce')).toBeTruthy()
      expect(issued.headers.getSetCookie().length).toBe(1)
      expect((await attempt(issued.response.attemptId)).expires_at).toBeTruthy()
      return { ...issued.response, state: state!, stateCookie: cookie(issued.headers) }
    }
    const prove = async (startValue?: Awaited<ReturnType<typeof start>>, providerSubject = subject, options: Record<string, unknown> = {}) => {
      const s = startValue ?? await start()
      const code = peer!.register(s.url, providerSubject, options)
      const before = await verificationRows(), beforeImmutable = await immutable()
      const result = await callback(s.state, code, s.stateCookie)
      await successRows(s, before)
      expect(await immutable()).toBe(beforeImmutable)
      return { s, result }
    }

    // Valid code with no auth_time must create a bound, single-use local proof;
    // ordinary User/Account/Session and profile data must stay byte-for-byte fixed.
    const baseline = await immutable(), beforeNative = await verificationRows(), controlStart = await start()
    const afterBegin = await verificationRows()
    expect(afterBegin.filter(row => !beforeNative.some(old => old.id === row.id)).length === 1
      && afterBegin.some(row => row.identifier === controlStart.state)).toBe(true)
    expect(digest(afterBegin.filter(row => row.identifier === 'g3-unrelated-live'))
      === digest(beforeNative.filter(row => row.identifier === 'g3-unrelated-live'))).toBe(true)
    const first = await prove(controlStart)
    const afterProof = await verificationRows()
    expect(afterProof.filter(row => !afterBegin.some(old => old.id === row.id)).length === 1
      && afterProof.some(row => row.identifier === qualifier.proofIdentifier(first.s.attemptId))).toBe(true)
    expect(afterProof.filter(row => row.identifier === controlStart.state).length).toBe(0)
    expect(first.result.response).toEqual({ proved: true })
    expect(qualifier.evidence()).toMatchObject({ parseEntries: 1, profileMappings: 1, subjects: 1,
      proofCreates: 1, nativeStateDeletes: 1, nativeMutationAttempts: 0 })
    expect(first.result.headers.getSetCookie().every(value => /(?:oauth_state|state)=/.test(value))).toBe(true)
    expect((await attempt(first.s.attemptId)).phase).toBe('PROVED')
    expect(new Date((await attempt(first.s.attemptId)).expires_at).getTime()).toBe(first.s.expiresAt)
    expect(await immutable()).toBe(baseline)
    expect(digest(afterProof.filter(row => row.identifier === 'g3-unrelated-live'))
      === digest(beforeNative.filter(row => row.identifier === 'g3-unrelated-live'))).toBe(true)
    expect(afterProof.some(row => row.identifier === 'g3-expired-canary')).toBe(false)
    expect((await prepare(first.s.attemptId)).response).toEqual({ prepared: true })
    expect(qualifier.evidence().proofConsumes).toBe(1)
    expect((await activationUnchanged(first.s.attemptId)).response).toEqual({ eligible: true })
    await refusedUnchanged(first.s.attemptId, () => consume(first.s.attemptId))
    expect(await immutable()).toBe(baseline)

    // Native state/cookie correlation and the exact nonce guard must refuse
    // before the wrong boundary; an ordinary cookie cannot supply either.
    const ordinaryStart = await app.beginGoogleSignIn(request('/_serverFn/g3-ordinary-control', 'POST'))
    const ordinaryURL = new URL(ordinaryStart.url)
    const ordinaryCode = peer.register(ordinaryStart.url, subject, { email })
    const ordinary = await app.callback(request('/api/auth/callback/google?state=' + encodeURIComponent(ordinaryURL.searchParams.get('state')!)
      + '&code=' + encodeURIComponent(ordinaryCode), 'GET', cookie(ordinaryStart.headers)))
    expect(ordinary.status).toBe(302)
    const ordinaryCookie = cookie(ordinary.headers)
    expect(ordinaryCookie.includes('session_token=')).toBe(true)
    const ordinaryBaseline = await immutable()
    const missingCookie = await start(), missingCode = peer.register(missingCookie.url, subject)
    const beforeMissing = nativeCounts(), missingRows = await verificationRows()
    await refused(callback(missingCookie.state, missingCode, ordinaryCookie))
    expect(nativeCounts().posts).toBe(beforeMissing.posts)
    await callbackRows(missingCookie, missingRows, 'rollback')
    // Each malformed query keeps the same otherwise-valid state/code/cookie;
    // selecting either duplicate value cannot mask a missing cardinality guard.
    const malformedStart = await start(), malformedCode = peer.register(malformedStart.url, subject)
    const validQuery = 'state=' + encodeURIComponent(malformedStart.state) + '&code=' + encodeURIComponent(malformedCode)
    for (const query of [validQuery + '&state=' + encodeURIComponent(malformedStart.state),
      validQuery + '&code=' + encodeURIComponent(malformedCode), validQuery + '&error=denied']) {
      const beforeMalformed = nativeCounts()
      await refusedUnchanged(malformedStart.attemptId, () => qualifier.invoke('callback',
        request('/qualification/recovery/google/callback?' + query, 'GET', malformedStart.stateCookie), undefined, native.callback))
      expect(qualifier.evidence().parseEntries).toBe(beforeMalformed.parseEntries)
      expect(peer.evidence().posts).toBe(beforeMalformed.posts)
      expect(qualifier.evidence().profileMappings).toBe(beforeMalformed.profileMappings)
      expect(qualifier.evidence().proofCreates).toBe(beforeMalformed.proofCreates)
    }
    const malformedRows = await verificationRows(), malformedImmutable = await immutable()
    expect((await callback(malformedStart.state, malformedCode, malformedStart.stateCookie)).response).toEqual({ proved: true })
    await successRows(malformedStart, malformedRows)
    expect(await immutable()).toBe(malformedImmutable)
    const tamperedCookie = await start(), tamperedCode = peer.register(tamperedCookie.url, subject)
    const tamperedRows = await verificationRows()
    await refused(callback(tamperedCookie.state, tamperedCode, tamperedCookie.stateCookie.replace(/=[^;]*/, '=forged')))
    await callbackRows(tamperedCookie, tamperedRows, 'rollback')
    // Both signed values are genuine: callback A must reject B's valid state
    // cookie at native equality, before code exchange or profile mapping.
    const mismatchA = await start(), mismatchB = await start()
    expect(mismatchA.state !== mismatchB.state && mismatchA.stateCookie !== mismatchB.stateCookie).toBe(true)
    const mismatchCodeA = peer.register(mismatchA.url, subject)
    const mismatchCounts = nativeCounts(), mismatchRows = await verificationRows(), mismatchImmutable = await immutable()
    const mismatchAttemptA = digest(await attempt(mismatchA.attemptId)), mismatchAttemptB = digest(await attempt(mismatchB.attemptId))
    await refused(callback(mismatchA.state, mismatchCodeA, mismatchB.stateCookie))
    expect(qualifier.evidence().parseEntries).toBe(mismatchCounts.parseEntries + 1)
    expect(peer.evidence().posts).toBe(mismatchCounts.posts)
    expect(qualifier.evidence().profileMappings).toBe(mismatchCounts.profileMappings)
    expect(qualifier.evidence().proofCreates).toBe(mismatchCounts.proofCreates)
    await callbackRows(mismatchA, mismatchRows, 'rollback')
    const mismatchAfterRows = digest(await verificationRows()), mismatchAfterA = digest(await attempt(mismatchA.attemptId))
    const mismatchAfterB = digest(await attempt(mismatchB.attemptId)), mismatchAfterImmutable = await immutable()
    expect(mismatchAfterRows === digest(mismatchRows) && mismatchAfterA === mismatchAttemptA
      && mismatchAfterB === mismatchAttemptB && mismatchAfterImmutable === mismatchImmutable).toBe(true)
    const noStateNonce = await start()
    await stores.administrator.query('UPDATE verification SET value=(value::jsonb - \'idTokenNonce\')::text WHERE identifier=$1', [noStateNonce.state])
    const beforeNonce = nativeCounts(), noStateNonceRows = await verificationRows()
    await refused(callback(noStateNonce.state, peer.register(noStateNonce.url, subject), noStateNonce.stateCookie))
    expect(nativeCounts().posts).toBe(beforeNonce.posts)
    await callbackRows(noStateNonce, noStateNonceRows, 'rollback')
    for (const claims of [{ omitClaims: ['nonce'] }, { claims: { nonce: 'wrong-nonce' } }]) {
      const s = await start(), before = nativeCounts(), beforeRows = await verificationRows()
      await refused(callback(s.state, peer.register(s.url, subject, claims), s.stateCookie))
      expect(nativeCounts().posts).toBe(before.posts + 1)
      expect(qualifier.evidence().profileMappings).toBe(before.profileMappings)
      await callbackRows(s, beforeRows, 'claimed')
    }
    const badPurpose = await start()
    await stores.administrator.query(`UPDATE verification SET value=jsonb_set(value::jsonb,'{serverContext,purpose}', '"other"')::text WHERE identifier=$1`, [badPurpose.state])
    const badPurposeRows = await verificationRows()
    await refused(callback(badPurpose.state, peer.register(badPurpose.url, subject), badPurpose.stateCookie))
    await callbackRows(badPurpose, badPurposeRows, 'rollback')
    const badPkce = await start(), beforePkce = nativeCounts()
    await stores.administrator.query(`UPDATE verification SET value=jsonb_set(value::jsonb,'{codeVerifier}', '"incorrect-verifier"')::text WHERE identifier=$1`, [badPkce.state])
    const badPkceRows = await verificationRows()
    await refused(callback(badPkce.state, peer.register(badPkce.url, subject), badPkce.stateCookie))
    expect(nativeCounts().posts).toBe(beforePkce.posts + 1)
    await callbackRows(badPkce, badPkceRows, 'claimed')

    // Matching email is deliberately irrelevant; only the raw Google subject
    // and captured native Account ID admit proof persistence.
    const wrongSubject = await start(), beforeWrong = nativeCounts(), wrongRows = await verificationRows()
    await refused(callback(wrongSubject.state, peer.register(wrongSubject.url, randomUUID(), { email }), wrongSubject.stateCookie))
    expect(qualifier.evidence().subjects).toBe(beforeWrong.subjects + 1)
    expect(qualifier.evidence().proofCreates).toBe(beforeWrong.proofCreates)
    expect((await attempt(wrongSubject.attemptId)).phase).toBe('EXCHANGING')
    await callbackRows(wrongSubject, wrongRows, 'claimed')
    expect(await immutable()).toBe(ordinaryBaseline)

    // A confirmed durable claim wins once. The competitor has a fresh Request
    // and lifetime, and loses at the modeled phase before parseState or POST.
    const concurrent = await start(), gate = hold(), concurrentCode = peer.register(concurrent.url, subject)
    const concurrentRows = await verificationRows()
    const winner = callback(concurrent.state, concurrentCode, concurrent.stateCookie, { afterClaim: gate.wait })
    const winnerSettled = winner.then(() => undefined, () => undefined)
    try {
      await bounded(gate.arrived, 15000)
      expect((await attempt(concurrent.attemptId)).phase).toBe('EXCHANGING')
      await callbackRows(concurrent, concurrentRows, 'claimed')
      const during = nativeCounts()
      const duringRows = digest(await verificationRows())
      await refused(callback(concurrent.state, concurrentCode, concurrent.stateCookie))
      expect(qualifier.evidence().phaseRefusals).toBe(during.phaseRefusals + 1)
      expect(qualifier.evidence().parseEntries).toBe(during.parseEntries)
      expect(peer.evidence().posts).toBe(during.posts)
      expect(digest(await verificationRows()) === duringRows).toBe(true)
    } finally {
      gate.release()
      await bounded(winnerSettled, 16000)
    }
    expect((await winner).response).toEqual({ proved: true })
    await successRows(concurrent, concurrentRows)
    const wonRows = await verificationRows()
    expect(wonRows.filter(row => row.identifier === concurrent.state).length === 0
      && wonRows.filter(row => row.identifier === qualifier.proofIdentifier(concurrent.attemptId)).length === 1
      && digest(wonRows.filter(row => row.identifier === 'g3-unrelated-live'))
        === digest(concurrentRows.filter(row => row.identifier === 'g3-unrelated-live'))).toBe(true)
    const faultProof = await prove(), proofBeforeFault = await verificationRows()
    const attemptBeforeFault = digest(await attempt(faultProof.s.attemptId)), faultCounts = qualifier.evidence()
    const fault = qualifier.invoke('consume', request('/qualification/recovery/google/consume', 'POST'),
      { userId, attemptId: faultProof.s.attemptId, generation: 0 }, native.consume, { afterPreparedFault: true })
    await refused(fault)
    expect(qualifier.evidence().consumeFaultReached).toBe(faultCounts.consumeFaultReached + 1)
    expect(qualifier.evidence().proofConsumes).toBe(faultCounts.proofConsumes + 1)
    expect((await attempt(faultProof.s.attemptId)).phase).toBe('PROVED')
    expect(digest(await attempt(faultProof.s.attemptId)) === attemptBeforeFault).toBe(true)
    expect(digest(await verificationRows()) === digest(proofBeforeFault)).toBe(true)

    // Every modeled admission and current-link check is independent of the
    // proof identifier or cookie, including expiry, duplicate rows and all
    // three unlink windows. Perturbed baselines are captured after fixture edits.
    const noAdmission = await prove()
    const beforeNoAdmission = qualifier.evidence()
    await refusedUnchanged(noAdmission.s.attemptId, () => qualifier.invoke('consume', request('/qualification/recovery/google/consume', 'POST', ordinaryCookie,
      JSON.stringify({ attemptId: noAdmission.s.attemptId, proofIdentifier: qualifier.proofIdentifier(noAdmission.s.attemptId) })),
      undefined, native.consume))
    expect(qualifier.evidence().proofConsumes).toBe(beforeNoAdmission.proofConsumes)
    expect(qualifier.evidence().modeledAdmissionRefusals).toBe(beforeNoAdmission.modeledAdmissionRefusals + 1)
    const beforeActivationAdmission = qualifier.evidence()
    await refusedUnchanged(first.s.attemptId, () => qualifier.invoke('activation', request('/qualification/recovery/google/activation', 'POST', ordinaryCookie,
      JSON.stringify({ attemptId: first.s.attemptId, proofIdentifier: qualifier.proofIdentifier(first.s.attemptId) })),
      undefined, native.activation))
    expect(qualifier.evidence().proofConsumes).toBe(beforeActivationAdmission.proofConsumes)
    expect(qualifier.evidence().modeledAdmissionRefusals).toBe(beforeActivationAdmission.modeledAdmissionRefusals + 1)
    expect((await attempt(first.s.attemptId)).phase).toBe('PREPARED')
    const duplicates = await prove()
    await stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) SELECT $1,identifier,value,expires_at,created_at,updated_at FROM verification WHERE identifier=$2',
      [randomUUID(), qualifier.proofIdentifier(duplicates.s.attemptId)])
    const beforeDuplicates = qualifier.evidence().proofConsumes
    await refusedUnchanged(duplicates.s.attemptId, () => consume(duplicates.s.attemptId))
    expect(qualifier.evidence().proofConsumes).toBe(beforeDuplicates)
    const expired = await prove()
    await stores.administrator.query("UPDATE qualification_recovery_google_attempt SET expires_at=date_trunc('milliseconds',clock_timestamp()-interval '1 second') WHERE id=$1", [expired.s.attemptId])
    await stores.administrator.query(`UPDATE verification v SET expires_at=a.expires_at,
      value=jsonb_set(v.value::jsonb,'{expiresAt}',to_jsonb((extract(epoch from a.expires_at)*1000)::bigint))::text
      FROM qualification_recovery_google_attempt a WHERE a.id=$1 AND v.identifier=$2`,
      [expired.s.attemptId, qualifier.proofIdentifier(expired.s.attemptId)])
    const expiredAttempt = await attempt(expired.s.attemptId)
    const expiredReceipt = (await verificationRows()).filter(row => row.identifier === qualifier.proofIdentifier(expired.s.attemptId))
    expect(expiredReceipt.length === 1 && expiredReceipt[0].expires_at.getTime() === new Date(expiredAttempt.expires_at).getTime()
      && JSON.parse(expiredReceipt[0].value).expiresAt === new Date(expiredAttempt.expires_at).getTime()).toBe(true)
    declaredExpiredIds.add(String(expiredReceipt[0].id))
    const beforeExpiry = qualifier.evidence().proofConsumes, beforeDeadline = qualifier.evidence().deadlineRefusals
    await refusedUnchanged(expired.s.attemptId, () => consume(expired.s.attemptId))
    expect(qualifier.evidence().proofConsumes).toBe(beforeExpiry)
    expect(qualifier.evidence().deadlineRefusals).toBe(beforeDeadline + 1)
    const changedGeneration = await prove()
    expect(await immutable()).toBe(ordinaryBaseline)
    await stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [userId])
    const changedBaseline = await immutable()
    await refusedUnchanged(changedGeneration.s.attemptId, () => consume(changedGeneration.s.attemptId))
    expect(await immutable()).toBe(changedBaseline)
    await stores.administrator.query('UPDATE "user" SET recovery_generation=0 WHERE id=$1', [userId])

    const beforeProofUnlink = await start(), unlinkCode = peer.register(beforeProofUnlink.url, subject), beforeUnlinkPost = peer.evidence().posts
    const unlinkRows = await verificationRows(), unlinkAttempt = await attempt(beforeProofUnlink.attemptId)
    const beforeUnlinkImmutable = await immutable()
    let unlinkedBaseline = ''
    await refused(callback(beforeProofUnlink.state, unlinkCode, beforeProofUnlink.stateCookie, { afterSubject: async () => {
      expect(await immutable()).toBe(beforeUnlinkImmutable)
      await stores.administrator.query('DELETE FROM account WHERE id=$1', [accountId])
      unlinkedBaseline = await immutable()
    } }))
    expect(peer.evidence().posts).toBe(beforeUnlinkPost + 1)
    expect(await immutable()).toBe(unlinkedBaseline)
    await callbackRows(beforeProofUnlink, unlinkRows, 'claimed')
    expect(digest(await attempt(beforeProofUnlink.attemptId)) === digest({ ...unlinkAttempt, phase: 'EXCHANGING' })).toBe(true)
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', subject])
    const afterProofUnlink = await prove()
    await stores.administrator.query('DELETE FROM account WHERE id=$1', [accountId])
    const afterProofBaseline = await immutable(), afterProofRows = digest(await verificationRows())
    await refusedUnchanged(afterProofUnlink.s.attemptId, () => consume(afterProofUnlink.s.attemptId))
    expect(await immutable()).toBe(afterProofBaseline)
    expect(digest(await verificationRows()) === afterProofRows).toBe(true)
    expect((await attempt(afterProofUnlink.s.attemptId)).phase).toBe('PROVED')
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', subject])
    const afterPrepareUnlink = await prove()
    expect((await prepare(afterPrepareUnlink.s.attemptId)).response).toEqual({ prepared: true })
    await stores.administrator.query('DELETE FROM account WHERE id=$1', [accountId])
    const afterPrepareBaseline = await immutable(), afterPrepareRows = digest(await verificationRows())
    await refusedUnchanged(afterPrepareUnlink.s.attemptId, () => activation(afterPrepareUnlink.s.attemptId))
    expect(await immutable()).toBe(afterPrepareBaseline)
    expect(digest(await verificationRows()) === afterPrepareRows).toBe(true)
    expect((await attempt(afterPrepareUnlink.s.attemptId)).phase).toBe('PREPARED')
    const replacementId = randomUUID()
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [replacementId, userId, 'google', subject])
    const replacementBaseline = await immutable(), replacementRows = digest(await verificationRows())
    await refusedUnchanged(afterPrepareUnlink.s.attemptId, () => activation(afterPrepareUnlink.s.attemptId))
    expect(await immutable()).toBe(replacementBaseline)
    expect(digest(await verificationRows()) === replacementRows).toBe(true)
    expect(qualifier.evidence().nativeMutationAttempts).toBe(0)
    expect(peer.evidence().disallowed).toBe(0)
  } finally {
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['peer', () => peer?.close()], ['stores', () => stores.cleanup()]] as const) {
      try { await close() } catch { cleanupFailures.push(name) }
    }
    captured.qualifier = undefined; captured.native = undefined; captured.protocol = undefined
  }
  expect(cleanupFailures).toEqual([])
}, 300000)
