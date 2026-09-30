import { expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { registrationCeremony } from '../helpers/registration-ceremony'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import * as boundary from '../../src/modules/auth/http-boundary.server'

const observed = vi.hoisted(() => ({ token: '', prepared: 0 }))
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args); observed.token = args[3].toString('base64url'); return result
  } }
})
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args)
    return { ...plugin, hooks: { ...plugin.hooks, after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/passkey/verify-registration',
      handler: createAuthMiddleware(async ctx => {
        if (ctx.context.responseHeaders?.getSetCookie().some(value => value.startsWith('__Secure-better-auth.session_token='))) observed.prepared++
      }) }] } }
  } }
})
const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
function request(path: string, cookie = '', body?: unknown, method = 'POST') {
  const incoming = Object.assign(new Request(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin, cookie, 'content-type': 'application/json', 'x-real-ip': '192.0.2.82' } }),
  { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 }); return incoming
}
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')

// Break caught: committing native challenge consume separately, creating User
// before UV, or publishing native cookies before physical final COMMIT.
test('initial_magic_signup_commit_rejection_preserves_both_proofs', async () => {
  expect('magicEnrollmentResponse' in boundary, 'Feature absence: initial enrollment Response consumer is missing').toBe(true)
  if (!('magicEnrollmentResponse' in boundary) || typeof boundary.magicEnrollmentResponse !== 'function') throw new Error('Enrollment consumer missing')
  const complete = boundary.magicEnrollmentResponse
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined
  let limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let application: ReturnType<typeof createApplicationAuth> | undefined
  observed.token = ''; observed.prepared = 0
  try {
    stores = await startDisposableStores(); await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
      GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 3 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'initial-fixture', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' })); await limiter.connect()
    const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
    const config = { ...readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }
    application = createApplicationAuth(owner, config, limiter)
    await application.requestMagicLink(request('/auth/magic/request'), { email: 'first@example.test', locale: 'en' })
    const proof = { token: observed.token, intendedEmail: 'first@example.test' }
    const initialRequest = request('/auth/magic/consume', '', proof)
    const initial = await boundary.magicConsumeResponse(initialRequest, await initialRequest.json(), application, limiter)
    expect(initial.status).toBe(200)
    const enrollment = await initial.json()
    expect(enrollment.enrollmentRequired).toBe(true); expect(enrollment.authenticated).toBeUndefined()
    expect(enrollment.options.authenticatorSelection.userVerification).toBe('required')
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM passkey')).rows[0].count).toBe(0)
    const challengeCookie = cookies(initial)
    const response = registrationCeremony(enrollment.options, origin)
    const input = { ...proof, response }
    await stores.administrator.query(`CREATE FUNCTION fixture_initial_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Owned initial commit rejection' USING ERRCODE='23514'; END $$;
      CREATE CONSTRAINT TRIGGER fixture_initial_commit_reject AFTER INSERT ON session DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fixture_initial_commit_reject()`)
    const failedRequest = request('/auth/magic/enroll', challengeCookie, input)
    const failed = await complete(failedRequest, await failedRequest.json(), application, limiter)
    expect(failed.status).toBe(500); expect(failed.headers.getSetCookie().length).toBe(0); expect(observed.prepared).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM passkey')).rows[0].count).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM verification')).rows[0].count).toBe(1)
    expect((await stores.administrator.query("SELECT state='active' AND verifier_hash IS NOT NULL AS usable FROM email_delivery")).rows[0].usable).toBe(true)
    await stores.administrator.query('DROP TRIGGER fixture_initial_commit_reject ON session; DROP FUNCTION fixture_initial_commit_reject()')
    const finalRequest = request('/auth/magic/enroll', challengeCookie, input)
    const success = await complete(finalRequest, await finalRequest.json(), application, limiter)
    expect(success.status).toBe(200); expect(await success.text() === '{"authenticated":true}').toBe(true)
    const principal = await application.readPrincipal(request('/account', cookies(success), undefined, 'GET'))
    expect(Boolean(principal)).toBe(true)
    const result = await stores.administrator.query(`SELECT u.id,u.name,u.email,u.email_verified,p.user_id AS key_user,s.user_id AS session_user,s.auth_method
      FROM "user" u JOIN passkey p ON p.user_id=u.id JOIN session s ON s.user_id=u.id`)
    expect(result.rowCount).toBe(1)
    expect(result.rows[0]).toMatchObject({ id: principal?.userId, name: 'first@example.test', email: 'first@example.test', email_verified: true,
      key_user: principal?.userId, session_user: principal?.userId, auth_method: 'magic-link' })
    expect(enrollment.options.user.id === principal?.userId).toBe(false)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM verification')).rows[0].count).toBe(0)
    expect((await stores.administrator.query("SELECT state='consumed' AND verifier_hash IS NULL AND ciphertext IS NULL AS retired FROM email_delivery")).rows[0].retired).toBe(true)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM auth_email_command')).rows[0].count).toBe(1)
  } finally {
    observed.token = ''
    const failures: string[] = []
    for (const [name, close] of [['auth', () => application?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()]] as const) {
      try { await close() } catch { failures.push(name) }
    }
    if (stores) {
      try { await stores.cleanup() } catch { failures.push('stores') }
      finally { const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-8b-evidence'); await mkdir(directory, { recursive: true });
        await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n') }
    }
    if (failures.length) throw new Error('Initial enrollment cleanup failed: ' + failures.join(','))
  }
}, 180000)
