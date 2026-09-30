import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseError, Pool } from 'pg'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import type { AdditionalPasskeyInvocation } from '../../src/modules/auth/additional-passkey.server'
import { additionalPasskeyIntent, passkey } from '../../src/modules/auth/schema.server'

const observed = vi.hoisted(() => ({ token: '', flags: 0, sessionReads: 0, afterFailure: false,
  authority: undefined as AdditionalPasskeyInvocation | undefined, wrongRequest: false, wrongPhase: false, falseVerifications: 0, nativeConsumes: 0,
  registrationReaderFlags: 0, delayPath: '', delayReached: 0, delayIntentId: '', delaySuccess: false, delayInserted: false, delayConsumed: false }))
vi.mock('better-auth/api', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth/api')>()
  const getSessionFromCtx: typeof actual.getSessionFromCtx = async (...args) => {
    if (args[1]?.disableCookieCache === true && args[1]?.disableRefresh === true) observed.registrationReaderFlags++
    return actual.getSessionFromCtx(...args)
  }
  return { ...actual, getSessionFromCtx }
})
vi.mock('@simplewebauthn/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>()
  return { ...actual, async verifyAuthenticationResponse(...args: Parameters<typeof actual.verifyAuthenticationResponse>) {
    const result = await actual.verifyAuthenticationResponse(...args)
    if (result.verified === false) observed.falseVerifications++
    return result
  } }
})
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware, APIError } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args), before = plugin.hooks.before[0].handler
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
      const extra = args[5]?.(ctx.request)
      if (extra && ctx.path === '/get-session') {
        observed.authority = extra; observed.sessionReads++
        if (ctx.query?.disableCookieCache === true && ctx.query?.disableRefresh === true) observed.flags++
        if (observed.wrongRequest) extra.assert('session', new Request(ctx.request!.url))
        if (observed.wrongPhase) extra.assert('options', ctx.request)
      }
      const original = ctx.context.internalAdapter
      const consumeVerificationValue: typeof original.consumeVerificationValue = async identifier => {
        observed.nativeConsumes++; return original.consumeVerificationValue(identifier)
      }
      const delegated = { ...ctx, context: extra ? { ...ctx.context, internalAdapter: { ...original, consumeVerificationValue } } : ctx.context }
      return before({ ...delegated, returnHeaders: false })
    }) }], after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/passkey/verify-registration' || ctx.path === '/passkey/generate-register-options', handler: createAuthMiddleware(async ctx => {
      if (ctx.path === observed.delayPath) {
        observed.delayReached++
        const returned = ctx.context.returned
        if (typeof returned === 'object' && returned !== null && !(returned instanceof APIError)) {
          if (ctx.path === '/passkey/generate-register-options') {
            observed.delaySuccess = 'challenge' in returned && typeof returned.challenge === 'string'
              && 'rp' in returned && typeof returned.rp === 'object' && returned.rp !== null
              && 'id' in returned.rp && typeof returned.rp.id === 'string'
              && 'user' in returned && typeof returned.user === 'object' && returned.user !== null
              && 'id' in returned.user && typeof returned.user.id === 'string'
          } else if ('id' in returned && typeof returned.id === 'string' && 'userId' in returned && typeof returned.userId === 'string'
            && 'credentialID' in returned && typeof returned.credentialID === 'string') {
            observed.delaySuccess = true
            const rows = await args[0].currentDb().select({ id: passkey.id }).from(passkey).where(eq(passkey.id, returned.id))
            const intents = await args[0].currentDb().select({ phase: additionalPasskeyIntent.phase }).from(additionalPasskeyIntent).where(eq(additionalPasskeyIntent.id, observed.delayIntentId))
            observed.delayInserted = rows.length === 1
            observed.delayConsumed = intents.length === 1 && intents[0].phase === 'CONSUMED'
          }
        }
        await new Promise(resolve => setTimeout(resolve, 600))
      }
      if (observed.afterFailure) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Owned additional after-hook failure' })
    }) }] } }
  } }
})

describe('additional passkey real native consumer', () => {
  const origin = 'https://app.example.test'
  const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
    from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
  let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool, owner: ReturnType<typeof createTransactions>
  let limiter: ReturnType<typeof createAuthRateLimiter>, app: ReturnType<typeof createApplicationAuth>, ip = 1
  const commitObservations: { command: string; seam: string; status: number; owner: { phase: string; outcome: string } | null; rollbackObserved: boolean }[] = []
  const cookieValues = (headers: Headers) => headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  function request(cookie = '', client?: string, method = 'POST') {
    const value = Object.assign(new Request(origin + '/additional', { method, headers: { origin, cookie,
      'sec-fetch-site': 'same-origin', 'x-real-ip': client ?? `198.18.${Math.floor(ip / 250)}.${ip++ % 250 + 1}` } }),
    { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return value
  }
  async function status(call: Promise<unknown>) {
    try { await call; return 200 } catch (error) { return app.additionalPasskeyErrorResponse(error)?.status ?? limiter.errorResponse(error)?.status ?? 500 }
  }
  const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  async function sessions() { return fingerprint((await stores.administrator.query('SELECT * FROM session ORDER BY id')).rows) }
  async function state(userId: string) {
    return fingerprint((await stores.administrator.query(`SELECT row_to_json(t) AS data FROM (
      SELECT 'session' AS kind,to_jsonb(s) AS value FROM session s WHERE user_id=$1 UNION ALL
      SELECT 'key',to_jsonb(p) FROM passkey p WHERE user_id=$1 UNION ALL
      SELECT 'intent',to_jsonb(i) FROM additional_passkey_intent i WHERE user_id=$1
    ) t ORDER BY kind,value::text`, [userId])).rows)
  }
  async function enroll(workspace = true) {
    const email = `additional-${randomUUID()}@example.test`
    await app.requestMagicLink(request(), { email, locale: 'en' })
    const proof = { token: observed.token, intendedEmail: email }
    const options = await magicConsumeResponse(request(), proof, app, limiter)
    expect(options.status).toBe(200)
    const body = await options.json()
    const credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await magicEnrollmentResponse(request(cookieValues(options.headers)), { ...proof, response: credential.response }, app, limiter)
    expect(enrolled.status).toBe(200)
    const cookie = cookieValues(enrolled.headers)
    const principal = await app.requirePrincipal(request(cookie, undefined, 'GET'))
    if (workspace) expect(Boolean(await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal))).toBe(true)
    return { cookie, credential, principal }
  }
  beforeAll(async () => {
    stores = await startDisposableStores(); await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.additional_passkey_intent TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime; GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime;
      GRANT SELECT ON public.workspace TO runtime; GRANT EXECUTE ON FUNCTION app_private.resolve_personal_workspace(text,text,boolean) TO runtime`)
    pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 3 })
    owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'additional-native', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' })); await limiter.connect()
    const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }, limiter)
  })
  afterAll(async () => {
    const failures: string[] = []
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()], ['stores', () => stores?.cleanup()]] as const) {
      try { await close() } catch { failures.push(name) }
    }
    if (stores) {
      try {
        const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9b-evidence')
        await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`),
          JSON.stringify({ stores: stores.evidence, cleanupFailures: failures, commitObservations }, null, 2) + '\n', { flag: 'wx' })
      } catch { failures.push('evidence-receipt') }
    }
    if (failures.length) throw new Error('Additional fixture cleanup failed: ' + failures.join(','))
  })
  test('stored_key_uv_authorizes_and_aged_session_never_changes', async () => {
    const f = await enroll()
    await stores.administrator.query(`UPDATE session SET created_at=clock_timestamp()-interval '2 days',updated_at=clock_timestamp()-interval '2 days',
      authenticated_at=clock_timestamp()-interval '2 days',last_activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, [f.principal.sessionId])
    const baseline = await sessions(), flags = observed.flags, reads = observed.sessionReads
    const begun = await app.beginAdditionalPasskey(request(f.cookie)); expect(await sessions() === baseline).toBe(true)
    const authorized = await app.authorizeAdditionalPasskey(request(f.cookie), { intentId: begun.intentId, response: f.credential.authenticationResponse(begun.options) })
    expect(await sessions() === baseline).toBe(true)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter).toBe(1)
    const prepared = (await stores.administrator.query(`SELECT phase,authentication_challenge IS NULL AS retired,
      authorizing_key_id IS NOT NULL AND authorizing_credential_id IS NOT NULL AND authorizing_public_key IS NOT NULL AS material,
      EXISTS(SELECT 1 FROM verification v WHERE v.identifier=i.registration_verification_identifier) AS correlated
      FROM additional_passkey_intent i WHERE id=$1`,[begun.intentId])).rows[0]
    expect(prepared).toEqual({phase:'AUTHORIZED',retired:true,material:true,correlated:true})
    expect(authorized.headers.getSetCookie().some(value => value.includes('session_token'))).toBe(false)
    const fresh = registrationCredentialFixture(authorized.options, origin)
    const result = await app.finishAdditionalPasskey(request(f.cookie + '; ' + cookieValues(authorized.headers)), { intentId: begun.intentId, response: fresh.response })
    expect(result.added).toBe(true); expect(await sessions() === baseline).toBe(true)
    expect({ reads: observed.sessionReads - reads, flags: observed.flags - flags }).toEqual({ reads: 3, flags: 3 })
  })
  test('account_private_read_is_linearized_with_locked_session_validation', async () => {
    const f = await enroll()
    const original = owner.withAuthPromise.bind(owner)
    let revokedBeforeRead = false, validatedInReadTransaction = false
    const wrapped: typeof owner.withAuthPromise = async (options, call) => {
      const value = await original(options, call)
      if (typeof value === 'object' && value !== null && 'sessionId' in value && value.sessionId === f.principal.sessionId) {
        let scopeActive = false
        try { owner.assertNoActiveAuthTransaction() } catch { scopeActive = true }
        if (scopeActive) validatedInReadTransaction = true
        else { await stores.administrator.query('DELETE FROM session WHERE id=$1', [f.principal.sessionId]); revokedBeforeRead = true }
      }
      return value
    }
    const spy = vi.spyOn(owner, 'withAuthPromise').mockImplementation(wrapped)
    let published = false, code = 0
    try {
      await app.readAccount(request(f.cookie, undefined, 'GET')).then(() => { published = true; code = 200 }, error => { code = error instanceof Response ? error.status : 500 })
      expect(published && revokedBeforeRead).toBe(false)
      expect(code === 401 || code === 200 && validatedInReadTransaction).toBe(true)
    } finally { spy.mockRestore() }
    if (!revokedBeforeRead) await stores.administrator.query('DELETE FROM session WHERE id=$1', [f.principal.sessionId])
    const refused = await app.readAccount(request(f.cookie, undefined, 'GET')).then(() => 200, error => error instanceof Response ? error.status : 500)
    expect(refused).toBe(401)
  })
  test('additional_registration_reader_receives_both_disable_flags', async () => {
    const f=await enroll(),begin=await app.beginAdditionalPasskey(request(f.cookie)),before=observed.registrationReaderFlags
    const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
    await app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,response:registrationCredentialFixture(authorized.options,origin).response})
    expect(observed.registrationReaderFlags-before).toBe(2)
  })
  test('native_cross_ceremony_context_and_user_refuse_before_consume',async()=>{
    const f=await enroll(),begin=await app.beginAdditionalPasskey(request(f.cookie))
    const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
    const response=registrationCredentialFixture(authorized.options,origin).response
    const row=(await stores.administrator.query('SELECT v.id,v.value FROM verification v JOIN additional_passkey_intent i ON i.registration_verification_identifier=v.identifier WHERE i.id=$1',[begin.intentId])).rows[0]
    for(const change of ['context','type','user'] as const){
      const payload=JSON.parse(row.value)
      if(change==='context')payload.context='additional-passkey:'+randomUUID()
      else if(change==='type')payload.type='authentication'
      else payload.userData.id=randomUUID()
      await stores.administrator.query('UPDATE verification SET value=$2 WHERE id=$1',[row.id,JSON.stringify(payload)])
      const before=observed.nativeConsumes,beforeState=await state(f.principal.userId)
      try{
        expect(await status(app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,response}))).toBe(401)
        expect(observed.nativeConsumes).toBe(before);expect(await state(f.principal.userId)===beforeState).toBe(true)
        expect((await stores.administrator.query('SELECT count(*)::int AS n FROM verification WHERE id=$1',[row.id])).rows[0].n).toBe(1)
      }finally{await stores.administrator.query('UPDATE verification SET value=$2 WHERE id=$1',[row.id,row.value])}
    }
    const other=await app.beginPasskeySignIn(request()),before=observed.nativeConsumes
    expect(await status(app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(other.headers)),{intentId:begin.intentId,response}))).toBe(401)
    expect(observed.nativeConsumes).toBe(before)
  })
  test('new_key_credprops_never_replace_signed_uv',async()=>{
    const f=await enroll(),begin=await app.beginAdditionalPasskey(request(f.cookie))
    const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
    const response=registrationCredentialFixture(authorized.options,origin,false).response,before=await state(f.principal.userId)
    expect(await status(app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,
      response:{...response,clientExtensionResults:{credProps:{rk:true}}}}))).toBe(401)
    expect(await state(f.principal.userId)===before).toBe(true)
    const accepted=await app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,response:registrationCredentialFixture(authorized.options,origin).response})
    expect(accepted.added).toBe(true)
  })
  test('full_native_after_hook_expiry_rolls_back_authorize_and_finish',async()=>{
    for(const operation of ['authorize','finish'] as const){
      const f=await enroll(),begin=await app.beginAdditionalPasskey(request(f.cookie))
      const authorized=operation==='finish'?await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)}):undefined
      await stores.administrator.query("UPDATE additional_passkey_intent SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[begin.intentId])
      const before=await state(f.principal.userId),verificationBefore=fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows),reached=observed.delayReached
      observed.delayPath=operation==='authorize'?'/passkey/generate-register-options':'/passkey/verify-registration'
      observed.delayIntentId=begin.intentId;observed.delaySuccess=false;observed.delayInserted=false;observed.delayConsumed=false
      try{
        const call=operation==='authorize'?app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
          :app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized!.headers)),{intentId:begin.intentId,response:registrationCredentialFixture(authorized!.options,origin).response})
        expect(await status(call)).toBe(401)
        expect(observed.delayReached-reached).toBe(1)
        expect(observed.delaySuccess).toBe(true)
        if(operation==='finish')expect({inserted:observed.delayInserted,consumed:observed.delayConsumed}).toEqual({inserted:true,consumed:true})
        expect(await state(f.principal.userId)===before).toBe(true)
        expect(fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)===verificationBefore).toBe(true)
      }finally{observed.delayPath='';observed.delayIntentId=''}
    }
  })
  test('native_finish_inserts_once_and_new_key_logs_in_same_user', async () => {
    const f = await enroll(), begin = await app.beginAdditionalPasskey(request(f.cookie))
    const authorized = await app.authorizeAdditionalPasskey(request(f.cookie), { intentId: begin.intentId, response: f.credential.authenticationResponse(begin.options) })
    const fresh = registrationCredentialFixture(authorized.options, origin), cookie = f.cookie + '; ' + cookieValues(authorized.headers)
    expect(await status(app.finishAdditionalPasskey(request(cookie), { intentId: begin.intentId, response: fresh.response }))).toBe(200)
    expect(await status(app.finishAdditionalPasskey(request(cookie), { intentId: begin.intentId, response: fresh.response }))).toBe(401)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM passkey WHERE user_id=$1', [f.principal.userId])).rows[0].n).toBe(2)
    expect((await stores.administrator.query('SELECT phase FROM additional_passkey_intent WHERE id=$1', [begin.intentId])).rows[0].phase).toBe('CONSUMED')
    await app.logout(request(f.cookie))
    const login = await app.beginPasskeySignIn(request())
    const logged = await app.finishPasskeySignIn(request(cookieValues(login.headers)), { response: fresh.authenticationResponse(login.options) })
    const principal = await app.requirePrincipal(request(cookieValues(logged.headers), undefined, 'GET'))
    expect(principal.userId === f.principal.userId).toBe(true)
  })
  test('signed_expired_session_refusal_rolls_back_native_cleanup', async () => {
    const f = await enroll(), begin = await app.beginAdditionalPasskey(request(f.cookie))
    await stores.administrator.query(`UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.principal.sessionId])
    const before = await state(f.principal.userId)
    for (const command of ['beginAdditionalPasskey', 'authorizeAdditionalPasskey', 'finishAdditionalPasskey'] as const) {
      const response = command === 'finishAdditionalPasskey' ? f.credential.response : f.credential.authenticationResponse(begin.options)
      expect(await status(app[command](request(f.cookie), { intentId: begin.intentId, response }))).toBe(401)
      expect(await state(f.principal.userId) === before).toBe(true)
    }
  })
  test('get_session_exception_requires_exact_9b_session_phase', async () => {
    const f = await enroll()
    for (const control of ['wrongRequest', 'wrongPhase'] as const) {
      const before = await state(f.principal.userId)
      observed[control] = true
      try { expect(await status(app.beginAdditionalPasskey(request(f.cookie)))).toBe(401) }
      finally { observed[control] = false }
      expect(await state(f.principal.userId) === before).toBe(true)
    }
    expect(() => observed.authority?.assert('session', request(f.cookie))).toThrow()
    const options = { deadlineAtMs: Date.now()+10000, statementTimeoutMs:1000, cleanupTimeoutMs:1000, correlationId:randomUUID() }
    const forbidden = await owner.withAuthPromise(options, async () => status(app.readPrincipal(request(f.cookie))))
    expect(forbidden).toBe(500)
  })
  test('real_bad_assertions_never_authorize', async () => {
    const f = await enroll(), foreign = await enroll()
    for (const variant of ['signature', 'uv', 'up', 'challenge', 'origin', 'rp', 'type', 'id', 'foreign', 'registration', 'cookie-only'] as const) {
      const begin = await app.beginAdditionalPasskey(request(f.cookie))
      const signed = (variant === 'foreign' ? foreign : f).credential.authenticationResponse(begin.options, {
        uv: variant !== 'uv', up: variant !== 'up', challenge: variant === 'challenge' ? 'AQ' : undefined,
        origin: variant === 'origin' ? 'https://other.example.test' : undefined, rpId: variant === 'rp' ? 'other.example.test' : undefined,
        type: variant === 'type' ? 'webauthn.create' : undefined,
      })
      const invalidSignature = foreign.credential.authenticationResponse(begin.options).response.signature
      const falseBefore = observed.falseVerifications
      const response = variant === 'cookie-only' ? undefined : variant === 'registration' ? f.credential.response
        : variant === 'signature' ? { ...signed, response: { ...signed.response, signature: invalidSignature } }
        : variant === 'id' ? { ...signed, id: 'Ag', rawId: 'Ag' } : signed
      const before = await state(f.principal.userId)
      const code = await status(app.authorizeAdditionalPasskey(request(f.cookie), { intentId: begin.intentId, response }))
      expect(code === 401 || code === 500).toBe(true)
      if (variant === 'signature') { expect(code).toBe(401); expect(observed.falseVerifications-falseBefore).toBe(1) }
      expect(await state(f.principal.userId) === before).toBe(true)
    }
  })
  test('native_duplicate_and_foreign_cookie_refuse_before_consumption', async () => {
    const f = await enroll()
    const first = await app.beginAdditionalPasskey(request(f.cookie)), second = await app.beginAdditionalPasskey(request(f.cookie))
    const one = await app.authorizeAdditionalPasskey(request(f.cookie), { intentId: first.intentId, response: f.credential.authenticationResponse(first.options, { counter:1 }) })
    const two = await app.authorizeAdditionalPasskey(request(f.cookie), { intentId: second.intentId, response: f.credential.authenticationResponse(second.options, { counter:2 }) })
    const fresh = registrationCredentialFixture(two.options, origin)
    const count = (await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n
    const consumes = observed.nativeConsumes
    expect(await status(app.finishAdditionalPasskey(request(f.cookie + '; ' + cookieValues(two.headers)), { intentId: first.intentId, response: fresh.response }))).toBe(401)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n).toBe(count)
    expect(observed.nativeConsumes).toBe(consumes)
    const accepted = await app.finishAdditionalPasskey(request(f.cookie + '; ' + cookieValues(one.headers)), { intentId: first.intentId, response: registrationCredentialFixture(one.options, origin).response })
    expect(accepted.added).toBe(true)
  })
  test('authorizing_key_material_continuity_allows_counter_and_name_changes', async () => {
    for (const change of ['ordinary', 'removed', 'replaced'] as const) {
      const f = await enroll(), begin = await app.beginAdditionalPasskey(request(f.cookie))
      const authorized = await app.authorizeAdditionalPasskey(request(f.cookie), { intentId:begin.intentId, response:f.credential.authenticationResponse(begin.options) })
      if (change === 'ordinary') await stores.administrator.query(`UPDATE passkey SET counter=3,name='Renamed' WHERE user_id=$1`, [f.principal.userId])
      else if (change === 'removed') await stores.administrator.query('DELETE FROM passkey WHERE user_id=$1', [f.principal.userId])
      else await stores.administrator.query(`UPDATE passkey SET public_key='changed' WHERE user_id=$1`, [f.principal.userId])
      const response = registrationCredentialFixture(authorized.options,origin).response
      expect(await status(app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)), { intentId:begin.intentId,response }))).toBe(change === 'ordinary' ? 200 : 401)
    }
  })
  test('runtime_role_and_missing_prerequisites_stay_confined', async () => {
    const f = await enroll(false)
    expect((await pool.query('SELECT current_user AS role')).rows[0].role).toBe('runtime')
    expect((await app.readAccount(request(f.cookie,undefined,'GET'))).additionalPasskey).toBe('workspace-required')
    expect(await status(app.beginAdditionalPasskey(request(f.cookie)))).toBe(401)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace WHERE owner_user_id=$1',[f.principal.userId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM additional_passkey_intent')).rows[0].n).toBe(0)
    await createPersonalWorkspaces(owner).ensurePersonalWorkspace(f.principal)
    await stores.administrator.query('DELETE FROM passkey WHERE user_id=$1',[f.principal.userId])
    expect((await app.readAccount(request(f.cookie,undefined,'GET'))).additionalPasskey).toBe('existing-key-required')
    expect(await status(app.beginAdditionalPasskey(request(f.cookie)))).toBe(401)
  })
  test('native_session_delete_cascades_intent_not_verification', async () => {
    const f=await enroll(), begin=await app.beginAdditionalPasskey(request(f.cookie))
    const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
    expect(authorized.headers.getSetCookie().length > 0).toBe(true)
    const before=(await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n
    await app.logout(request(f.cookie))
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM additional_passkey_intent WHERE id=$1',[begin.intentId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n).toBe(before)
  })
  test('finish_faults_keep_prior_counter_and_rollback_insert_consumption', async () => {
    const f=await enroll(), begin=await app.beginAdditionalPasskey(request(f.cookie))
    const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
    const response=registrationCredentialFixture(authorized.options,origin).response, before=await state(f.principal.userId)
    const verificationBefore=fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)
    observed.afterFailure=true
    try { expect(await status(app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,response}))).toBe(500) }
    finally { observed.afterFailure=false }
    expect(await state(f.principal.userId)===before).toBe(true)
    expect(fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)===verificationBefore).toBe(true)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter).toBe(1)
  })
  test('three_literal_limiter_entries_deny_sixth_before_mutation', async () => {
    const f=await enroll()
    for (const [index,command] of ['beginAdditionalPasskey','authorizeAdditionalPasskey','finishAdditionalPasskey'].entries()) {
      const selected = command as 'beginAdditionalPasskey'|'authorizeAdditionalPasskey'|'finishAdditionalPasskey'
      const client=`192.0.2.${170+index}`
      for(let n=0;n<5;n++) await status(app[selected](request(f.cookie,client),{intentId:randomUUID()}))
      const before=await state(f.principal.userId)
      expect(await status(app[selected](request(f.cookie,client),{intentId:randomUUID()}))).toBe(429)
      expect(await state(f.principal.userId)===before).toBe(true)
    }
  })
  test('expired_cleanup_deletes_only_first_100_owned_rows', async () => {
    const f = await enroll(), foreign = await enroll()
    const ownWorkspace = (await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=$1',[f.principal.userId])).rows[0].id
    const foreignWorkspace = (await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=$1',[foreign.principal.userId])).rows[0].id
    const ids = Array.from({length:101},()=>randomUUID()), live = randomUUID(), other = randomUUID()
    await stores.administrator.query(`INSERT INTO additional_passkey_intent(id,user_id,session_id,workspace_id,recovery_generation,phase,expires_at,authentication_challenge)
      SELECT value::uuid,$2,$3,$4,0,'CHALLENGE',clock_timestamp()-interval '1 day'+ordinality*interval '1 millisecond','fixture'
      FROM unnest($1::text[]) WITH ORDINALITY AS seed(value,ordinality)`,[ids,f.principal.userId,f.principal.sessionId,ownWorkspace])
    for(const [id,subject,workspace,expiry] of [[live,f,ownWorkspace,'5 minutes'],[other,foreign,foreignWorkspace,'-1 day']] as const) {
      await stores.administrator.query(`INSERT INTO additional_passkey_intent(id,user_id,session_id,workspace_id,recovery_generation,phase,expires_at,authentication_challenge)
        VALUES($1,$2,$3,$4,0,'CHALLENGE',clock_timestamp()+$5::interval,'fixture')`,[id,subject.principal.userId,subject.principal.sessionId,workspace,expiry])
    }
    const begun = await app.beginAdditionalPasskey(request(f.cookie))
    const remaining = (await stores.administrator.query('SELECT id FROM additional_passkey_intent WHERE user_id=$1',[f.principal.userId])).rows.map(row=>row.id)
    expect({count:remaining.length,oldestRemoved:ids.slice(0,100).every(id=>!remaining.includes(id)),lastRetained:remaining.includes(ids[100]),liveRetained:remaining.includes(live),newCreated:remaining.includes(begun.intentId)})
      .toEqual({count:3,oldestRemoved:true,lastRetained:true,liveRetained:true,newCreated:true})
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM additional_passkey_intent WHERE id=$1',[other])).rows[0].n).toBe(1)
  })
  test('authorization_faults_publish_nothing_and_rollback_counter', async () => {
    const f = await enroll()
    for (const seam of ['counter','challenge','authorization','commit'] as const) {
      const begin=await app.beginAdditionalPasskey(request(f.cookie)), before=await state(f.principal.userId)
      const verificationBefore=fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)
      const table=seam==='counter'?'passkey':seam==='challenge'?'verification':'additional_passkey_intent'
      const event=seam==='challenge'?'INSERT':'UPDATE'
      await stores.administrator.query(`CREATE FUNCTION fixture_additional_authorization_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Owned additional authorization fault' USING ERRCODE='23514'; END $$;
        CREATE ${seam==='commit'?'CONSTRAINT ':''}TRIGGER fixture_additional_authorization_fault AFTER ${event} ON ${table}
        ${seam==='commit'?'DEFERRABLE INITIALLY DEFERRED':''} FOR EACH ROW EXECUTE FUNCTION fixture_additional_authorization_fault()`)
      try {
        let emitted=false, headers=0, ownerOutcome: { phase: string; outcome: string } | null = null
        const code=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
          .then(result=>{emitted=true;headers=result.headers.getSetCookie().length;return 200},error=>{
            if(error instanceof PgTransactionError)ownerOutcome={phase:error.phase,outcome:error.outcome}
            return app.additionalPasskeyErrorResponse(error)?.status??500
          })
        expect(code===500||code===409).toBe(true);expect({emitted,headers}).toEqual({emitted:false,headers:0})
        const rollbackObserved=await state(f.principal.userId)===before
        commitObservations.push({command:'authorize',seam,status:code,owner:ownerOutcome,rollbackObserved})
        expect(rollbackObserved).toBe(true)
        expect(fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)===verificationBefore).toBe(true)
      } finally { await stores.administrator.query(`DROP TRIGGER fixture_additional_authorization_fault ON ${table}; DROP FUNCTION fixture_additional_authorization_fault()`) }
    }
  })
  test('native_insert_and_commit_faults_rollback_consumption', async () => {
    const f=await enroll()
    for(const seam of ['before-insert','after-insert','commit'] as const) {
      const begin=await app.beginAdditionalPasskey(request(f.cookie))
      const counter=(await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter+1
      const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options,{counter})})
      const response=registrationCredentialFixture(authorized.options,origin).response,before=await state(f.principal.userId)
      const verificationBefore=fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)
      await stores.administrator.query(`CREATE FUNCTION fixture_additional_insert_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Owned additional insert fault' USING ERRCODE='23514'; END $$;
        CREATE ${seam==='commit'?'CONSTRAINT ':''}TRIGGER fixture_additional_insert_fault ${seam==='before-insert'?'BEFORE':'AFTER'} INSERT ON passkey
        ${seam==='commit'?'DEFERRABLE INITIALLY DEFERRED':''} FOR EACH ROW EXECUTE FUNCTION fixture_additional_insert_fault()`)
      try {
        let ownerOutcome: { phase: string; outcome: string } | null = null
        const code=await app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,response})
          .then(()=>200,error=>{
            if(error instanceof PgTransactionError)ownerOutcome={phase:error.phase,outcome:error.outcome}
            return app.additionalPasskeyErrorResponse(error)?.status??500
          })
        expect(code===500||code===409).toBe(true)
        const rollbackObserved=await state(f.principal.userId)===before
        commitObservations.push({command:'finish',seam,status:code,owner:ownerOutcome,rollbackObserved})
        expect(rollbackObserved).toBe(true)
        expect(fingerprint((await stores.administrator.query('SELECT * FROM verification ORDER BY id')).rows)===verificationBefore).toBe(true)
      } finally { await stores.administrator.query('DROP TRIGGER fixture_additional_insert_fault ON passkey; DROP FUNCTION fixture_additional_insert_fault()') }
    }
  })
  test('real_duplicate_credential_constraint_refuses_native_insert',async()=>{
    const f=await enroll(),begin=await app.beginAdditionalPasskey(request(f.cookie))
    const authorized=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
    const newCredential=registrationCredentialFixture(authorized.options,origin)
    // Real INSERT constraint collision: a different stored row already owns the new credential ID.
    await stores.administrator.query(`INSERT INTO passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up)
      SELECT $1,'Fixture',public_key,user_id,$2,0,device_type,backed_up FROM passkey WHERE user_id=$3 LIMIT 1`,[randomUUID(),newCredential.response.id,f.principal.userId])
    const before=await state(f.principal.userId)
    expect(await status(app.finishAdditionalPasskey(request(f.cookie+'; '+cookieValues(authorized.headers)),{intentId:begin.intentId,response:newCredential.response}))).toBe(500)
    expect(await state(f.principal.userId)===before).toBe(true)
  })
  test('real_redis_outage_refuses_all_three_entries_before_mutation',async()=>{
    const f=await enroll(),before=await state(f.principal.userId)
    await stores.restartRedis(async()=>{
      for(const command of ['beginAdditionalPasskey','authorizeAdditionalPasskey','finishAdditionalPasskey'] as const) {
        expect(await status(app[command](request(f.cookie),{intentId:randomUUID()}))).toBe(503)
        expect(await state(f.principal.userId)===before).toBe(true)
      }
    })
  })
})

describe('additional intent SQL constraints', () => {
  let stores: Awaited<ReturnType<typeof startDisposableStores>>
  beforeAll(async () => { stores = await startDisposableStores(); await stores.migrate() })
  afterAll(async () => {
    if (!stores) return
    const failures: string[] = []
    try { await stores.cleanup() } catch { failures.push('stores') }
    try {
      const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9b-evidence')
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, `sql-${stores.evidence.runId}.json`), JSON.stringify({ stores: stores.evidence, cleanupFailures: failures }, null, 2) + '\n', { flag: 'wx' })
    } catch { failures.push('receipt') }
    if (failures.length) throw new Error('SQL fixture cleanup failed: ' + failures.join(','))
  })
test('intent_phase_constraints_refuse_invalid_rows', async () => {
    const db = stores.administrator
    await db.query(`INSERT INTO "user"(id,name,email) VALUES ('intent-user','Fixture','intent@example.test');
      INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at)
      VALUES ('intent-session','fixture-session','intent-user',clock_timestamp()+interval '1 day','ACTIVE','passkey',clock_timestamp(),0,clock_timestamp())`)
    for (const [phase, challenge, authorized] of [['INVALID', 'fixture', false], ['CHALLENGE', null, false], ['CHALLENGE', 'fixture', true], ['AUTHORIZED', null, false], ['CONSUMED', 'fixture', true]] as const) {
      let refused = false
      try {
        await db.query(`INSERT INTO additional_passkey_intent(id,user_id,session_id,workspace_id,recovery_generation,phase,expires_at,authentication_challenge,authorizing_key_id,authorizing_credential_id,authorizing_public_key,registration_verification_identifier)
          VALUES ($1,'intent-user','intent-session',$2,0,$3,clock_timestamp()+interval '5 minutes',$4,$5,$5,$5,$5)`,
        [randomUUID(), randomUUID(), phase, challenge, authorized ? 'fixture' : null])
      } catch (error) { refused = error instanceof DatabaseError && error.code === '23514' }
      expect(refused).toBe(true)
    }
})

test('sql_session_delete_cascades_intent_not_verification', async () => {
    const db = stores.administrator
    await db.query(`INSERT INTO "user"(id,name,email) VALUES ('cascade-user','Fixture','cascade@example.test');
      INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at)
      VALUES ('cascade-session','fixture-cascade-session','cascade-user',clock_timestamp()+interval '1 day','ACTIVE','passkey',clock_timestamp(),0,clock_timestamp());
      INSERT INTO verification(id,identifier,value,expires_at) VALUES ('cascade-verification','fixture-verification','fixture',clock_timestamp()+interval '5 minutes')`)
    await db.query(`INSERT INTO additional_passkey_intent(id,user_id,session_id,workspace_id,recovery_generation,phase,expires_at,authorizing_key_id,authorizing_credential_id,authorizing_public_key,registration_verification_identifier)
      VALUES ($1,'cascade-user','cascade-session',$2,0,'AUTHORIZED',clock_timestamp()+interval '5 minutes','fixture','fixture','fixture','fixture-verification')`, [randomUUID(), randomUUID()])
    await db.query(`DELETE FROM verification WHERE id='cascade-verification'`)
    expect((await db.query('SELECT count(*)::int AS n FROM additional_passkey_intent')).rows[0].n).toBe(1)
    await db.query(`DELETE FROM session WHERE id='cascade-session'`)
    expect((await db.query('SELECT count(*)::int AS n FROM additional_passkey_intent')).rows[0].n).toBe(0)
})
})
