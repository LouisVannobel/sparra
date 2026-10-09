import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let activity: ReturnType<typeof createActivityOperations>
let personal: ReturnType<typeof createPersonalWorkspaces>
let auth: ReturnType<typeof createApplicationAuth>
let limiter: ReturnType<typeof createAuthRateLimiter>
let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>
let ceremony: ReturnType<typeof googleCeremony>
let qualified: Awaited<ReturnType<typeof ownerFixture>>, foreign: typeof qualified
let oldContract: typeof qualified, disabledLocal: typeof qualified

const input = (expectedRevision = 0) => ({
  expectedRevision, businessName: 'Local audio fixture', sector: 'garage',
  knowledge: { openingHours: '', services: 'Observed service', prices: '', faq: '', instructions: '' },
  transferDestination: null,
})
const admin = (sql: string, values?: unknown[]) => stores.administrator.query(sql, values)
const revisions = async (workspaceId: string) => (await admin(
  'SELECT revision,business_name,recording_enabled FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision',
  [workspaceId],
)).rows

async function ownerFixture() {
  const { principal } = await ceremony()
  const workspace = await personal.ensurePersonalWorkspace(principal)
  expect(workspace).not.toBeNull()
  return { principal, workspace: workspace! }
}

const localInput = (revision = 0) => ({
  ...input(revision), recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789',
})
async function qualifiedOn() {
  const revision = (await activity.read(qualified.principal)).configuration?.revision ?? 0
  const saved = await activity.save(qualified.principal, localInput(revision))
  expect(saved).not.toBeNull()
  return saved!
}
async function available(tenant: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant])
    return (await client.query('SELECT public.sparra_local_audio_available_v1() available')).rows[0].available
  } finally { await client.query('ROLLBACK'); client.release() }
}

beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrate()
  await admin('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  peer = await startGoogleProtocolPeer({
    ports: [3000, ...[stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(url => Number(new URL(url).port))],
  })
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 3 })
  const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const { createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server')
  limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'local-audio-policy', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test',
  }))
  await limiter.connect()
  auth = createApplicationAuth(owner, readAuthConfig({
    APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only',
  })!, limiter)
  ceremony = googleCeremony(auth, owner, peer)
  personal = createPersonalWorkspaces(owner)
  activity = createActivityOperations(owner)
  qualified = await ownerFixture(); foreign = await ownerFixture()
  oldContract = await ownerFixture(); disabledLocal = await ownerFixture()
  await admin(`CREATE ROLE "fixture-local-cap-v1" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE "fixture-local-cap-off" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`)
  for (const [role, workspaceId, version, local, provider, admission] of [
    ['sparra_voice_a', qualified.workspace.id, 2, true, false, true],
    ['sparra_voice_b', foreign.workspace.id, 2, true, false, false],
    ['fixture-local-cap-v1', oldContract.workspace.id, 1, true, false, true],
    ['fixture-local-cap-off', disabledLocal.workspace.id, 2, false, true, true],
  ] as const) await admin(`INSERT INTO voice_private.deployment_binding
    (service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled)
    SELECT $1::name,oid,$1::text,$2::uuid,'fixture-local-connection','+33123456789',$6::boolean,$5::boolean,$3::integer,$4::boolean FROM pg_roles WHERE rolname=$1::name`,
  [role, workspaceId, version, local, provider, admission])
})

afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => auth?.close(), () => limiter?.close(), () => pool?.end(), () => peer?.close(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Local audio policy fixture cleanup failed')
})

test.each([false, true])('historical provider recording=%s remains local audio OFF without a contact', async recordingEnabled => {
  const { principal, workspace } = await ownerFixture()
  // Existing-column insertion models an old immutable revision; no new policy or consent is supplied.
  await admin(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled)
    VALUES($1,1,'Historical company','garage','','','','','',$2)`, [workspace.id, recordingEnabled])
  expect((await activity.read(principal)).configuration).toMatchObject({
    workspaceId: workspace.id, revision: 1, recordingEnabled,
    recordingPolicy: 'off', recordingContactPhone: null,
  })
  expect(await revisions(workspace.id)).toEqual([
    { revision: 1, business_name: 'Historical company', recording_enabled: recordingEnabled },
  ])
})

test('local audio rejects a malformed supplied contact and leaves native revisions unchanged', async () => {
  const { principal, workspace } = await ownerFixture()
  const before = await revisions(workspace.id)
  for (const recordingContactPhone of ['', '0612345678', ' +33123456789', '+33123456789\n']) {
    await expect(activity.save(principal, {
      ...input(), recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone,
    })).rejects.toMatchObject({ name: 'InvalidActivityInput' })
  }
  expect(await revisions(workspace.id)).toEqual(before)
})

test('qualified local ON saves null contact and preserves a prior supplied contact through unrelated saves', async () => {
  const initialRevision = (await activity.read(qualified.principal)).configuration?.revision ?? 0
  const noContact = await activity.save(qualified.principal, { ...input(initialRevision), recordingPolicy: 'local_30d', recordingContactPhone: null })
  expect(noContact).toMatchObject({ revision: initialRevision + 1, recordingPolicy: 'local_30d', recordingContactPhone: null, recordingEnabled: false })
  expect((await activity.read(qualified.principal)).configuration).toEqual(noContact)
  const supplied = await activity.save(qualified.principal, localInput(noContact!.revision))
  const edited = await activity.save(qualified.principal, { ...input(supplied!.revision), businessName: 'Changed company name', recordingPolicy: 'local_30d' })
  expect(edited).toMatchObject({ recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789', recordingEnabled: false })
  const off = await activity.save(qualified.principal, { ...input(edited!.revision), recordingPolicy: 'off' })
  expect(off).toMatchObject({ recordingPolicy: 'off', recordingContactPhone: '+33123456789', recordingEnabled: false })
  const cleared = await activity.save(qualified.principal, { ...input(off!.revision), recordingPolicy: 'off', recordingContactPhone: null })
  expect(cleared).toMatchObject({ recordingContactPhone: null })
  expect((await admin('SELECT revision,recording_policy,recording_contact_phone FROM sparra_knowledge_revision WHERE workspace_id=$1 AND revision BETWEEN $2 AND $3 ORDER BY revision', [qualified.workspace.id, noContact!.revision, off!.revision])).rows).toEqual([
    { revision: noContact!.revision, recording_policy: 'local_30d', recording_contact_phone: null },
    { revision: supplied!.revision, recording_policy: 'local_30d', recording_contact_phone: '+33123456789' },
    { revision: edited!.revision, recording_policy: 'local_30d', recording_contact_phone: '+33123456789' },
    { revision: off!.revision, recording_policy: 'off', recording_contact_phone: '+33123456789' },
  ])
})

test('unavailable local capability refuses ON under the native Workspace lock without a revision', async () => {
  const { principal, workspace } = await ownerFixture()
  const before = await revisions(workspace.id)
  await admin('BEGIN')
  await admin('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspace.id])
  const refusal = activity.save(principal, {
    ...input(), recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789',
  }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  try {
    await expect.poll(async () => (await admin(
      "SELECT exists(SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock') waiting",
    )).rows[0].waiting, { timeout: 750, interval: 10 }).toBe(true)
  } finally { await admin('COMMIT') }
  expect(await refusal).toMatchObject({ value: null, error: { name: 'ActivityRecordingUnavailable' } })
  expect(await revisions(workspace.id)).toEqual(before)
})

test('qualified local ON saves and reloads the explicit contact while provider recording remains OFF', async () => {
  const on = await qualifiedOn()
  expect(on).toMatchObject({ recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789', recordingEnabled: false })
  expect((await activity.read(qualified.principal)).configuration).toEqual(on)
  expect(await available(qualified.workspace.id)).toBe(true)
})

test('activity exposes only its native tenant capability including absence and withdrawal without rewriting saved ON', async () => {
  const absent = await ceremony()
  expect(await activity.read(absent.principal)).toEqual({ workspace: null, configuration: null, localAudioAvailable: false })
  expect(await activity.read(qualified.principal)).toMatchObject({ workspace: qualified.workspace, localAudioAvailable: true })
  for (const target of [foreign, oldContract, disabledLocal]) {
    expect(await activity.read(target.principal)).toMatchObject({ workspace: target.workspace, localAudioAvailable: false })
  }
  const on = await qualifiedOn()
  await admin("UPDATE voice_private.deployment_binding SET admission_enabled=false WHERE service_login='sparra_voice_a'")
  try {
    expect(await activity.read(qualified.principal)).toEqual({ workspace: qualified.workspace, configuration: on, localAudioAvailable: false })
    await expect(activity.save(qualified.principal, localInput(on.revision))).rejects.toMatchObject({ name: 'ActivityRecordingUnavailable' })
    const off = await activity.save(qualified.principal, { ...input(on.revision), recordingEnabled: false, recordingPolicy: 'off', recordingContactPhone: null })
    expect(off).toMatchObject({ revision: on.revision + 1, recordingPolicy: 'off', recordingContactPhone: null, recordingEnabled: false })
    expect((await admin('SELECT recording_policy,recording_contact_phone FROM sparra_knowledge_revision WHERE workspace_id=$1 AND revision=$2', [qualified.workspace.id, on.revision])).rows[0]).toEqual({ recording_policy: 'local_30d', recording_contact_phone: '+33123456789' })
  } finally {
    await admin("UPDATE voice_private.deployment_binding SET admission_enabled=true WHERE service_login='sparra_voice_a'")
  }
})

test('legacy saves cannot silently replace local ON and explicit OFF preserves its old immutable revision', async () => {
  const on = await qualifiedOn(), before = await revisions(qualified.workspace.id)
  await expect(activity.save(qualified.principal, { ...input(on.revision), recordingEnabled: false })).rejects.toMatchObject({ name: 'ActivityRecordingUnavailable' })
  await expect(activity.save(qualified.principal, { ...localInput(on.revision), recordingEnabled: true })).rejects.toMatchObject({ name: 'InvalidActivityInput' })
  expect((await activity.read(qualified.principal)).configuration).toEqual(on)
  expect(await revisions(qualified.workspace.id)).toEqual(before)
  const off = await activity.save(qualified.principal, { ...input(on.revision), recordingPolicy: 'off', recordingContactPhone: null })
  expect(off).toMatchObject({ revision: on.revision + 1, recordingPolicy: 'off', recordingContactPhone: null, recordingEnabled: false })
  expect((await admin('SELECT recording_policy,recording_contact_phone,recording_enabled FROM sparra_knowledge_revision WHERE workspace_id=$1 AND revision=$2', [qualified.workspace.id, on.revision])).rows[0]).toEqual({ recording_policy: 'local_30d', recording_contact_phone: '+33123456789', recording_enabled: false })
})

test('foreign owner and non-qualified contract or provider-only flags cannot borrow the qualified capability', async () => {
  const on = await qualifiedOn()
  for (const target of [foreign, oldContract, disabledLocal]) {
    const before = await revisions(target.workspace.id)
    expect(await available(target.workspace.id)).toBe(false)
    expect((await activity.read(target.principal)).configuration).toBeNull()
    await expect(activity.save(target.principal, localInput())).rejects.toMatchObject({ name: 'ActivityRecordingUnavailable' })
    expect(await revisions(target.workspace.id)).toEqual(before)
  }
  await expect(activity.save(foreign.principal, { ...localInput(), workspaceId: qualified.workspace.id })).rejects.toMatchObject({ name: 'InvalidActivityInput' })
  expect((await activity.read(qualified.principal)).configuration).toEqual(on)
})

test('native local capability fields and policy/contact constraints cannot be rewritten or bypassed', async () => {
  const before = (await admin("SELECT contract_version,local_audio_enabled,audio_enabled FROM voice_private.deployment_binding WHERE service_login='sparra_voice_a'")).rows
  for (const change of ['contract_version=1', 'local_audio_enabled=false']) {
    await expect(admin("UPDATE voice_private.deployment_binding SET " + change + " WHERE service_login='sparra_voice_a'")).rejects.toMatchObject({ code: '23514' })
  }
  expect((await admin("SELECT contract_version,local_audio_enabled,audio_enabled FROM voice_private.deployment_binding WHERE service_login='sparra_voice_a'")).rows).toEqual(before)
  const { workspace } = await ownerFixture()
  for (const [policy, phone, provider] of [['local_30d', null, true], ['local_30d', '+33123456789', true], ['off', '0612345678', false], ['unknown', null, false]] as const) {
    await expect(admin(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_policy,recording_contact_phone,recording_enabled)
      VALUES($1,1,'Invalid policy fixture','garage','','','','','',$2,$3,$4)`, [workspace.id, policy, phone, provider])).rejects.toMatchObject({ code: '23514' })
  }
  expect(await revisions(workspace.id)).toEqual([])
})

test('runtime may execute only the bounded helper and cannot read private bindings with FORCE RLS retained', async () => {
  expect((await admin(`SELECT has_function_privilege('runtime','public.sparra_local_audio_available_v1()','EXECUTE') runtime,
    has_function_privilege('workspace_bootstrap','public.sparra_local_audio_available_v1()','EXECUTE') bootstrap,
    has_function_privilege('sparra_voice_definer','public.sparra_local_audio_available_v1()','EXECUTE') machine,
    has_schema_privilege('runtime','voice_private','USAGE') private_schema,
    has_table_privilege('runtime','voice_private.deployment_binding','SELECT') binding_read`)).rows[0]).toEqual({ runtime: true, bootstrap: false, machine: false, private_schema: false, binding_read: false })
  expect((await admin(`SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='public' AND c.relname='workspace') OR (n.nspname='voice_private' AND c.relname='deployment_binding')`)).rows[0].secured).toBe(true)
  const client = await pool.connect()
  try { await expect(client.query('SELECT workspace_id FROM voice_private.deployment_binding')).rejects.toMatchObject({ code: '42501' }) }
  finally { client.release() }
})

test('helper fails closed for invalid or inactive tenants and changed machine login authority', async () => {
  for (const tenant of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', randomUUID()]) expect(await available(tenant)).toBe(false)
  for (const lifecycle of ['provisioning', 'deleting']) {
    await admin('UPDATE workspace SET lifecycle=$1 WHERE id=$2', [lifecycle, qualified.workspace.id])
    try { expect(await available(qualified.workspace.id)).toBe(false) }
    finally { await admin("UPDATE workspace SET lifecycle='active' WHERE id=$1", [qualified.workspace.id]) }
  }
  await admin('ALTER ROLE sparra_voice_a NOLOGIN')
  try { expect(await available(qualified.workspace.id)).toBe(false) }
  finally { await admin('ALTER ROLE sparra_voice_a LOGIN') }
  expect(await available(qualified.workspace.id)).toBe(true)
  // Retire only this owned disposable identity; a new OID must not inherit its old capability.
  await admin('DROP ROLE sparra_voice_a; CREATE ROLE sparra_voice_a LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION')
  expect(await available(qualified.workspace.id)).toBe(false)
})
