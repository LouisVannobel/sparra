import { afterAll, beforeAll, expect, test } from 'vitest'
import { vi } from 'vitest'
import dns from 'node:dns'
import { createServer, createConnection, type Socket } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, Client } from 'pg'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { authorizeEmailRequest, materializeDelivery, retireEmailRequest } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { authEmailOutbox, emailDelivery } from '../../src/modules/auth/schema.server'
import { createMailStore } from '../../src/modules/auth/mail-store.server'
import { createAuthMailHandler } from '../../src/modules/auth/mail-worker.server'
import { pgRelay } from '../fixtures/db/pg-relay'
import { startMailHttpPeer } from '../fixtures/mail-http'
import { bounded } from '../helpers/web-process'
import { createPlunkTransport } from '../../src/modules/auth/plunk.server'
import { Redacted } from 'effect'
import { createAuthMailHatchet, createAuthMailTask, runAuthMailTask } from '../../src/modules/auth/mail-hatchet.server'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
const pools: Pool[] = []
const profile = { appOrigin: 'https://app.example.test', apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'key-1', from: { name: 'Product', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
const keys = { currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }
const codec = createAuthEmailEnvelope(keys)
function owner(url: string) { const pool = new Pool({ connectionString: url, max: 3 }); pool.on('error', () => {}); pools.push(pool); return createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }) }
const options = () => ({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request,public.auth_email_command,public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT SELECT,UPDATE ON public."user" TO runtime;`)
})
afterAll(async () => { await Promise.all(pools.map(pool => pool.end())); if (stores) { await stores.cleanup(); await writeFile(resolve('.superpowers/sdd/2026-09-10-functional-auth/task-7-application-mail-core-sql-evidence.json'), JSON.stringify(stores.evidence, null, 2)+'\n') } })
async function materialize(lifetimeSeconds = 600, replayWindowSeconds: number | null = null, apiOrigin = profile.apiOrigin) {
  const web = owner(stores.runtimeUrl)
  const command = await web.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { email: `${randomUUID()}@example.test`, purpose: 'magic-link', locale: 'en', expectedGeneration: 0, lifetimeSeconds }))
  const delivery = await web.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, { ...profile, replayWindowSeconds, apiOrigin }))
  return { command, delivery: delivery! }
}
async function call(url: string, query: ReturnType<typeof sql>) {
  return owner(url).withAuthPromise(options(), async ({ db }) => (await db.select({ value: sql`value` }).from(sql`(${query}) AS mail_result`))[0]?.value)
}
function zeroPolicyInvocation(handler: ReturnType<typeof createAuthMailHandler>) {
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url'), 'synthetic'].join('.')
  const client = createAuthMailHatchet({ token, host_port: '127.0.0.1:1', api_url: 'http://127.0.0.1:1', tls_config: { tls_strategy: 'none' } }, resolve('.output/worker/hatchet-empty.yaml'))
  const actual = createAuthMailTask(client, handler)
  const zero = client.task({ ...actual.taskDef, retries: 0 })
  expect(zero.taskDef.retries).toBe(0)
  expect(zero.taskDef.fn).toBe(actual.taskDef.fn)
  // Controlled calls to the very boundary used by fn; no engine/scheduler is
  // exercised, and no positive retry setting repairs or serializes these calls.
  return (outboxId: string, signal = new AbortController().signal) => runAuthMailTask(handler, { outboxId }, signal)
}
async function admitForControlledExecution(outboxId: string) {
  const relay = createMailStore(owner(stores.mailRelayUrl))
  for (let i = 0; i < 100; i++) {
    const claim = await relay.claimAdmission()
    if (!claim) break
    await relay.finalizeAdmission(claim.outboxId, claim.fence, claim.outboxId === outboxId ? randomUUID() : null)
    if (claim.outboxId === outboxId) return
  }
  throw new Error('Owned admission fixture unavailable')
}
async function expireOwnedProviderLease(deliveryId: string) {
  await stores.administrator.query('BEGIN; SET LOCAL ROLE auth_mail_definer')
  try {
    await stores.administrator.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
    await stores.administrator.query("UPDATE email_delivery SET provider_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND provider_state='attempting'", [deliveryId])
    await stores.administrator.query('COMMIT')
  } catch (error) { await stores.administrator.query('ROLLBACK'); throw error }
}
test.each(['direct', 'pooled'] as const)('relay finalizer refuses NULL and nonpositive fences through the %s login', async connection => {
  const { delivery } = await materialize()
  const relayStore = createMailStore(owner(stores.mailRelayUrl))
  let fence: number | undefined
  for (let i = 0; i < 100; i++) {
    const claim = await relayStore.claimAdmission()
    if (!claim) break
    if (claim.outboxId === delivery.outboxId) { fence = claim.fence; break }
    await relayStore.finalizeAdmission(claim.outboxId, claim.fence, null)
  }
  expect(fence).toBe(1)
  const client = new Client({ connectionString: connection === 'direct' ? stores.directMailRelayUrl : stores.mailRelayUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
    for (const supplied of [null, 0, -1]) {
      const result = await client.query('SELECT public.auth_mail_finalize_admission($1,$2,$3) AS accepted', [delivery.outboxId, supplied, randomUUID()])
      expect(result.rows[0].accepted).toBe(false)
    }
    expect((await client.query('SELECT public.auth_mail_finalize_admission($1,$2,$3) AS accepted', [delivery.outboxId, fence, randomUUID()])).rows[0].accepted).toBe(true)
    await client.query('COMMIT')
  } finally { await client.query('ROLLBACK'); await client.end() }
})
test.each(['direct', 'pooled'] as const)('worker finalizer refuses NULL and nonpositive fences through the %s login', async connection => {
  const { delivery } = await materialize()
  const claim = await createMailStore(owner(stores.mailWorkerUrl)).claimDelivery(delivery.outboxId)
  expect(claim?.fence).toBe(1)
  const client = new Client({ connectionString: connection === 'direct' ? stores.directMailWorkerUrl : stores.mailWorkerUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
    for (const supplied of [null, 0, -1]) {
      const result = await client.query("SELECT public.auth_mail_finalize_delivery($1,$2,'plunk_queued','duplicate_409',NULL) AS accepted", [delivery.outboxId, supplied])
      expect(result.rows[0].accepted).toBe(false)
    }
    expect((await client.query("SELECT public.auth_mail_finalize_delivery($1,$2,'plunk_queued','duplicate_409',NULL) AS accepted", [delivery.outboxId, claim!.fence])).rows[0].accepted).toBe(true)
    await client.query('COMMIT')
  } finally { await client.query('ROLLBACK'); await client.end() }
})
test('relay and worker authenticate as distinct real PG and PgBouncer logins and refuse direct content or impersonation', async () => {
  for (const [url, expected] of [[stores.mailRelayUrl, 'auth_mail_relay'], [stores.directMailRelayUrl, 'auth_mail_relay'], [stores.mailWorkerUrl, 'auth_mail_worker'], [stores.directMailWorkerUrl, 'auth_mail_worker']]) {
    const client = new Client({ connectionString: url }); await client.connect()
    try {
      expect((await client.query('SELECT current_user AS who, session_user AS login')).rows[0]).toEqual({ who: expected, login: expected })
      for (const query of ['SELECT ciphertext FROM email_delivery', "UPDATE auth_email_outbox SET admission_state='admitted'", 'SET ROLE auth_mail_definer', 'SET ROLE auth_mail_owner']) {
        await expect(client.query(query)).rejects.toMatchObject({ code: '42501' })
      }
    } finally { await client.end() }
  }
})
test('committed worker claim marks attempting before content leaves SQL, while relay finalization cannot overwrite it', async () => {
  const { delivery } = await materialize()
  const admission = await call(stores.mailRelayUrl, sql`SELECT public.auth_mail_claim_admission() AS value`)
  expect(admission).toMatchObject({ outboxId: delivery.outboxId, fence: 1 })
  const attempt = await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  expect(attempt).toMatchObject({ outboxId: delivery.outboxId, fence: 1, format: 'auth-plunk-v1' })
  const runId = randomUUID()
  expect(await call(stores.mailRelayUrl, sql`SELECT public.auth_mail_finalize_admission(${delivery.outboxId}::uuid,1,${runId}::uuid) AS value`)).toBe(true)
  const state = (await stores.administrator.query('SELECT provider_state,first_attempt_at,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  expect(state.provider_state).toBe('attempting'); expect(state.first_attempt_at).not.toBeNull(); expect(state.replay_not_after).toBeNull()
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)).toBeNull()
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'effect_unknown',NULL,NULL) AS value`)).toBe(true)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)).toBeNull()
  expect((await stores.administrator.query('SELECT provider_state,ciphertext FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]).toEqual({ provider_state: 'held', ciphertext: null })
})
test('queued evidence purges ciphertext but preserves verifier until authoritative expiry', async () => {
  const { delivery } = await materialize(2)
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'plunk_queued','response_200',${randomUUID()}::uuid) AS value`)).toBe(true)
  let row = (await stores.administrator.query('SELECT verifier_hash IS NOT NULL AS verifier,ciphertext,state FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  expect(row).toEqual({ verifier: true, ciphertext: null, state: 'active' })
  await new Promise(resolve => setTimeout(resolve, 2100))
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_purge() AS value`)
  row = (await stores.administrator.query('SELECT verifier_hash IS NOT NULL AS verifier,ciphertext,state FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  expect(row).toEqual({ verifier: false, ciphertext: null, state: 'expired' })
})
test('missing IDs, wrong scope and cross-role calls cannot create provider authority', async () => {
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${randomUUID()}::uuid) AS value`)).toBeNull()
  await expect(call(stores.mailRelayUrl, sql`SELECT public.auth_mail_claim_delivery(${randomUUID()}::uuid) AS value`)).rejects.toThrow()
  await expect(call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_admission() AS value`)).rejects.toThrow()
  const { delivery } = await materialize()
  const webClient = new Client({ connectionString: stores.runtimeUrl }); await webClient.connect()
  try {
    await webClient.query('BEGIN'); await webClient.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
    await expect(webClient.query("UPDATE public.email_delivery SET provider_state='plunk_queued' WHERE id=$1", [delivery.id])).rejects.toMatchObject({ code: '23514' })
    await webClient.query('ROLLBACK')
  } finally { await webClient.end() }
  const client = new Client({ connectionString: stores.mailWorkerUrl }); await client.connect()
  try {
    await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true)")
    expect((await client.query('SELECT public.auth_mail_claim_delivery($1) AS value', [delivery.outboxId])).rows[0].value).toBeNull()
    await client.query('ROLLBACK')
  } finally { await client.end() }
})
test('qualified replay freezes bytes and first attempt across restart, rejects stale fences, then purges on horizon loss', async () => {
  const { delivery } = await materialize(600, 2)
  const first = await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  expect(first).not.toBeNull()
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'effect_unknown',NULL,NULL) AS value`)
  const before = (await stores.administrator.query('SELECT first_attempt_at,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  const second = await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  // Compare only non-content hashes; no decrypted auth material reaches failures.
  expect(second).toMatchObject({ fence: 2 })
  expect(typeof first === 'object' && first !== null && 'hash' in first && typeof second === 'object' && second !== null && 'hash' in second && first.hash === second.hash).toBe(true)
  const after = (await stores.administrator.query('SELECT first_attempt_at,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  expect(after).toEqual(before)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'plunk_queued','duplicate_409',NULL) AS value`)).toBe(false)
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,2,'effect_unknown',NULL,NULL) AS value`)
  await new Promise(resolve => setTimeout(resolve, 2100))
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)).toBeNull()
  expect((await stores.administrator.query('SELECT provider_state,ciphertext,verifier_hash IS NOT NULL AS verifier FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]).toEqual({ provider_state: 'held', ciphertext: null, verifier: true })
})
test('lost claim COMMIT acknowledgement never releases a provider call and leaves its attempting identity durable', async () => {
  const { delivery } = await materialize()
  const relay = await pgRelay(stores.mailWorkerUrl, 'after-command-complete')
  let sends = 0
  const handler = createAuthMailHandler(createMailStore(owner(relay.url)), codec, { async send() { sends++; return { state: 'effect_unknown' } } })
  try {
    expect(await handler.handle({ outboxId: delivery.outboxId }, new AbortController().signal)).toEqual({ state: 'deferred', reason: 'claim_unresolved' })
    expect(sends).toBe(0)
    expect((await stores.administrator.query('SELECT provider_state,first_attempt_at IS NOT NULL AS first FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]).toEqual({ provider_state: 'attempting', first: true })
  } finally { await handler.stop(); await relay.close() }
})
test('SQL privileges show separate forced-RLS owners, fixed definer paths and no PUBLIC function execution', async () => {
  const tables = (await stores.administrator.query("SELECT r.rolname,c.relforcerowsecurity FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname IN ('auth_email_command','auth_email_request','auth_email_outbox','email_delivery')")).rows
  expect(tables).toHaveLength(4); expect(tables.every(row => row.rolname === 'auth_mail_owner' && row.relforcerowsecurity)).toBe(true)
  const functions = (await stores.administrator.query("SELECT p.proname,r.rolname,p.prosecdef,p.proconfig, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('auth_mail_locked','auth_mail_claim_admission','auth_mail_finalize_admission','auth_mail_claim_delivery','auth_mail_finalize_delivery','auth_mail_purge')")).rows
  expect(functions).toHaveLength(6)
  expect(functions.every(row => row.rolname === 'auth_mail_definer' && row.prosecdef && !row.public_exec && row.proconfig.includes('search_path=pg_catalog, pg_temp'))).toBe(true)
})
test('queued duplicate receipt cannot introduce an email UUID and malformed receipt state is refused', async () => {
  const { delivery } = await materialize()
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'plunk_queued','duplicate_409',${randomUUID()}::uuid) AS value`)).toBe(false)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'plunk_queued',NULL,NULL) AS value`)).toBe(false)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'plunk_queued','duplicate_409',NULL) AS value`)).toBe(true)
})
test('legacy token-only rows remain non-sendable and cannot be rerendered by materialization', async () => {
  const web = owner(stores.runtimeUrl), id = randomUUID(), outboxId = randomUUID()
  const command = await web.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { email: `${randomUUID()}@example.test`, purpose: 'magic-link', locale: 'en', expectedGeneration: 0, lifetimeSeconds: 600 }))
  await web.withAuthPromise(options(), async lease => {
    const sealed = codec.seal(randomBytes(32), { deliveryId: id, purpose: 'magic-link', generation: command.generation, expiresAt: command.expiresAt }, new Date())
    await lease.db.insert(emailDelivery).values({ id, commandId: command.id, state: 'active', ...sealed })
    await lease.db.insert(authEmailOutbox).values({ id: outboxId, deliveryId: id })
  })
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${outboxId}::uuid) AS value`)).toBeNull()
  expect(await web.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, profile))).toEqual({ id, outboxId })
  expect((await stores.administrator.query('SELECT snapshot_format,first_attempt_at FROM email_delivery WHERE id=$1', [id])).rows[0]).toEqual({ snapshot_format: null, first_attempt_at: null })
})
test('generation retirement after claim rejects fenced finalization and removes all link authority', async () => {
  const { delivery, command } = await materialize()
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  const web = owner(stores.runtimeUrl)
  await web.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { email: command.recipient, purpose: 'magic-link', locale: 'en', expectedGeneration: command.generation, lifetimeSeconds: 600 }))
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_finalize_delivery(${delivery.outboxId}::uuid,1,'plunk_queued','duplicate_409',NULL) AS value`)).toBe(false)
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)).toBeNull()
  expect((await stores.administrator.query('SELECT state,ciphertext,verifier_hash FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]).toEqual({ state: 'superseded', ciphertext: null, verifier_hash: null })
})
test('crashed attempt without replay authority keeps its first-attempt identity and purges instead of reauthorizing', async () => {
  const { delivery } = await materialize()
  await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)
  const before = (await stores.administrator.query('SELECT first_attempt_at,provider_fence FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  await stores.administrator.query('BEGIN; SET LOCAL ROLE auth_mail_definer')
  try {
    await stores.administrator.query("SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)")
    await stores.administrator.query("UPDATE email_delivery SET provider_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [delivery.id])
    await stores.administrator.query('COMMIT')
  } catch (error) { await stores.administrator.query('ROLLBACK'); throw error }
  expect(await call(stores.mailWorkerUrl, sql`SELECT public.auth_mail_claim_delivery(${delivery.outboxId}::uuid) AS value`)).toBeNull()
  const after = (await stores.administrator.query('SELECT first_attempt_at,provider_fence,provider_state,ciphertext FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
  expect(after).toEqual({ ...before, provider_state: 'held', ciphertext: null })
})
test('invalid collision finalization persists admission_unknown and never becomes a pending readmission', async () => {
  const { delivery } = await materialize()
  let found = false
  for (let i = 0; i < 100; i++) {
    const store = createMailStore(owner(stores.mailRelayUrl)), claim = await store.claimAdmission()
    if (!claim) break
    await store.finalizeAdmission(claim.outboxId, claim.fence, null)
    if (claim.outboxId === delivery.outboxId) { found = true; break }
  }
  expect(found).toBe(true)
  expect((await stores.administrator.query('SELECT admission_state,admission_fence,run_id FROM auth_email_outbox WHERE id=$1', [delivery.outboxId])).rows[0]).toEqual({ admission_state: 'admission_unknown', admission_fence: 1, run_id: null })
})
test.each(['lookup', 'TLS'] as const)('a late retry with delayed %s sends zero HTTP requests after persisted replay expiry', async delayAt => {
  const peer = await startMailHttpPeer()
  const sockets = new Set<Socket>()
  let release = () => {}, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const bridge = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pause()
    release = () => {
      release = () => {}
      if (socket.destroyed) return
      const upstream = createConnection({ host: '127.0.0.1', port: Number(new URL(peer.origin).port) })
      sockets.add(upstream); upstream.on('error', () => socket.destroy()); upstream.once('close', () => sockets.delete(upstream))
      socket.pipe(upstream); upstream.pipe(socket); socket.resume()
    }
    entered()
  })
  let restoreLookup = () => {}
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    let apiOrigin = peer.origin.replace('127.0.0.1', 'localhost')
    if (delayAt === 'TLS') {
      await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
      const address = bridge.address()
      if (!address || typeof address === 'string') throw new Error('Owned TLS bridge unavailable')
      apiOrigin = `https://127.0.0.1:${address.port}`
    }
    const { delivery } = await materialize(600, 2, apiOrigin)
    const store = createMailStore(owner(stores.mailWorkerUrl))
    const first = await store.claimDelivery(delivery.outboxId)
    expect(first?.fence).toBe(1)
    expect(await store.finalizeDelivery(delivery.outboxId, first!.fence, { state: 'effect_unknown' })).toBe(true)
    const authority = (await stores.administrator.query('SELECT first_attempt_at,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    // This is a late second SQL claim, not a first attempt with no replay limit.
    await new Promise(resolve => setTimeout(resolve, 1100))
    if (delayAt === 'lookup') {
      const original = dns.lookup
      const spy = vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
        const callback = args[2]
        if (typeof callback !== 'function') throw new Error('Expected owned lookup callback')
        original('localhost', { all: true, family: 4 }, (error, addresses) => {
          release = () => { release = () => {}; callback(error, addresses) }
          entered()
        })
      })
      restoreLookup = () => spy.mockRestore()
    }
    transport = createPlunkTransport({ apiOrigin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    let retryFence: number | undefined
    handler = createAuthMailHandler({
      ...store,
      async claimDelivery(...args) {
        const claim = await store.claimDelivery(...args)
        retryFence = claim?.fence
        return claim
      },
    }, codec, transport)
    const pending = handler.handle({ outboxId: delivery.outboxId }, new AbortController().signal)
    await bounded(waiting, 2000)
    expect(retryFence).toBe(2)
    const remaining = (await stores.administrator.query('SELECT greatest(0,extract(epoch FROM (replay_not_after-clock_timestamp()))*1000)::int AS ms,provider_lease_until<=replay_not_after AS bounded FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    expect(remaining.bounded).toBe(true)
    await new Promise(resolve => setTimeout(resolve, remaining.ms + 100))
    expect((await stores.administrator.query('SELECT replay_not_after<=clock_timestamp() AS expired FROM email_delivery WHERE id=$1', [delivery.id])).rows[0].expired).toBe(true)
    release()
    await bounded(pending, 2000)
    expect(peer.evidence().calls).toBe(0)
    const observed = (await stores.administrator.query('SELECT first_attempt_at,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    expect(observed).toEqual(authority)
    stores.evidence[`replayDeadline:${delayAt}`] = { firstFence: first!.fence, retryFence, expiredInDatabase: true, leaseBounded: remaining.bounded, receivedRequests: peer.evidence().calls }
  } finally {
    release(); await transport?.close(); await handler?.stop(); restoreLookup()
    for (const socket of sockets) socket.destroy()
    if (bridge.listening) await new Promise<void>(resolve => bridge.close(() => resolve()))
    await peer.close()
    stores.evidence[`replayPeerCleanup:${delayAt}`] = { origin: peer.origin, peerClosed: true, bridgeClosed: !bridge.listening }
  }
})
test('the first SQL claim remains sendable without any provider replay authority', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const { delivery } = await materialize(600, null, peer.origin)
    const store = createMailStore(owner(stores.mailWorkerUrl))
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler(store, codec, transport)
    expect(await handler.handle({ outboxId: delivery.outboxId }, new AbortController().signal)).toEqual({ state: 'plunk_queued' })
    expect(peer.evidence().calls).toBe(1)
    const state = (await stores.administrator.query('SELECT provider_fence,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    expect(state).toEqual({ provider_fence: 1, replay_not_after: null })
  } finally {
    await transport?.close(); await handler?.stop(); await peer.close()
    stores.evidence.firstAttemptPeerCleanup = { origin: peer.origin, peerClosed: true, receivedRequests: peer.evidence().calls }
  }
})
test('zero-policy execution recovers through SQL after a proven pre-claim rollback, without a local retry loop', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const { delivery } = await materialize(600, null, peer.origin)
    await admitForControlledExecution(delivery.outboxId)
    const physicalOwner = owner(stores.mailWorkerUrl)
    let failOnce = true, transactions = 0
    const store = createMailStore({ ...physicalOwner, withAuthPromise(options, work) {
      return physicalOwner.withAuthPromise(options, async lease => {
        const value = await work(lease)
        transactions++
        if (failOnce) { failOnce = false; throw new Error('private fixture failure before commit') }
        return value
      })
    } })
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler(store, codec, transport)
    const invoke = zeroPolicyInvocation(handler)
    const first = await invoke(delivery.outboxId).then(() => null, error => error)
    expect(first instanceof Error && first.message === 'AUTH_MAIL_CLAIM_UNRESOLVED' && first.cause === undefined).toBe(true)
    expect({ transactions, requests: peer.evidence().calls }).toEqual({ transactions: 1, requests: 0 })
    expect((await stores.administrator.query('SELECT d.provider_state,d.provider_fence,d.first_attempt_at,o.admission_state FROM email_delivery d JOIN auth_email_outbox o ON o.delivery_id=d.id WHERE d.id=$1', [delivery.id])).rows[0]).toEqual({ provider_state: 'unattempted', provider_fence: 0, first_attempt_at: null, admission_state: 'admitted' })
    expect(await invoke(delivery.outboxId)).toEqual({ state: 'plunk_queued' })
    expect(peer.evidence().calls).toBe(1)
    expect(await invoke(delivery.outboxId)).toEqual({ state: 'inert' })
    expect(peer.evidence().calls).toBe(1)
    stores.evidence.i3ProvenRollback = { retriesConfigured: 0, rolledBackMarker: true, initialRequests: 0, finalRequests: 1 }
  } finally { await transport?.close(); await handler?.stop(); await peer.close() }
})
test.each(['before-write', 'after-command-complete'] as const)('zero-policy ambiguous claim %s asks SQL again without inventing no-effect authority', async cut => {
  const peer = await startMailHttpPeer()
  let relay: Awaited<ReturnType<typeof pgRelay>> | undefined
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let firstHandler: ReturnType<typeof createAuthMailHandler> | undefined, nextHandler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const { delivery } = await materialize(600, null, peer.origin)
    await admitForControlledExecution(delivery.outboxId)
    relay = await pgRelay(stores.mailWorkerUrl, cut)
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    firstHandler = createAuthMailHandler(createMailStore(owner(relay.url)), codec, transport)
    const first = await zeroPolicyInvocation(firstHandler)(delivery.outboxId).then(() => null, error => error)
    expect(first instanceof Error && first.message === 'AUTH_MAIL_CLAIM_UNRESOLVED' && first.cause === undefined).toBe(true)
    expect(peer.evidence().calls).toBe(0)
    const before = (await stores.administrator.query('SELECT provider_state,provider_fence,first_attempt_at,snapshot_hash FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    expect(before.provider_state).toBe(cut === 'before-write' ? 'unattempted' : 'attempting')
    expect(before.provider_fence).toBe(cut === 'before-write' ? 0 : 1)
    await firstHandler.stop(); await relay.close(); relay = undefined
    nextHandler = createAuthMailHandler(createMailStore(owner(stores.mailWorkerUrl)), codec, transport)
    const invoke = zeroPolicyInvocation(nextHandler)
    expect(await invoke(delivery.outboxId)).toEqual({ state: cut === 'before-write' ? 'plunk_queued' : 'inert' })
    if (cut === 'after-command-complete') {
      await expireOwnedProviderLease(delivery.id)
      expect(await invoke(delivery.outboxId)).toEqual({ state: 'inert' })
      const after = (await stores.administrator.query('SELECT provider_state,provider_fence,first_attempt_at,snapshot_hash,replay_not_after,ciphertext FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
      expect(after).toEqual({ ...before, provider_state: 'held', replay_not_after: null, ciphertext: null })
    }
    expect(peer.evidence().calls).toBe(cut === 'before-write' ? 1 : 0)
    stores.evidence[`i3ClaimAmbiguity:${cut}`] = { retriesConfigured: 0, initialRequests: 0, markerCommitted: cut === 'after-command-complete', finalRequests: peer.evidence().calls }
  } finally { await transport?.close(); await firstHandler?.stop(); await nextHandler?.stop(); await relay?.close(); await peer.close() }
})
test.each(['false', 'before-write', 'after-command-complete'] as const)('zero-policy unconfirmed finalization %s preserves queued observation and never signals a claim retry', async cut => {
  const peer = await startMailHttpPeer()
  let relay: Awaited<ReturnType<typeof pgRelay>> | undefined
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined, nextHandler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const { delivery } = await materialize(600, null, peer.origin)
    await admitForControlledExecution(delivery.outboxId)
    const healthy = createMailStore(owner(stores.mailWorkerUrl))
    if (cut !== 'false') relay = await pgRelay(stores.mailWorkerUrl, cut)
    const finalizeDelivery = relay ? createMailStore(owner(relay.url)).finalizeDelivery : async () => false
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler({ ...healthy, finalizeDelivery }, codec, transport)
    const result = await zeroPolicyInvocation(handler)(delivery.outboxId)
    expect(result.state === 'effect_unknown' && 'queuedEvidence' in result && result.queuedEvidence === 'response_200' && typeof result.emailId === 'string').toBe(true)
    expect(peer.evidence().calls).toBe(1)
    const before = (await stores.administrator.query('SELECT provider_state,provider_fence,first_attempt_at,plunk_email_id FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    expect(before.provider_state).toBe(cut === 'after-command-complete' ? 'plunk_queued' : 'attempting')
    if (cut === 'after-command-complete') expect('emailId' in result && result.emailId === before.plunk_email_id).toBe(true)
    await handler.stop(); await relay?.close(); relay = undefined
    nextHandler = createAuthMailHandler(healthy, codec, transport)
    await expireOwnedProviderLease(delivery.id)
    expect(await zeroPolicyInvocation(nextHandler)(delivery.outboxId)).toEqual({ state: 'inert' })
    expect(peer.evidence().calls).toBe(1)
    const after = (await stores.administrator.query('SELECT provider_fence,first_attempt_at,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]
    expect(after).toEqual({ provider_fence: before.provider_fence, first_attempt_at: before.first_attempt_at, replay_not_after: null })
    stores.evidence[`i3FinalizeAmbiguity:${cut}`] = { retriesConfigured: 0, queuedObserved: true, persistedQueued: cut === 'after-command-complete', requests: 1, replaySent: false }
  } finally { await transport?.close(); await handler?.stop(); await nextHandler?.stop(); await relay?.close(); await peer.close() }
})
test('zero-policy transport failure after real HTTPS remains effect_unknown with no unqualified resend', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const { delivery } = await materialize(600, null, peer.origin)
    await admitForControlledExecution(delivery.outboxId)
    const store = createMailStore(owner(stores.mailWorkerUrl))
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    const actualTransport = transport
    handler = createAuthMailHandler(store, codec, { async send(...args) { await actualTransport.send(...args); throw new Error('private result loss after HTTP') } })
    const invoke = zeroPolicyInvocation(handler)
    expect(await invoke(delivery.outboxId)).toEqual({ state: 'effect_unknown' })
    expect(await invoke(delivery.outboxId)).toEqual({ state: 'inert' })
    expect(peer.evidence().calls).toBe(1)
    expect((await stores.administrator.query('SELECT provider_state,provider_fence,replay_not_after FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]).toEqual({ provider_state: 'held', provider_fence: 1, replay_not_after: null })
  } finally { await transport?.close(); await handler?.stop(); await peer.close() }
})
test('zero-policy retained SQL claim defers duplicates and capacity until its actual rollback settles', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  let blocking = false
  try {
    const first = await materialize(600, null, peer.origin)
    await admitForControlledExecution(first.delivery.outboxId)
    const second = await materialize(600, null, peer.origin)
    await admitForControlledExecution(second.delivery.outboxId)
    await stores.administrator.query('BEGIN'); blocking = true
    await stores.administrator.query('SELECT id FROM email_delivery WHERE id=$1 FOR UPDATE', [first.delivery.id])
    const actual = createMailStore(owner(stores.mailWorkerUrl))
    let claims = 0, originalSettled = false
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler({ ...actual, async claimDelivery(...args) { claims++; return actual.claimDelivery(...args) } }, codec, transport)
    const invoke = zeroPolicyInvocation(handler)
    const original = invoke(first.delivery.outboxId).then(() => null, error => error).finally(() => { originalSettled = true })
    const same = await invoke(first.delivery.outboxId).then(() => null, error => error)
    const distinct = await invoke(second.delivery.outboxId).then(() => null, error => error)
    expect(same instanceof Error && same.message === 'AUTH_MAIL_OUTBOX_IN_FLIGHT').toBe(true)
    expect(distinct instanceof Error && distinct.message === 'AUTH_MAIL_CAPACITY_BUSY').toBe(true)
    expect({ claims, originalSettled, requests: peer.evidence().calls }).toEqual({ claims: 1, originalSettled: false, requests: 0 })
    const failed = await bounded(original, 4000)
    expect(failed instanceof Error && failed.message === 'AUTH_MAIL_CLAIM_UNRESOLVED' && failed.cause === undefined).toBe(true)
    await stores.administrator.query('ROLLBACK'); blocking = false
    expect((await stores.administrator.query('SELECT provider_fence,first_attempt_at FROM email_delivery WHERE id=$1', [first.delivery.id])).rows[0]).toEqual({ provider_fence: 0, first_attempt_at: null })
    expect(await invoke(first.delivery.outboxId)).toEqual({ state: 'plunk_queued' })
    expect(peer.evidence().calls).toBe(1)
    stores.evidence.i3RetainedClaim = { retriesConfigured: 0, sameOutboxDeferred: true, capacityDeferred: true, originalClaimRolledBack: true, claimsBeforeReceipt: 1, finalRequests: 1 }
  } finally {
    if (blocking) await stores.administrator.query('ROLLBACK')
    await transport?.close(); await handler?.stop(); await peer.close()
  }
})
test('zero-policy retained cancelled DNS work keeps capacity until its actual callback, then another outbox can send', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  let release = () => {}, restoreLookup = () => {}
  try {
    const apiOrigin = peer.origin.replace('127.0.0.1', 'localhost')
    const first = await materialize(600, null, apiOrigin)
    await admitForControlledExecution(first.delivery.outboxId)
    const second = await materialize(600, null, apiOrigin)
    await admitForControlledExecution(second.delivery.outboxId)
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const lookup = dns.lookup
    const spy = vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
      const callback = args[2]
      if (typeof callback !== 'function') throw new Error('Expected owned lookup callback')
      lookup('localhost', { all: true, family: 4 }, (error, addresses) => {
        release = () => { release = () => {}; callback(error, addresses) }
        entered()
      })
    })
    restoreLookup = () => spy.mockRestore()
    transport = createPlunkTransport({ apiOrigin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler(createMailStore(owner(stores.mailWorkerUrl)), codec, transport)
    const invoke = zeroPolicyInvocation(handler), parent = new AbortController()
    let originalSettled = false
    const original = invoke(first.delivery.outboxId, parent.signal).finally(() => { originalSettled = true })
    await bounded(waiting, 2000); parent.abort()
    const same = await invoke(first.delivery.outboxId).then(() => null, error => error)
    const distinct = await invoke(second.delivery.outboxId).then(() => null, error => error)
    expect(same instanceof Error && same.message === 'AUTH_MAIL_OUTBOX_IN_FLIGHT').toBe(true)
    expect(distinct instanceof Error && distinct.message === 'AUTH_MAIL_CAPACITY_BUSY').toBe(true)
    expect({ originalSettled, requests: peer.evidence().calls }).toEqual({ originalSettled: false, requests: 0 })
    expect((await stores.administrator.query('SELECT provider_fence FROM email_delivery WHERE id=$1', [second.delivery.id])).rows[0].provider_fence).toBe(0)
    release(); restoreLookup()
    expect(await original).toEqual({ state: 'effect_unknown' })
    expect(await invoke(second.delivery.outboxId)).toEqual({ state: 'plunk_queued' })
    expect(await invoke(first.delivery.outboxId)).toEqual({ state: 'inert' })
    expect(peer.evidence().calls).toBe(1)
    stores.evidence.i3RetainedDns = { retriesConfigured: 0, abortedParent: true, sameOutboxDeferred: true, capacityDeferred: true, actualCallbackJoined: true, receivedRequests: 1 }
  } finally { release(); await transport?.close(); await handler?.stop(); restoreLookup(); await peer.close() }
})
test('zero-policy SQL refusals and pre-aborted input do not deliberately retry or reach HTTPS', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const stale = await materialize(600, null, peer.origin), terminal = await materialize(600, null, peer.origin)
    const expired = await materialize(1, null, peer.origin), cancelled = await materialize(600, null, peer.origin)
    const web = owner(stores.runtimeUrl)
    await web.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { email: stale.command.recipient, purpose: 'magic-link', locale: 'en', expectedGeneration: stale.command.generation, lifetimeSeconds: 600 }))
    expect(await web.withAuthPromise(options(), lease => retireEmailRequest(lease, terminal.command.requestId, terminal.command.generation, 'terminal'))).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 1100))
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler(createMailStore(owner(stores.mailWorkerUrl)), codec, transport)
    const invoke = zeroPolicyInvocation(handler)
    for (const outboxId of ['invalid', randomUUID(), stale.delivery.outboxId, terminal.delivery.outboxId, expired.delivery.outboxId]) {
      expect(await invoke(outboxId)).toEqual({ state: 'inert' })
    }
    const parent = new AbortController(); parent.abort()
    expect(await invoke(cancelled.delivery.outboxId, parent.signal)).toEqual({ state: 'cancelled' })
    expect(peer.evidence().calls).toBe(0)
    expect((await stores.administrator.query('SELECT provider_fence,first_attempt_at FROM email_delivery WHERE id=$1', [cancelled.delivery.id])).rows[0]).toEqual({ provider_fence: 0, first_attempt_at: null })
    const wrongBinding = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'other-project', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    const refusedBinding = createAuthMailHandler(createMailStore(owner(stores.mailWorkerUrl)), codec, wrongBinding)
    try { expect(await zeroPolicyInvocation(refusedBinding)(cancelled.delivery.outboxId)).toEqual({ state: 'held' }) }
    finally { await wrongBinding.close(); await refusedBinding.stop() }
    expect(peer.evidence().calls).toBe(0)
    stores.evidence.i3ZeroRefusals = { retriesConfigured: 0, malformedMissingStaleTerminalExpiredRefused: true, preAbortedCancelled: true, wrongBindingHeld: true, requests: 0 }
  } finally { await transport?.close(); await handler?.stop(); await peer.close() }
})
test('zero-policy expiry after committed claim but before emission remains non-retryable and sends nothing', async () => {
  const peer = await startMailHttpPeer()
  let transport: ReturnType<typeof createPlunkTransport> | undefined
  let handler: ReturnType<typeof createAuthMailHandler> | undefined
  try {
    const { delivery } = await materialize(1, null, peer.origin)
    const store = createMailStore(owner(stores.mailWorkerUrl))
    let claimed = false
    transport = createPlunkTransport({ apiOrigin: peer.origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_owned_fixture_only') }, { ca: await readFile(peer.certificate, 'utf8') })
    handler = createAuthMailHandler({ ...store, async claimDelivery(...args) {
      const claim = await store.claimDelivery(...args)
      claimed = claim !== null
      await new Promise(resolve => setTimeout(resolve, 1100))
      return claim
    } }, codec, transport)
    expect(await zeroPolicyInvocation(handler)(delivery.outboxId)).toEqual({ state: 'effect_unknown' })
    expect(claimed).toBe(true)
    expect(peer.evidence().calls).toBe(0)
    expect((await stores.administrator.query('SELECT state,provider_fence,ciphertext,verifier_hash FROM email_delivery WHERE id=$1', [delivery.id])).rows[0]).toEqual({ state: 'expired', provider_fence: 1, ciphertext: null, verifier_hash: null })
  } finally { await transport?.close(); await handler?.stop(); await peer.close() }
})
