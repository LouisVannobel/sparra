import { expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { authorizeEmailRequest, materializeDelivery } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import * as boundary from '../../src/modules/auth/http-boundary.server'

// Test-only observers delegate the actual crypto producer and native cookie
// helper. Neither supplies a token/session nor replaces the runtime adapter.
const observation = vi.hoisted(() => ({ token: '', prepared: 0 }))
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args)
    observation.token = args[3].toString('base64url')
    return result
  } }
})
vi.mock('better-auth/cookies', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth/cookies')>()
  return { ...actual, async setSessionCookie(...args: Parameters<typeof actual.setSessionCookie>) {
    const result = await actual.setSessionCookie(...args)
    observation.prepared++
    return result
  } }
})

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
const options = () => ({ deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
function request(path: string, method = 'POST', cookie = '', body?: string) {
  const incoming = Object.assign(new Request(origin + path, { method, body, headers: { origin, cookie, 'content-type': 'application/json', 'x-real-ip': '192.0.2.81' } }),
    { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  return incoming
}

// Catches publication before whole-native-call COMMIT, separate issuance/retire
// transactions, and an inert/native-bypassing issuer. The first run can only
// establish feature absence until the named response consumer exists.
test('magic_consume_commit_rejection_never_publishes_native_cookie_and_preserves_proof', async () => {
  expect('magicConsumeResponse' in boundary, 'Feature absence: named magic response consumer is missing').toBe(true)
  if (!('magicConsumeResponse' in boundary) || typeof boundary.magicConsumeResponse !== 'function') throw new Error('Magic response consumer missing')
  const consumeResponse = boundary.magicConsumeResponse
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined
  let limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let application: ReturnType<typeof createApplicationAuth> | undefined
  let faultInstalled = false
  observation.token = ''; observation.prepared = 0
  try {
    stores = await startDisposableStores()
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
      GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime;
      INSERT INTO "user"(id,name,email,email_verified,recovery_generation) VALUES ('magic-fixture-user','Fixture','bound@example.test',true,3)`)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 3 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'magic-fixture', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
    await limiter.connect()
    const envelope = createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } })
    const config = { ...readAuthConfig({ APP_ORIGIN: origin, NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex') })!, magic: { envelope, profile } }
    application = createApplicationAuth(owner, config, limiter)
    const minted = await owner.withAuthPromise(options(), async lease => {
      const command = await authorizeEmailRequest(lease, { email: 'bound@example.test', locale: 'en', purpose: 'magic-link', expectedGeneration: 0,
        lifetimeSeconds: 600, userId: 'magic-fixture-user', recoveryGeneration: 3 })
      const delivery = await materializeDelivery(lease, command.id, envelope, profile)
      if (!delivery) throw new Error('Fixture producer failed')
      return { requestId: command.requestId, deliveryId: delivery.id }
    })
    expect(observation.token.length === 43).toBe(true)
    const proof = { token: observation.token, intendedEmail: 'bound@example.test' }
    await stores.administrator.query(`CREATE FUNCTION fixture_magic_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Owned magic commit rejection' USING ERRCODE='23514'; END $$;
      CREATE CONSTRAINT TRIGGER fixture_magic_commit_reject AFTER INSERT ON session DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fixture_magic_commit_reject()`)
    faultInstalled = true
    const failedRequest = request('/auth/magic/consume', 'POST', '', JSON.stringify(proof))
    const failedInput = await failedRequest.json()
    expect(failedRequest.bodyUsed).toBe(true)
    const failed: unknown = await consumeResponse(failedRequest, failedInput, application, limiter)
    expect(failed instanceof Response).toBe(true)
    if (!(failed instanceof Response)) throw new Error('Expected application response')
    expect(failed.status).toBe(500)
    expect(failed.headers.getSetCookie().length).toBe(0)
    expect(await failed.text() === 'Internal Server Error').toBe(true)
    expect(observation.prepared).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(0)
    expect((await stores.administrator.query(`SELECT r.state='active' AND d.state='active' AND d.verifier_hash IS NOT NULL AS usable
      FROM auth_email_request r JOIN auth_email_command c ON c.request_id=r.id JOIN email_delivery d ON d.command_id=c.id
      WHERE r.id=$1 AND d.id=$2`, [minted.requestId, minted.deliveryId])).rows[0].usable).toBe(true)
    await stores.administrator.query('DROP TRIGGER fixture_magic_commit_reject ON session; DROP FUNCTION fixture_magic_commit_reject()')
    faultInstalled = false
    const succeededRequest = request('/auth/magic/consume', 'POST', '', JSON.stringify(proof))
    const succeededInput = await succeededRequest.json()
    expect(succeededRequest.bodyUsed).toBe(true)
    const succeeded: unknown = await consumeResponse(succeededRequest, succeededInput, application, limiter)
    expect(succeeded instanceof Response).toBe(true)
    if (!(succeeded instanceof Response)) throw new Error('Expected application response')
    expect(succeeded.status).toBe(200)
    expect(await succeeded.text() === '{"authenticated":true}').toBe(true)
    expect(observation.prepared).toBe(2)
    const cookie = succeeded.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    expect(cookie.includes('__Secure-better-auth.session_token=')).toBe(true)
    const principal = await application.readPrincipal(request('/account', 'GET', cookie))
    expect(principal?.userId === 'magic-fixture-user').toBe(true)
    expect((await stores.administrator.query('SELECT count(*)::int AS count FROM session')).rows[0].count).toBe(1)
    expect((await stores.administrator.query(`SELECT r.state='consumed' AND d.state='consumed' AND d.verifier_hash IS NULL
      AND d.ciphertext IS NULL AS retired FROM auth_email_request r JOIN auth_email_command c ON c.request_id=r.id
      JOIN email_delivery d ON d.command_id=c.id WHERE r.id=$1 AND d.id=$2`, [minted.requestId, minted.deliveryId])).rows[0].retired).toBe(true)
  } finally {
    observation.token = ''
    const failures: string[] = []
    if (faultInstalled && stores) {
      try { await stores.administrator.query('DROP TRIGGER fixture_magic_commit_reject ON session; DROP FUNCTION fixture_magic_commit_reject()') }
      catch { failures.push('owned-fault') }
    }
    for (const [name, close] of [['auth', () => application?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()]] as const) {
      try { await close() } catch { failures.push(name) }
    }
    if (stores) {
      try { await stores.cleanup() } catch { failures.push('stores') }
      finally {
        const directory = resolve('.output/test-evidence/magic-core')
        await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, `native-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n')
      }
    }
    if (failures.length) throw new Error('Magic fixture cleanup failed: ' + failures.join(','))
  }
}, 180000)
