import { beforeAll, afterAll, expect, test, vi } from 'vitest'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { Pool, Client } from 'pg'
import { Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { pgRelay, type CommitCut } from '../fixtures/db/pg-relay'
import { createTransactions, type AuthTxOptions } from '../../src/platform/db/transactions.server'
import { PgTransactionError, type AuthQueryDb } from '../../src/platform/db/auth-pg-lease.server'
import { user, account, session, verification } from '../../src/modules/auth/schema.server'
import { createAuthAdapter } from '../../src/modules/auth/adapter.server'
import { createWebResources } from '../../src/platform/runtime.server'
import { createClient } from 'redis'
import { createAuthRateLimiter, readRateLimitConfig, RedisInvalid, RedisUnavailable } from '../../src/modules/auth/rate-limit.server'
import { authorizeEmailRequest, materializeDelivery, reconcileAuthorizedObligation, readAuthorizedEmailPayload, retireEmailRequest, purgeExpiredEmailDeliveries } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { withRequiredSignupEmail } from '../../src/modules/auth/signup-obligation.server'
import { readMigrationFiles } from 'drizzle-orm/migrator'

const expectedMigrationHashes = () => readMigrationFiles({ migrationsFolder: './drizzle' }).map(migration => migration.hash)

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let initiallyEmpty = false
beforeAll(async () => {
  stores = await startDisposableStores()
  initiallyEmpty = (await stores.administrator.query("SELECT to_regclass('public.user') IS NULL AS empty")).rows[0].empty
  await stores.migrate()
  await stores.administrator.query(`REVOKE ALL ON DATABASE auth FROM PUBLIC; GRANT CONNECT ON DATABASE auth TO runtime;
    REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public."user",public.session,public.account,public.verification,
      public.auth_email_request,public.auth_email_command,public.email_delivery,public.auth_email_outbox TO runtime;
    CREATE TABLE fixture_tenant (tenant_id uuid NOT NULL CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'), value text NOT NULL);
    ALTER TABLE fixture_tenant ENABLE ROW LEVEL SECURITY; ALTER TABLE fixture_tenant FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_tenant_policy ON fixture_tenant USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    GRANT SELECT ON fixture_tenant TO runtime;
    INSERT INTO fixture_tenant VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'private-fixture-row');
    INSERT INTO "user" (id,name,email) VALUES ('baseline-user','Fixture','baseline@example.test');
    INSERT INTO account (id,account_id,provider_id,user_id) VALUES ('baseline-account','subject','google','baseline-user');
    INSERT INTO session (id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at)
    VALUES ('baseline-session','storage-fixture-not-an-auth-cookie','baseline-user',now()+interval '1 day','MFA_PENDING','google',now(),0,now());`)
})
afterAll(async () => { if (stores) await stores.cleanup() })

const options = (overrides: Partial<AuthTxOptions> = {}): AuthTxOptions => ({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), ...overrides })
function owner(url = stores.runtimeUrl) {
  const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 1000 })
  pool.on('error', () => {})
  const codes: string[] = []
  pool.on('connect', client => client.connection.on('errorMessage', message => codes.push(message.code)))
  return { pool, codes, tx: createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }) }
}
const statusQuery = (db: AuthQueryDb) => db.select({
  pid: sql<number>`pg_backend_pid()`, txid: sql<string>`txid_current()::text`,
  isolation: sql<string>`current_setting('transaction_isolation')`, tenant: sql<string>`current_setting('app.tenant_id')`,
}).from(sql`(select 1) as fixture`).execute()

const emailInput = (changes = {}) => ({ email: `${randomUUID()}@example.test`, purpose: 'magic-link', locale: 'fr', expectedGeneration: 0, lifetimeSeconds: 600, ...changes })
const envelope = () => createAuthEmailEnvelope({ currentKeyId: 'fixture-v1', keys: { 'fixture-v1': randomBytes(32) } })
const mailProfile = { appOrigin: 'https://app.example.test', apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'key-1', from: { name: 'Product', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }

test('materialization seals the final send snapshot rather than token-only delivery bytes', async () => {
  const { tx, pool } = owner(), codec = envelope()
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput()))
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))
    const row = (await stores.administrator.query('SELECT to_jsonb(d)->>\'snapshot_format\' AS format FROM email_delivery d WHERE id=$1', [delivery!.id])).rows[0]
    expect(row.format).toBe('auth-plunk-v1')
  } finally { await pool.end() }
})

test('email immutable command identity and terminal state are enforced by SQL', async () => {
  const { tx, pool } = owner(), codec = envelope()
  try {
    const input = emailInput()
    await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, input))
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { ...input, expectedGeneration: 1 }))
    expect(command.generation).toBe(2)
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))
    await expect(stores.administrator.query('UPDATE email_delivery SET nonce=NULL WHERE id=$1', [delivery!.id])).rejects.toMatchObject({ code: '23514' })
    await expect(stores.administrator.query("UPDATE auth_email_command SET locale='en' WHERE id=$1", [command.id])).rejects.toMatchObject({ code: '23514' })
    await expect(stores.administrator.query('DELETE FROM auth_email_command WHERE id=$1', [command.id])).rejects.toMatchObject({ code: '23514' })
    await expect(stores.administrator.query('UPDATE auth_email_request SET generation=generation-1 WHERE id=$1', [command.requestId])).rejects.toMatchObject({ code: '23514' })
    await tx.withAuthPromise(options(), lease => retireEmailRequest(lease, command.requestId, command.generation, 'terminal'))
    await expect(stores.administrator.query("UPDATE auth_email_request SET state='active' WHERE id=$1", [command.requestId])).rejects.toMatchObject({ code: '23514' })
    await expect(stores.administrator.query("UPDATE email_delivery SET state='active' WHERE id=$1", [delivery!.id])).rejects.toMatchObject({ code: '23514' })
    const flags = (await stores.administrator.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='auth_email_command'::regclass")).rows[0]
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  } finally { await pool.end() }
})

test('email scope has no PUBLIC privileges; tenant sentinel and role cannot access auth records', async () => {
  const { tx, pool } = owner(), runtime = new Client({ connectionString: stores.directRuntimeUrl })
  await runtime.connect()
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput()))
    await runtime.query('BEGIN')
    await runtime.query("SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true)")
    expect((await runtime.query('SELECT id FROM auth_email_command WHERE id=$1', [command.id])).rows).toEqual([])
    await runtime.query('ROLLBACK')
    await stores.administrator.query('CREATE ROLE fixture_email_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO fixture_email_tenant')
    const privileges = (await stores.administrator.query("SELECT has_table_privilege('fixture_email_tenant','auth_email_command','SELECT,INSERT,UPDATE,DELETE') AS allowed")).rows[0]
    expect(privileges.allowed).toBe(false)
    await stores.administrator.query('BEGIN; SET LOCAL ROLE fixture_email_tenant')
    await expect(stores.administrator.query('SELECT id FROM auth_email_command')).rejects.toMatchObject({ code: '42501' })
    await stores.administrator.query('ROLLBACK')
    expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relname IN ('auth_email_request','auth_email_command','email_delivery','auth_email_outbox') AND a.grantee=0")).rows[0].n).toBe(0)
  } finally { await runtime.end(); await pool.end() }
})

test('email outbox insertion failure rolls back verifier and envelope without losing committed obligation', async () => {
  const { tx, pool } = owner(), codec = envelope()
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput()))
    await stores.administrator.query("CREATE FUNCTION public.fixture_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure' USING ERRCODE='23514'; END $$; CREATE TRIGGER fixture_reject_outbox BEFORE INSERT ON public.auth_email_outbox FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_outbox()")
    try { await expect(tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))).rejects.toBeInstanceOf(PgTransactionError) }
    finally { await stores.administrator.query('DROP TRIGGER fixture_reject_outbox ON public.auth_email_outbox; DROP FUNCTION public.fixture_reject_outbox()') }
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM email_delivery WHERE command_id=$1', [command.id])).rows[0].n).toBe(0)
    expect(await tx.withAuthPromise(options(), lease => reconcileAuthorizedObligation(lease, command.id, codec, mailProfile))).not.toBeNull()
  } finally { await pool.end() }
})

test('email request without User or Workspace materializes once and restart repair retains exact payload', async () => {
  const { tx, pool } = owner(), keyConfig = { currentKeyId: 'fixture-v1', keys: { 'fixture-v1': randomBytes(32) } }, codec = createAuthEmailEnvelope(keyConfig)
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput()))
    const [request] = (await stores.administrator.query('SELECT user_id,generation FROM auth_email_request WHERE id=$1', [command.requestId])).rows
    expect(request).toEqual({ user_id: null, generation: 1 })
    const deliveries = await Promise.all(Array.from({ length: 3 }, () => tx.withAuthPromise(options(), lease => reconcileAuthorizedObligation(lease, command.id, codec, mailProfile))))
    expect(new Set(deliveries.map(value => value?.id)).size).toBe(1)
    const delivery = deliveries[0]!
    const payload = await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, delivery.outboxId, codec))
    const restarted = owner()
    const restartedCodec = createAuthEmailEnvelope(keyConfig)
    try {
      const again = await restarted.tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, restartedCodec, { ...mailProfile, apiOrigin: 'https://changed.example.test', from: { ...mailProfile.from, name: 'Changed after restart' } }))
      expect(again?.id).toBe(delivery.id)
      const reread = await restarted.tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, delivery.outboxId, restartedCodec))
      expect(createHmac('sha256', 'fixture-comparison').update(reread!).digest('hex')).toBe(createHmac('sha256', 'fixture-comparison').update(payload!).digest('hex'))
      const verifier = (await stores.administrator.query('SELECT verifier_hash FROM email_delivery WHERE id=$1', [delivery.id])).rows[0].verifier_hash
      const { createHash } = await import('node:crypto')
      const snapshot = JSON.parse(payload!.toString('utf8'))
      const html = JSON.parse(snapshot.requestJson).body as string
      const token = Buffer.from(html.split('#token=')[1]!.split('"')[0]!, 'base64url')
      expect(createHash('sha256').update(token).digest('hex') === verifier).toBe(true)
      token.fill(0)
    } finally { await restarted.pool.end() }
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_outbox WHERE delivery_id=$1', [delivery.id])).rows[0].n).toBe(1)
  } finally { await pool.end() }
})

test('email generation CAS admits one replacement and old delivery stays purged for late jobs', async () => {
  const { tx, pool } = owner(), codec = envelope(), input = emailInput()
  try {
    const first = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, input))
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, first.id, codec, mailProfile))
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { ...input, expectedGeneration: 1 }))))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await tx.withAuthPromise(options(), lease => materializeDelivery(lease, first.id, codec, mailProfile))).toBeNull()
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, delivery!.outboxId, codec))).toBeNull()
    expect((await stores.administrator.query('SELECT state,ciphertext,nonce,tag,verifier_hash FROM email_delivery WHERE id=$1', [delivery!.id])).rows[0]).toEqual({ state: 'superseded', ciphertext: null, nonce: null, tag: null, verifier_hash: null })
  } finally { await pool.end() }
})

test('email operation rollback removes authorization and materialized pair', async () => {
  const { tx, pool } = owner(), codec = envelope(), input = emailInput()
  try {
    await expect(tx.withAuthPromise(options(), async lease => {
      const command = await authorizeEmailRequest(lease, input)
      await materializeDelivery(lease, command.id, codec, mailProfile)
      throw new Error('fixture rollback')
    })).rejects.toThrow('fixture rollback')
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_request WHERE email=$1', [input.email])).rows[0].n).toBe(0)
  } finally { await pool.end() }
})

test('causal signup interception covers root and fresh child, account failure and obligation failure', async () => {
  const { tx, pool } = owner(), adapter = createAuthAdapter(tx, {})
  const policy = { purpose: 'magic-link', locale: 'fr' }
  const create = (email: string) => ({ model: 'user', data: { name: 'Fixture', email, emailVerified: false, createdAt: new Date(), updatedAt: new Date() } })
  const committed = `${randomUUID()}@example.test`, rolledback = `${randomUUID()}@example.test`, invalid = `${randomUUID()}@example.test`, ordinary = `${randomUUID()}@example.test`
  try {
    await tx.runAuthInvocation(options(), () => withRequiredSignupEmail(policy, () => adapter.create(create(committed))))
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command WHERE recipient=$1', [committed])).rows[0].n).toBe(1)
    await expect(tx.runAuthInvocation(options(), () => withRequiredSignupEmail(policy, () => adapter.transaction(async child => {
      await child.create(create(rolledback))
      const rows = await tx.withAuthPromise(tx.invocationOptions(), ({ db }) => db.select({ count: sql<number>`count(*)::int` }).from(sql`auth_email_command`).where(sql`recipient = ${rolledback}`))
      expect(rows[0].count).toBe(1)
      await child.create({ model: 'account', data: { userId: 'absent', accountId: randomUUID(), providerId: 'google' } })
    })))).rejects.toBeInstanceOf(PgTransactionError)
    await expect(tx.runAuthInvocation(options(), () => withRequiredSignupEmail(policy, () => adapter.create({ ...create(invalid), select: ['id'] })))).rejects.toThrow('Signup email policy rejected')
    for (const email of [rolledback, invalid]) {
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [email])).rows[0].n).toBe(0)
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command WHERE recipient=$1', [email])).rows[0].n).toBe(0)
    }
    await tx.runAuthInvocation(options(), () => adapter.create(create(ordinary)))
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command WHERE recipient=$1', [ordinary])).rows[0].n).toBe(0)
    const commandId = (await stores.administrator.query('SELECT id FROM auth_email_command WHERE recipient=$1', [committed])).rows[0].id
    const codec = envelope()
    const repaired = await tx.withAuthPromise(options(), lease => reconcileAuthorizedObligation(lease, commandId, codec, mailProfile))
    expect(repaired).not.toBeNull()
    expect((await tx.withAuthPromise(options(), lease => reconcileAuthorizedObligation(lease, commandId, codec, mailProfile)))?.id).toBe(repaired?.id)
  } finally { await pool.end() }
})

test.each(['fulfilled', 'rejected'])('delayed signup descendant after %s fails in a fresh valid auth invocation', async outcome => {
  const { tx, pool } = owner(), adapter = createAuthAdapter(tx, {}), email = `${randomUUID()}@example.test`
  let release = () => {}
  const barrier = new Promise<void>(resolve => { release = resolve })
  let descendant: Promise<unknown> = Promise.resolve()
  try {
    // Select policy outside ANY transaction/invocation; the delayed child then
    // creates fresh owner options, so stale-owner rejection cannot mask this bug.
    const operation = withRequiredSignupEmail({ purpose: 'magic-link', locale: 'fr' }, async () => {
      descendant = barrier.then(() => tx.runAuthInvocation(options(), () => adapter.create({
        model: 'user', data: { name: 'Fixture', email, emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
      })))
      if (outcome === 'rejected') throw new Error('fixture operation rejected')
    })
    if (outcome === 'rejected') await expect(operation).rejects.toThrow('fixture operation rejected')
    else await operation
    release()
    await expect(descendant.then(() => 'unexpected successful create')).rejects.toThrow('Signup email policy rejected')
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [email])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM auth_email_command WHERE recipient=$1', [email])).rows[0].n).toBe(0)
  } finally { await pool.end() }
})

test('database-issued ten-minute envelope works with lagging app clock and database expiry still purges', async () => {
  const { tx, pool } = owner(), codec = envelope(), actualNow = Date.now
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() - 60000)
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput()))
    expect(command.expiresAt.getTime() - command.createdAt.getTime()).toBe(600000)
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))
    const payload = await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, delivery!.outboxId, codec))
    expect(payload !== null && JSON.parse(payload.toString('utf8')).format === 'auth-plunk-v1').toBe(true)
    const short = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput({ lifetimeSeconds: 1 })))
    const expiring = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, short.id, codec, mailProfile))
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, expiring!.outboxId, codec))).toBeNull()
    expect((await stores.administrator.query('SELECT ciphertext,tag,nonce FROM email_delivery WHERE id=$1', [expiring!.id])).rows[0]).toEqual({ ciphertext: null, tag: null, nonce: null })
  } finally { clock.mockRestore(); await pool.end() }
})

test.each(['read', 'materialize'])('database time is refreshed after blocked delivery acquisition before %s', async operation => {
  const { tx, pool } = owner(), codec = envelope(), actualNow = Date.now
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() - 60000)
  let locked = false
  let pending: Promise<{ ok: boolean; empty: boolean }> | undefined
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput({ lifetimeSeconds: 1 })))
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))
    await stores.administrator.query('BEGIN')
    locked = true
    await stores.administrator.query('SELECT id FROM email_delivery WHERE id=$1 FOR UPDATE', [delivery!.id])
    // Keep the subsequent row-lock wait below the owner's one-second statement
    // bound while ensuring it crosses the database-issued expiration.
    await stores.administrator.query("SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp()))-0.5))", [command.expiresAt])
    pending = tx.withAuthPromise(options(), async lease => operation === 'read'
      ? await readAuthorizedEmailPayload(lease, delivery!.outboxId, codec) === null
      : await materializeDelivery(lease, command.id, codec, mailProfile) === null).then(empty => ({ ok: true, empty }), () => ({ ok: false, empty: false }))
    let waiting = false
    for (let attempt = 0; attempt < 20; attempt++) {
      await stores.administrator.query('SELECT pg_stat_clear_snapshot()')
      waiting = (await stores.administrator.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND cardinality(pg_blocking_pids(pid))>0) AS waiting")).rows[0].waiting
      if (waiting) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(waiting).toBe(true)
    await stores.administrator.query("SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.05)", [command.expiresAt])
    await stores.administrator.query('COMMIT')
    locked = false
    expect(await pending).toEqual({ ok: true, empty: true })
    expect((await stores.administrator.query('SELECT ciphertext,tag,nonce FROM email_delivery WHERE id=$1', [delivery!.id])).rows[0]).toEqual({ ciphertext: null, tag: null, nonce: null })
  } finally {
    if (locked) await stores.administrator.query('ROLLBACK')
    await pending
    clock.mockRestore()
    await pool.end()
  }
})

test('user association preserves request generation; recovery checks add to request authority', async () => {
  const { tx, pool } = owner(), codec = envelope(), input = emailInput()
  try {
    const first = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, input))
    const id = randomUUID()
    await stores.administrator.query('INSERT INTO "user" (id,name,email) VALUES ($1,\'Fixture\',$2)', [id, input.email])
    await stores.administrator.query('UPDATE auth_email_request SET user_id=$1 WHERE id=$2', [id, first.requestId])
    expect((await stores.administrator.query('SELECT generation FROM auth_email_request WHERE id=$1', [first.requestId])).rows[0].generation).toBe(1)
    const next = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { ...input, expectedGeneration: 1, userId: id, recoveryGeneration: 0 }))
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, next.id, codec, mailProfile))
    await stores.administrator.query('UPDATE "user" SET recovery_generation=1 WHERE id=$1', [id])
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, delivery!.outboxId, codec))).toBeNull()
    expect(await tx.withAuthPromise(options(), lease => materializeDelivery(lease, next.id, codec, mailProfile))).toBeNull()
  } finally { await pool.end() }
})

test('consumption terminality and expired restored payload cannot regain authority', async () => {
  const { tx, pool } = owner(), codec = envelope()
  try {
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput()))
    const delivery = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))
    expect(await tx.withAuthPromise(options(), lease => retireEmailRequest(lease, command.requestId, command.generation, 'consumed'))).toBe(true)
    expect(await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))).toBeNull()
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, delivery!.outboxId, codec))).toBeNull()
    const short = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, emailInput({ lifetimeSeconds: 1 })))
    const expired = await tx.withAuthPromise(options(), lease => materializeDelivery(lease, short.id, codec, mailProfile))
    const saved = (await stores.administrator.query('SELECT ciphertext,tag,nonce FROM email_delivery WHERE id=$1', [expired!.id])).rows[0]
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await tx.withAuthPromise(options(), lease => purgeExpiredEmailDeliveries(lease))).toBeGreaterThanOrEqual(1)
    expect((await stores.administrator.query('SELECT ciphertext,tag,nonce FROM email_delivery WHERE id=$1', [expired!.id])).rows[0]).toEqual({ ciphertext: null, tag: null, nonce: null })
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, expired!.outboxId, codec))).toBeNull()
    // Simulate restored material without granting current authority or editing immutable expiration.
    await stores.administrator.query('ALTER TABLE public.email_delivery DISABLE TRIGGER auth_email_delivery_guard')
    try { await stores.administrator.query('UPDATE email_delivery SET ciphertext=$2,tag=$3,nonce=$4 WHERE id=$1', [expired!.id, saved.ciphertext, saved.tag, saved.nonce]) }
    finally { await stores.administrator.query('ALTER TABLE public.email_delivery ENABLE TRIGGER auth_email_delivery_guard') }
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, expired!.outboxId, codec))).toBeNull()
    expect((await stores.administrator.query('SELECT ciphertext,tag,nonce FROM email_delivery WHERE id=$1', [expired!.id])).rows[0]).toEqual({ ciphertext: null, tag: null, nonce: null })
    expect(await tx.withAuthPromise(options(), lease => readAuthorizedEmailPayload(lease, randomUUID(), codec))).toBeNull()
  } finally { await pool.end() }
})

test('unmaterialized user-bound command rejected during recovery stays revoked after state restoration', async () => {
  const { tx, pool } = owner(), codec = envelope(), input = emailInput(), id = randomUUID()
  try {
    await stores.administrator.query('INSERT INTO "user" (id,name,email) VALUES ($1,\'Fixture\',$2)', [id, input.email])
    const command = await tx.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { ...input, userId: id, recoveryGeneration: 0 }))
    await stores.administrator.query('UPDATE "user" SET recovering=true WHERE id=$1', [id])
    expect(await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))).toBeNull()
    await stores.administrator.query('UPDATE "user" SET recovering=false WHERE id=$1', [id])
    expect(await tx.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, mailProfile))).toBeNull()
  } finally { await pool.end() }
})

test('fresh native migration runs on the owned PostgreSQL 16.15 database', async () => {
  expect(initiallyEmpty).toBe(true)
  const version = (await stores.administrator.query("SELECT current_setting('server_version_num') AS version")).rows[0].version
  expect(version).toBe('160015')
  const migrations = (await stores.administrator.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows.map(row => row.hash)
  expect(migrations).toEqual(expectedMigrationHashes())
  stores.evidence.postgresVersion = version
  const admin = await stores.poolAdmin()
  try {
    const config = await admin.query('SHOW CONFIG')
    expect(config.rows.find(row => row.key === 'pool_mode')?.value).toBe('transaction')
    expect(config.rows.find(row => row.key === 'max_prepared_statements')?.value).toBe('0')
    stores.evidence.poolMode = 'transaction'
    stores.evidence.preparedStatements = 'unnamed only; max_prepared_statements=0'
    stores.evidence.pgbouncerVersion = await stores.command(stores.pool, ['/usr/bin/pgbouncer', '--version'])
    stores.evidence.redisVersion = await stores.command(stores.redis, ['redis-server', '--version'])
  } finally { await admin.end() }
})

test('migration rerun preserves table identity, migration identity and existing data', async () => {
  const before = (await stores.administrator.query(`SELECT 'public.user'::regclass::oid AS oid, (SELECT array_agg(hash ORDER BY id) FROM drizzle.__drizzle_migrations) AS hash`)).rows[0]
  await stores.migrate()
  const after = (await stores.administrator.query(`SELECT 'public.user'::regclass::oid AS oid, (SELECT array_agg(hash ORDER BY id) FROM drizzle.__drizzle_migrations) AS hash`)).rows[0]
  expect(after).toEqual(before)
  expect((await stores.administrator.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows.map(row => row.hash)).toEqual(expectedMigrationHashes())
  expect((await stores.administrator.query('SELECT name FROM "user" WHERE id=$1', ['baseline-user'])).rows[0].name).toBe('Fixture')
})

test('runtime role grants and real startup reject ownership bypass and attest durability', async () => {
  const runtime = new Client({ connectionString: stores.directRuntimeUrl })
  await runtime.connect()
  try {
    const role = (await runtime.query(`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolreplication FROM pg_roles WHERE rolname=current_user`)).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false })
    expect((await runtime.query(`SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)`)).rows[0].count).toBe(0)
    const grants = (await runtime.query(`SELECT has_schema_privilege(current_user,'public','CREATE') AS create_schema, has_table_privilege(current_user,'public.user','TRUNCATE') AS truncate, has_table_privilege(current_user,'public.user','SELECT,INSERT,UPDATE,DELETE') AS dml`)).rows[0]
    expect(grants).toEqual({ create_schema: false, truncate: false, dml: true })
    expect((await runtime.query("SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS fpw,current_setting('synchronous_commit') AS commit")).rows[0]).toEqual({ fsync: 'on', fpw: 'on', commit: 'on' })
  } finally { await runtime.end() }
  const configured = createWebResources({ DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'integration', TRUSTED_PROXY_IPS: '127.0.0.2' })
  try { expect((await configured.ready()).isReady()).toBe(true) } finally { await configured.dispose() }
})

test('actual Effect/Promise/adapter nesting shares physical transaction, RC, sentinel and unnamed statements', async () => {
  const relay = await pgRelay(stores.runtimeUrl)
  const { tx, pool } = owner(relay.url)
  const adapter = createAuthAdapter(tx, {})
  const opts = options()
  try {
    const result = await Effect.runPromise(tx.withAuthTransaction(opts, tx.invokeAuthPromise(opts, async () => {
      const first = await tx.withAuthPromise(opts, ({ db }) => statusQuery(db))
      const record = await adapter.findOne<{ id: string }>({ model: 'user', where: [{ field: 'id', value: 'baseline-user' }], select: ['id'] })
      const second = await tx.withAuthPromise(opts, ({ db }) => statusQuery(db))
      return { first: first[0], second: second[0], record }
    })))
    expect(result.first).toEqual(result.second)
    expect(result.first).toMatchObject({ isolation: 'read committed', tenant: '00000000-0000-0000-0000-000000000000' })
    expect(result.record).toEqual({ id: 'baseline-user' })
    expect(relay.controls).toEqual(['BEGIN', 'COMMIT'])
    expect(relay.preparedNames.length).toBeGreaterThan(0)
    expect(relay.preparedNames.every(name => name === '')).toBe(true)
  } finally { await pool.end(); await relay.close() }
})

test('poisoned pooled backend is reset to sentinel before the auth handle sees RLS rows', async () => {
  const poison = new Client({ connectionString: stores.runtimeUrl })
  await poison.connect()
  const poisoned = (await poison.query("SELECT pg_backend_pid() AS pid,set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false)")).rows[0].pid
  await poison.end()
  const { tx, pool } = owner()
  try {
    await tx.withAuthPromise(options(), async ({ db }) => {
      const [status] = await statusQuery(db)
      expect(status.pid).toBe(poisoned)
      expect(status.tenant).toBe('00000000-0000-0000-0000-000000000000')
      expect(await db.select().from(sql`fixture_tenant`)).toEqual([])
    })
  } finally { await pool.end() }
})

const sessionFixture = () => ({ id: randomUUID(), token: randomUUID(), userId: 'baseline-user', expiresAt: new Date(Date.now() + 10000), authState: 'MFA_PENDING', authMethod: 'google', authenticatedAt: new Date(), recoveryGeneration: 0, lastActivityAt: new Date() })
const constraintCases: { name: string; code: string; run(db: AuthQueryDb): Promise<unknown> }[] = [
  { name: 'required user name', code: '23502', run: db => db.insert(user).values({ id: randomUUID(), name: sql`NULL`, email: `${randomUUID()}@example.test` }).execute() },
  { name: 'unique email', code: '23505', run: db => db.insert(user).values({ id: randomUUID(), name: 'Fixture', email: 'baseline@example.test' }).execute() },
  { name: 'nonnegative generation', code: '23514', run: db => db.insert(user).values({ id: randomUUID(), name: 'Fixture', email: `${randomUUID()}@example.test`, recoveryGeneration: -1 }).execute() },
  { name: 'account foreign key', code: '23503', run: db => db.insert(account).values({ id: randomUUID(), accountId: randomUUID(), providerId: 'google', userId: 'absent' }).execute() },
  { name: 'account provider identity uniqueness', code: '23505', run: db => db.insert(account).values({ id: randomUUID(), accountId: 'subject', providerId: 'google', userId: 'baseline-user' }).execute() },
  { name: 'account foreign provider', code: '23514', run: db => db.insert(account).values({ id: randomUUID(), accountId: randomUUID(), providerId: 'other', userId: 'baseline-user' }).execute() },
  { name: 'password disabled', code: '23514', run: db => db.insert(account).values({ id: randomUUID(), accountId: randomUUID(), providerId: 'google', userId: 'baseline-user', password: 'forbidden-test-value' }).execute() },
  { name: 'required session auth state', code: '23502', run: db => db.insert(session).values({ ...sessionFixture(), authState: sql`NULL` }).execute() },
  { name: 'session auth state check', code: '23514', run: db => db.insert(session).values({ ...sessionFixture(), authState: 'invalid' }).execute() },
  { name: 'session method check', code: '23514', run: db => db.insert(session).values({ ...sessionFixture(), authMethod: 'password' }).execute() },
  { name: 'session generation check', code: '23514', run: db => db.insert(session).values({ ...sessionFixture(), recoveryGeneration: -1 }).execute() },
  { name: 'session foreign key', code: '23503', run: db => db.insert(session).values({ ...sessionFixture(), userId: 'absent' }).execute() },
  { name: 'unique session token', code: '23505', run: db => db.insert(session).values({ ...sessionFixture(), token: 'storage-fixture-not-an-auth-cookie' }).execute() },
  { name: 'required verification identifier', code: '23502', run: db => db.insert(verification).values({ id: randomUUID(), identifier: sql`NULL`, value: 'storage-fixture', expiresAt: new Date() }).execute() },
]
test.each(constraintCases)('real $name violation rolls back and reuses only idle connection', async item => {
  const { tx, pool, codes } = owner()
  try {
    await expect(tx.withAuthPromise(options(), ({ db }) => item.run(db))).rejects.toBeInstanceOf(PgTransactionError)
    expect(codes).toContain(item.code)
    expect(pool.idleCount).toBe(1)
    const client = await pool.connect()
    expect(client.getTransactionStatus()).toBe('I'); client.release()
    expect((await tx.withAuthPromise(options(), ({ db }) => statusQuery(db)))[0].isolation).toBe('read committed')
  } finally { await pool.end() }
})

test('concurrent actual adapter increments do not lose updates', async () => {
  const { tx, pool } = owner()
  const adapter = createAuthAdapter(tx, { user: { additionalFields: { recoveryGeneration: { type: 'number', input: false } } } })
  try {
    await Promise.all(Array.from({ length: 8 }, () => tx.runAuthInvocation(options(), () => adapter.incrementOne({ model: 'user', where: [{ field: 'id', value: 'baseline-user' }], increment: { recoveryGeneration: 1 } }))))
    expect((await stores.administrator.query('SELECT recovery_generation FROM "user" WHERE id=$1', ['baseline-user'])).rows[0].recovery_generation).toBe(8)
  } finally { await pool.end() }
})

test('real adapter CRUD and fresh transaction child preserve all native data methods', async () => {
  const { tx, pool } = owner()
  const adapter = createAuthAdapter(tx, {})
  const id = randomUUID(), secondId = randomUUID()
  const invoke = <A>(call: () => Promise<A>) => tx.runAuthInvocation(options(), call)
  const where = [{ field: 'id', value: id }]
  try {
    await invoke(() => adapter.create({ model: 'user', data: { id, name: 'CRUD', email: `${id}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() }, forceAllowId: true }))
    expect(await invoke(() => adapter.count({ model: 'user', where }))).toBe(1)
    expect(await invoke(() => adapter.findMany({ model: 'user', where, select: ['id'] }))).toEqual([{ id }])
    await invoke(() => adapter.update({ model: 'user', where, update: { name: 'Updated' } }))
    expect(await invoke(() => adapter.updateMany({ model: 'user', where, update: { name: 'Many' } }))).toBe(1)
    expect(await invoke(() => adapter.transaction(child => child.findOne({ model: 'user', where, select: ['name'] })))).toEqual({ name: 'Many' })
    expect(await invoke(() => adapter.consumeOne({ model: 'user', where }))).toMatchObject({ id })
    expect(await invoke(() => adapter.count({ model: 'user', where }))).toBe(0)
    for (const key of [id, secondId]) await invoke(() => adapter.create({ model: 'user', data: { id: key, name: 'Delete', email: `${key}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() }, forceAllowId: true }))
    await invoke(() => adapter.delete({ model: 'user', where }))
    expect(await invoke(() => adapter.deleteMany({ model: 'user', where: [{ field: 'id', value: secondId }] }))).toBe(1)
  } finally { await pool.end() }
})

test('real user deletion cascades only to its account and session storage fixtures', async () => {
  const { tx, pool } = owner(), id = randomUUID()
  try {
    await tx.withAuthPromise(options(), async ({ db }) => {
      await db.insert(user).values({ id, name: 'Cascade', email: `${id}@example.test` })
      await db.insert(account).values({ id, accountId: id, providerId: 'google', userId: id })
      await db.insert(session).values({ ...sessionFixture(), id, userId: id })
    })
    await tx.withAuthPromise(options(), async ({ db }) => { await db.delete(user).where(eq(user.id, id)) })
    const counts = (await stores.administrator.query('SELECT (SELECT count(*)::int FROM account WHERE user_id=$1) AS accounts,(SELECT count(*)::int FROM session WHERE user_id=$1) AS sessions', [id])).rows[0]
    expect(counts).toEqual({ accounts: 0, sessions: 0 })
    expect((await stores.administrator.query("SELECT count(*)::int AS count FROM session WHERE id='baseline-session'")).rows[0].count).toBe(1)
  } finally { await pool.end() }
})

test('actual statement timeout rolls back cleanly, and finalization drains admitted SQL', async () => {
  const { tx, pool, codes } = owner()
  try {
    await expect(tx.withAuthPromise(options({ statementTimeoutMs: 40 }), ({ db }) => db.select({ slept: sql`pg_sleep(1)` }).from(sql`(select 1) fixture`).execute())).rejects.toBeInstanceOf(PgTransactionError)
    expect(codes).toContain('57014')
    expect(pool.idleCount).toBe(1)
    let admitted: Promise<unknown> | undefined
    let settled = false
    const start = performance.now()
    await tx.withAuthPromise(options(), async ({ db }) => {
      admitted = db.select({ slept: sql`pg_sleep(0.1)` }).from(sql`(select 1) fixture`).execute().finally(() => { settled = true })
    })
    expect(settled).toBe(true)
    expect(performance.now() - start).toBeGreaterThanOrEqual(90)
    await admitted
  } finally { await pool.end() }
})

test('request abort destroys a hung physical lease within cleanup and does not commit its write', async () => {
  const { tx, pool } = owner()
  const signal = new AbortController()
  const id = randomUUID()
  const result = tx.withAuthPromise(options({ signal: signal.signal, cleanupTimeoutMs: 100 }), async ({ db }) => {
    await db.insert(user).values({ id, name: 'Aborted', email: `${id}@example.test` })
    await db.select({ slept: sql`pg_sleep(1)` }).from(sql`(select 1) fixture`)
  }).catch(error => error)
  try {
    await expect.poll(async () => (await stores.administrator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='runtime' AND state='active' AND query LIKE '%pg_sleep(1)%'")).rows[0].n).toBe(1)
    const start = performance.now()
    signal.abort()
    expect(await result).toBeInstanceOf(PgTransactionError)
    expect(performance.now() - start).toBeLessThan(500)
    expect(pool.totalCount).toBe(0)
    expect((await tx.withAuthPromise(options(), ({ db }) => db.select({ id: user.id }).from(user).where(eq(user.id, id)))).length).toBe(0)
  } finally { signal.abort(); await result; await pool.end() }
})

test('actual ErrorResponse precedes ReadyForQuery but lease cannot release or rollback early', async () => {
  const relay = await pgRelay(stores.runtimeUrl, 'delay-error-ready')
  const { tx, pool, codes } = owner(relay.url)
  let settled = false
  const result = tx.withAuthPromise(options(), ({ db }) => db.select({ value: sql<number>`1/0` }).from(sql`(select 1) fixture`).execute()).catch(error => error).finally(() => { settled = true })
  try {
    await expect.poll(relay.errorResponses).toBe(1)
    expect(codes).toContain('22012')
    expect(settled).toBe(false)
    expect(pool.idleCount).toBe(0)
    expect(relay.controls).toEqual(['BEGIN'])
    relay.releaseReady()
    expect(await result).toBeInstanceOf(PgTransactionError)
    expect(relay.controls).toEqual(['BEGIN', 'ROLLBACK'])
    expect(pool.idleCount).toBe(1)
  } finally { relay.releaseReady(); await result; await pool.end(); await relay.close() }
})

test.each(['before-write', 'after-write', 'before-command-complete', 'after-command-complete'] as const)('actual COMMIT cut %s evicts ambiguity and reconciles without replay', async (cut: CommitCut) => {
  const relay = await pgRelay(stores.runtimeUrl, cut)
  const { tx, pool } = owner(relay.url)
  const id = randomUUID()
  let nativeCommit = 0
  pool.on('connect', client => client.connection.on('commandComplete', message => { if (message.text === 'COMMIT') nativeCommit++ }))
  try {
    const failure = await tx.withAuthPromise(options(), ({ db }) => db.insert(user).values({ id, name: 'Cut fixture', email: `${id}@example.test` }).execute()).catch(error => error)
    expect(failure).toBeInstanceOf(PgTransactionError)
    expect(failure).toMatchObject({ outcome: 'unknown' })
    expect(pool.totalCount).toBe(0)
    expect(relay.controls.filter(command => command === 'COMMIT')).toHaveLength(1)
    const count = (await stores.administrator.query('SELECT count(*)::int AS count FROM "user" WHERE id=$1', [id])).rows[0].count
    if (cut === 'before-write') expect(count).toBe(0)
    if (cut === 'before-command-complete' || cut === 'after-command-complete') expect(count).toBe(1)
    if (cut === 'after-command-complete') expect(nativeCommit).toBe(1)
    stores.evidence[`commitCut:${cut}`] = { outcome: 'unknown', persisted: count, nativeCommit }
  } finally { await pool.end(); await relay.close() }
})

function limiter(url = stores.redisUrl, commandMs = 500) {
  return createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: url, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'integration', TRUSTED_PROXY_IPS: '127.0.0.2', REDIS_COMMAND_TIMEOUT_MS: String(commandMs) }))
}
const redisKey = (key: string) => 'rl:v1:test:integration:' + createHmac('sha256', stores.hmac).update(key).digest('hex')
async function observer() {
  const client = createClient({ url: stores.redisUrl, socket: { connectTimeout: 1000, reconnectStrategy: false } })
  client.on('error', () => {})
  await client.connect()
  return client
}

test('real static Lua counts denies, renews only allows, and expires the shared key', async () => {
  const limited = limiter(), redis = await observer(), key = randomUUID()
  await limited.connect()
  try {
    expect(await limited.customStorage.consume(key, { window: 0.6, max: 2 })).toEqual({ allowed: true, retryAfter: null })
    await new Promise(resolve => setTimeout(resolve, 100))
    const beforeAllow = await redis.pTTL(redisKey(key))
    expect(await limited.customStorage.consume(key, { window: 0.6, max: 2 })).toEqual({ allowed: true, retryAfter: null })
    const renewed = await redis.pTTL(redisKey(key))
    expect(renewed).toBeGreaterThan(beforeAllow + 50)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await limited.customStorage.consume(key, { window: 0.6, max: 2 })).toEqual({ allowed: false, retryAfter: 1 })
    const deniedTtl = await redis.pTTL(redisKey(key))
    expect(deniedTtl).toBeLessThan(renewed - 50)
    expect(await redis.get(redisKey(key))).toBe('3')
    await limited.customStorage.consume(key, { window: 0.6, max: 2 })
    expect(await redis.get(redisKey(key))).toBe('4')
    expect(await redis.pTTL(redisKey(key))).toBeLessThanOrEqual(deniedTtl)
    await expect.poll(() => redis.get(redisKey(key)), { timeout: 1500 }).toBeNull()
    expect((await limited.customStorage.consume(key, { window: 0.6, max: 2 })).allowed).toBe(true)
    expect(await redis.get(redisKey(key))).toBe('1')
  } finally { await limited.close(); await redis.close() }
})

test('two actual limiter replicas admit exactly three concurrent attempts and count all attempts', async () => {
  const first = limiter(), second = limiter(), redis = await observer(), key = randomUUID()
  await Promise.all([first.connect(), second.connect()])
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).customStorage.consume(key, { window: 10, max: 3 })))
    expect(results.filter(result => result.allowed)).toHaveLength(3)
    expect(await redis.get(redisKey(key))).toBe('12')
  } finally { await first.close(); await second.close(); await redis.close() }
})

test('real Redis script errors and invalid missing TTL remain sanitized 500', async () => {
  const limited = limiter(), redis = await observer()
  await limited.connect()
  try {
    for (const value of ['not-an-integer', '9223372036854775807', '10']) {
      const key = randomUUID()
      await redis.set(redisKey(key), value)
      const failure = await limited.customStorage.consume(key, { window: 10, max: 3 }).catch(error => error)
      expect(failure).toBeInstanceOf(RedisInvalid)
      expect(limited.errorResponse(failure)?.status).toBe(500)
      expect(failure).not.toHaveProperty('cause')
    }
  } finally { await limited.close(); await redis.close() }
})

test('actual Redis ACL rejection maps to 500 with no counter mutation', async () => {
  const redis = await observer(), key = randomUUID(), username = `fixture-${randomUUID()}`, password = randomBytes(32).toString('hex')
  try { await redis.sendCommand(['ACL', 'SETUSER', username, 'on', `>${password}`, '~rl:v1:*', '+ping', '+client']) }
  catch { await redis.close(); throw new Error('Fixture ACL setup failed') }
  const url = new URL(stores.redisUrl); url.username = username; url.password = password
  const limited = limiter(url.href)
  try {
    await limited.connect()
    const failure = await limited.customStorage.consume(key, { window: 10, max: 3 }).catch(error => error)
    expect(failure).toBeInstanceOf(RedisInvalid)
    expect(limited.errorResponse(failure)?.status).toBe(500)
    expect(await redis.get(redisKey(key))).toBeNull()
    expect(String(failure)).not.toContain(password)
  } finally { await limited.close(); await redis.sendCommand(['ACL', 'DELUSER', username]); await redis.close() }
})

// The live proxy and its discriminating regressions use this same counter.
// It retains the existing fixture's EVAL marker, not a new RESP parser.
function evalWireCounter() {
  let total = 0
  return {
    value: () => total,
    connection() {
      let input = '', countedEvals = 0
      return (chunk: Buffer | string) => {
        input += chunk.toString()
        const count = [...input.matchAll(/\r\nEVAL\r\n/g)].length
        total += count - countedEvals
        countedEvals = count
        return count > 0
      }
    },
  }
}

const evalFrame = '*3\r\n$4\r\nEVAL\r\n$8\r\nreturn 1\r\n$1\r\n0\r\n'
test.each([
  { scenario: 'fragmented EVAL and trailing PING', connections: [[...evalFrame, '*1\r\n$4\r\nPING\r\n']], expected: 1 },
  { scenario: 'two EVALs on one connection', connections: [[evalFrame, evalFrame]], expected: 2 },
  { scenario: 'one EVAL on each of two connections', connections: [[evalFrame], [evalFrame]], expected: 2 },
])('fixture EVAL total counts $scenario', ({ connections, expected }) => {
  const counter = evalWireCounter()
  for (const chunks of connections) {
    const countChunk = counter.connection()
    for (const chunk of chunks) countChunk(chunk)
  }
  expect(counter.value()).toBe(expected)
})

test('lost actual EVAL response is ambiguous, never replayed, and reconciles to one increment', async () => {
  const target = new URL(stores.redisUrl), sockets = new Set<Socket>()
  const counter = evalWireCounter()
  let responseObserved = false
  const proxy = createServer(client => {
    const upstream = createConnection({ host: '127.0.0.1', port: Number(target.port) })
    const countChunk = counter.connection()
    let evalWritten = false
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy() }) }
    client.on('data', chunk => {
      if (countChunk(chunk)) evalWritten = true
      upstream.write(chunk)
    })
    upstream.on('data', chunk => { if (evalWritten) { responseObserved = true; return }; client.write(chunk) })
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('Missing Redis proxy port')
  const url = new URL(stores.redisUrl); url.port = String(address.port)
  const limited = limiter(url.href, 150), redis = await observer(), key = randomUUID()
  try {
    await limited.connect()
    const failure = await limited.customStorage.consume(key, { window: 10, max: 3 }).catch(error => error)
    expect(failure).toBeInstanceOf(RedisUnavailable)
    expect(responseObserved).toBe(true)
    expect(counter.value()).toBe(1)
    expect(await redis.get(redisKey(key))).toBe('1')
    await expect(limited.customStorage.consume(key, { window: 10, max: 3 })).rejects.toBeInstanceOf(RedisUnavailable)
    expect(counter.value()).toBe(1)
    expect(await redis.get(redisKey(key))).toBe('1')
  } finally { await limited.close(); await redis.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())) }
})

test('owned Redis restart is observed as unavailable and a fresh client can resume', async () => {
  const limited = limiter()
  await limited.connect()
  try {
    await stores.restartRedis(async () => {
      await expect.poll(limited.isReady).toBe(false)
      const failure = await limited.customStorage.consume(randomUUID(), { window: 10, max: 3 }).catch(error => error)
      expect(failure).toBeInstanceOf(RedisUnavailable)
      expect(limited.errorResponse(failure)?.status).toBe(503)
    })
    const fresh = limiter()
    try { await fresh.connect(); expect((await fresh.customStorage.consume(randomUUID(), { window: 10, max: 3 })).allowed).toBe(true) }
    finally { await fresh.close() }
  } finally { await limited.close() }
})

test.each(['SIGTERM', 'SIGINT'] as const)('Linux Node 24.14.0 receives real %s, drains and releases its store connections', async signal => {
  const redis = await observer()
  const redisClientsBefore = (await redis.clientList()).length
  const web = await stores.startWeb(signal.toLowerCase(), 800)
  expect((await stores.command(web.id, ['node', '--version'])).trim()).toBe('v24.14.0')
  const admin = await stores.poolAdmin()
  try {
    expect((await admin.query('SHOW CLIENTS')).rows.filter(row => row.user === 'runtime').length).toBeGreaterThan(0)
    expect((await redis.clientList()).length).toBe(redisClientsBefore + 1)
    const stream = await fetch(`${web.url}/__fixture_stream`)
    let settled = false
    const finished = stream.text().then(text => { settled = true; return text })
    await stores.signalWeb(web.id, signal)
    expect(settled).toBe(false)
    expect(await finished).toBe('startedfinished')
    expect(await stores.waitWeb(web.id)).toBe(0)
    await expect.poll(async () => (await admin.query('SHOW CLIENTS')).rows.filter(row => row.user === 'runtime').length).toBe(0)
    await expect.poll(async () => (await redis.clientList()).length).toBe(redisClientsBefore)
    stores.evidence[`linux:${signal}`] = { node: '24.14.0', exit: 0, drainedAfterSignal: true, poolClientsAfter: 0, redisClientsReleased: true }
  } finally { await admin.end(); await redis.close() }
})

test('Linux forced shutdown closes a stalled response at the configured grace limit', async () => {
  const web = await stores.startWeb('forced', 10000)
  const stream = await fetch(`${web.url}/__fixture_stream`)
  const result = stream.text().then(() => 'complete', () => 'cut')
  const start = performance.now()
  await stores.signalWeb(web.id, 'SIGTERM')
  expect(await result).toBe('cut')
  expect(await stores.waitWeb(web.id)).toBe(0)
  expect(performance.now() - start).toBeGreaterThanOrEqual(800)
  expect(performance.now() - start).toBeLessThan(4000)
})
