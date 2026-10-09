import { afterAll, beforeAll, expect, test } from 'vitest'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

// A/B/shared use real PgBouncer logins. The fourth legacy role below is an
// owned direct-PG SESSION AUTHORIZATION witness, not a pooled login proof.
// Synthetic policy/routing/media facts do not qualify capture or caller choice.
type Snapshot = { schema_version: 2; workspace_id: string; call_id: string; configuration_revision: number
  retention_until: string; recording_policy: 'off' | 'local_30d'; recording_contact_phone: string | null; audio_available: boolean; recording_id: string | null }
type Role = 'a' | 'b' | 'shared'
type Call = { id: string; role: Role; route: ReturnType<typeof route>; snapshot: Snapshot }
type AudioIdentity = { schema_version: 2; workspace_id: string; recording_id: string; configuration_revision: number; retention_until: string }
type CallPayload = { telnyx_call_control_id: string; telnyx_call_leg_id: string | null; telnyx_call_session_id: string | null
  status: 'pending' | 'active' | 'closing' | 'closed' | 'failed'; disclosure_state: 'pending' | 'completed' | 'failed'
  started_at: string | null; ended_at: string | null; end_reason: string | null; retention_until: string; transcript_loss_count?: number
  disclosure_evidence?: { schema_version: 1; started_at: string | null; completed_at: string | null; failed_at: string | null; input_gate_opened_at: string | null } }
type TurnPayload = { turn_id: string; turn_no: number; role: 'user' | 'assistant'; source: 'stt_final' | 'pipecat_assistant'
  crypto_version: 1; key_version: number; nonce_b64: string; ciphertext_b64: string; started_at: string; ended_at: string; interrupted: boolean }
type RecordingPayload = { recording_id: string; status: 'off' | 'pending' | 'active' | 'saved' | 'failed' | 'purged'
  telnyx_recording_id: string | null; channels: 'dual' | null; format: 'wav' | null; started_at: string | null; ended_at: string | null; retention_until: string | null }
type ChunkPayload = AudioIdentity & { sequence: number; sample_count: number; sample_rate: 8000; channels: 2; sample_format: 's16le'
  crypto_version: 1; key_version: number; nonce_b64: string; ciphertext_b64: string }
type FinishPayload = AudioIdentity & { last_sequence: number | null; total_samples: number; reason: 'complete' | 'transfer' | 'interrupted' | 'limit' | 'failure' }
type RevokePayload = AudioIdentity & { reason: 'caller_declined' }
type AudioStorePayload = CallPayload | TurnPayload | RecordingPayload | ChunkPayload | FinishPayload | RevokePayload
type AudioStoreOperation = { schema_version: 2; operation_id: string; deployment_id: string; call_id: string; occurred_at: string
  kind: 'call.upsert' | 'turn.upsert' | 'recording.upsert' | 'audio.chunk' | 'audio.finish' | 'audio.revoke'; payload: AudioStorePayload }
let stores: Awaited<ReturnType<typeof startDisposableStores>>
const clients: Partial<Record<Role, Client>> = {}
const workspaceId = '22222222-2222-4222-8222-222222222222'
const budget = 20_447_648, quotaLimit = 536_870_912
const ids = Array.from({ length: 6 }, () => randomUUID())
const routes = new Map<number, ReturnType<typeof route>>()
const calls = new Map<number, Call>()
const deployment = { a: '🚙'.repeat(256), b: 'boundary-b', shared: 'boundary-disabled' }
let revision = 0
const admin = (sql: string, values?: unknown[]) => stores.administrator.query(sql, values)
const client = (role: Role) => { const value = clients[role]; if (!value) throw new Error('Missing owned client'); return value }
function route(slot: number, role: Role) {
  return { schema_version: 1, direction: 'incoming', connection_id: 'boundary-' + role, to_e164: '+33123456789', from_e164: null,
    telnyx_call_control_id: 'boundary-' + ids[slot], telnyx_call_leg_id: null, telnyx_call_session_id: null, admitted_at: new Date().toISOString() }
}
async function policy(value: 'off' | 'local_30d') {
  await admin("INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled,recording_policy,recording_contact_phone) VALUES($1,$2,'Boundary fixture','garage','','','','','',false,$3,$4)",
    [workspaceId, ++revision, value, null])
}
async function call(slot: number, role: Role): Promise<Call> {
  const existing = routes.get(slot), routing = existing ?? route(slot, role)
  routes.set(slot, routing)
  const snapshot = (await client(role).query<{ v: Snapshot }>('SELECT voice.begin_call_v2($1::text,$2::uuid,$3::jsonb) AS v',
    [deployment[role], ids[slot], JSON.stringify(routing)])).rows[0].v
  const value = { id: ids[slot], role, route: routing, snapshot }; calls.set(slot, value); return value
}
async function restoreActualQuota() {
  await admin('UPDATE sparra_audio_quota SET reserved_bytes=(SELECT coalesce(sum(audio_reserved_bytes),0) FROM sparra_call WHERE workspace_id=$1),charged_bytes=(SELECT coalesce(sum(audio_charged_bytes),0) FROM sparra_call WHERE workspace_id=$1) WHERE workspace_id=$1', [workspaceId])
}

beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await admin("INSERT INTO \"user\"(id,name,email) VALUES('audio-boundary-owner','Boundary owner','audio-boundary-owner@example.test')")
  await admin("INSERT INTO workspace(id,owner_user_id) VALUES($1,'audio-boundary-owner')", [workspaceId])
  await policy('local_30d')
  for (const role of ['a', 'b', 'shared'] as const) {
    const login = 'sparra_voice_' + role
    await admin('INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled) SELECT $1,oid,$2,$3,$4,$5,true,false,2,$6 FROM pg_roles WHERE rolname=$1',
      [login, deployment[role], workspaceId, 'boundary-' + role, '+33123456789', role !== 'shared'])
    await admin('GRANT USAGE ON SCHEMA voice TO ' + login)
    for (const signature of ['voice.begin_call_v2(text,uuid,jsonb)', 'voice.ingest_operation_v2(jsonb)',
      'voice.lease_call_erasure_v1(text,integer,integer)', 'voice.ack_call_erasure_v1(uuid,uuid,timestamptz)',
      'voice.lease_recording_purge_v1(text,integer,integer)', 'voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz)']) {
      await admin('GRANT EXECUTE ON FUNCTION ' + signature + ' TO ' + login)
    }
    const url = role === 'a' ? stores.voiceUrlA : role === 'b' ? stores.voiceUrlB : stores.voiceUrlShared
    clients[role] = new Client({ connectionString: url }); await client(role).connect()
  }
  await admin('CREATE ROLE sparra_audio_boundary_legacy LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION')
  await admin("INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled) SELECT 'sparra_audio_boundary_legacy',oid,'boundary-legacy',$1,'boundary-legacy','+33123456789',true,false,1,false FROM pg_roles WHERE rolname='sparra_audio_boundary_legacy'", [workspaceId])
  await admin('GRANT USAGE ON SCHEMA voice TO sparra_audio_boundary_legacy')
  await admin('GRANT EXECUTE ON FUNCTION voice.begin_call_v2(text,uuid,jsonb) TO sparra_audio_boundary_legacy')
}, 180000)
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [...Object.values(clients).map(value => () => value?.end()), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Audio boundary cleanup failed')
}, 30000)

function identity(value: Call): AudioIdentity {
  if (!value.snapshot.recording_id) throw new Error('Owned reserved audio required')
  return { schema_version: 2, workspace_id: workspaceId, recording_id: value.snapshot.recording_id,
    configuration_revision: value.snapshot.configuration_revision, retention_until: value.snapshot.retention_until }
}
function op(value: Call, kind: AudioStoreOperation['kind'], payload: AudioStorePayload): AudioStoreOperation {
  return { schema_version: 2, operation_id: randomUUID(), deployment_id: deployment[value.role], call_id: value.id,
    occurred_at: new Date().toISOString(), kind, payload }
}
async function ingest(value: Call, operation: unknown) {
  return (await client(value.role).query('SELECT voice.ingest_operation_v2($1::jsonb) AS v', [JSON.stringify(operation)])).rows[0].v
}
function lifecycle(value: Call, end?: string): CallPayload {
  const at = value.route.admitted_at
  return { telnyx_call_control_id: value.route.telnyx_call_control_id, telnyx_call_leg_id: null, telnyx_call_session_id: null,
    status: end ? 'closed' : 'active', disclosure_state: 'completed', started_at: at, ended_at: end ?? null, end_reason: end ? 'hangup' : null,
    retention_until: value.snapshot.retention_until, transcript_loss_count: 0,
    disclosure_evidence: { schema_version: 1, started_at: at, completed_at: at, failed_at: null, input_gate_opened_at: at } }
}
async function disclose(value: Call) { expect((await ingest(value, op(value, 'call.upsert', lifecycle(value)))).status).toBe('applied') }
function media(value: Call, sequence: number) {
  const key = randomBytes(32), nonce = randomBytes(12), pcm = Buffer.alloc(32000, 3)
  const metadata = { ...identity(value), deployment_id: deployment[value.role], call_id: value.id, sequence, sample_count: 8000,
    sample_rate: 8000, channels: 2, sample_format: 's16le', crypto_version: 1, key_version: 9007199254740991 }
  const ordered = Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from('sparra.audio.chunk.v1\u0000' + JSON.stringify(ordered)))
  const ciphertext = Buffer.concat([cipher.update(pcm), cipher.final(), cipher.getAuthTag()])
  return op(value, 'audio.chunk', { ...identity(value), sequence, sample_count: 8000, sample_rate: 8000, channels: 2,
    sample_format: 's16le', crypto_version: 1, key_version: 9007199254740991, nonce_b64: nonce.toString('base64'), ciphertext_b64: ciphertext.toString('base64') })
}

test('fixed contract refuses legacy binding while OFF and local-capability absence still admit phone', async () => {
  await admin('SET SESSION AUTHORIZATION sparra_audio_boundary_legacy')
  try {
    expect((await admin('SELECT session_user::text AS name')).rows[0].name).toBe('sparra_audio_boundary_legacy')
    await expect(admin('SELECT voice.begin_call_v2($1::text,$2::uuid,$3::jsonb)',
      ['boundary-legacy', randomUUID(), JSON.stringify({ ...route(0, 'a'), connection_id: 'boundary-legacy' })])).rejects.toMatchObject({ code: 'PV202' })
  } finally { await admin('RESET SESSION AUTHORIZATION') }
  await policy('off')
  const off = await call(0, 'a')
  expect(off.snapshot).toMatchObject({ recording_policy: 'off', audio_available: false, recording_id: null })
  await policy('local_30d')
  const unavailable = await call(1, 'shared')
  expect(unavailable.snapshot).toMatchObject({ recording_policy: 'local_30d', recording_contact_phone: null, audio_available: false, recording_id: null })
  expect((await admin('SELECT audio_state,status,audio_reserved_bytes,audio_charged_bytes FROM sparra_call WHERE id=$1', [unavailable.id])).rows[0])
    .toMatchObject({ audio_state: 'unavailable', status: 'pending', audio_reserved_bytes: 0, audio_charged_bytes: 0 })
})

test('two actual bindings serialize one remaining Workspace reservation and replay never resizes', async () => {
  await policy('local_30d')
  await admin('INSERT INTO sparra_audio_quota(workspace_id,reserved_bytes,charged_bytes) VALUES($1,$2,0) ON CONFLICT(workspace_id) DO UPDATE SET reserved_bytes=EXCLUDED.reserved_bytes,charged_bytes=0', [workspaceId, quotaLimit - budget])
  const admitted = await Promise.all([call(2, 'a'), call(3, 'b')])
  expect(admitted.filter(value => value.snapshot.audio_available)).toHaveLength(1)
  expect(admitted.filter(value => !value.snapshot.audio_available)).toHaveLength(1)
  const full = (await admin('SELECT reserved_bytes,charged_bytes FROM sparra_audio_quota WHERE workspace_id=$1', [workspaceId])).rows[0]
  expect(Number(full.reserved_bytes) + Number(full.charged_bytes)).toBe(quotaLimit)
  // Only owned fixture counter travel removes the synthetic historical baseline.
  await restoreActualQuota()
  for (const previous of admitted) {
    const slot = previous.id === ids[2] ? 2 : 3
    expect((await call(slot, previous.role)).snapshot).toEqual(previous.snapshot)
  }
  const after = (await admin('SELECT reserved_bytes,charged_bytes FROM sparra_audio_quota WHERE workspace_id=$1', [workspaceId])).rows[0]
  expect(Number(after.reserved_bytes) + Number(after.charged_bytes)).toBe(budget)
})
test('native strict maximum Unicode chunk charge and finish gaps or empty capture never fabricate ready', async () => {
  await policy('local_30d')
  const value = await call(4, 'a'); await disclose(value)
  const chunk = media(value, 0)
  for (const change of [
    { workspace_id: '99999999-9999-4999-8999-999999999999' }, { configuration_revision: value.snapshot.configuration_revision + 1 },
    { retention_until: new Date(Date.parse(value.snapshot.retention_until) + 1).toISOString() },
    { nonce_b64: Buffer.alloc(11).toString('base64') }, { nonce_b64: '!!!!' }, { sample_count: 8001 },
  ]) {
    await expect(ingest(value, { ...chunk, operation_id: randomUUID(), payload: { ...chunk.payload, ...change } })).rejects.toMatchObject({ code: 'PV202' })
  }
  expect((await ingest(value, chunk)).status).toBe('applied')
  const actual = (await admin('SELECT charged_bytes,octet_length(nonce) AS n,octet_length(ciphertext) AS c,key_version::text AS version FROM sparra_audio_chunk WHERE call_id=$1', [value.id])).rows[0]
  const bytes = (await admin("SELECT octet_length(convert_to((($1::jsonb-'payload')||(($1::jsonb->'payload')-'nonce_b64'-'ciphertext_b64'))::text,'UTF8')) AS metadata", [JSON.stringify(chunk)])).rows[0].metadata
  expect(bytes).toBeLessThanOrEqual(2048); expect(actual.charged_bytes).toBe(actual.n + actual.c + bytes)
  expect(actual.version).toBe('9007199254740991')
  expect((await ingest(value, op(value, 'audio.finish', { ...identity(value), last_sequence: 1, total_samples: 16000, reason: 'complete' }))).status).toBe('applied')
  const gap = (await admin('SELECT audio_state,audio_reserved_bytes FROM sparra_call WHERE id=$1', [value.id])).rows[0]
  expect(gap.audio_state).toBe('partial'); expect(gap.audio_reserved_bytes).toBeGreaterThan(0)
  const empty = await call(5, 'a')
  expect((await ingest(empty, op(empty, 'audio.finish', { ...identity(empty), last_sequence: null, total_samples: 0, reason: 'failure' }))).status).toBe('applied')
  expect((await admin('SELECT audio_state,audio_reserved_bytes FROM sparra_call WHERE id=$1', [empty.id])).rows[0]).toMatchObject({ audio_state: 'unavailable', audio_reserved_bytes: 0 })
})

test('native owner erase and owned expiry delete binary release quota and retain unresolved provider obligation', async () => {
  await policy('local_30d')
  const value = await call(4, 'a'); await disclose(value)
  if ((await admin('SELECT count(*)::int n FROM sparra_audio_chunk WHERE call_id=$1', [value.id])).rows[0].n === 0) {
    expect((await ingest(value, media(value, 0))).status).toBe('applied')
  }
  const tail = media(value, 1), ended = new Date().toISOString()
  expect((await ingest(value, op(value, 'call.upsert', lifecycle(value, ended)))).status).toBe('applied')
  await admin('CREATE TABLE public.fixture_audio_end_updates(call_id uuid); CREATE FUNCTION public.fixture_audio_end_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN INSERT INTO public.fixture_audio_end_updates VALUES(OLD.id); RETURN NEW; END $$; CREATE TRIGGER fixture_audio_end_audit AFTER UPDATE OF ended_at ON public.sparra_call FOR EACH ROW WHEN(OLD.ended_at IS DISTINCT FROM NEW.ended_at) EXECUTE FUNCTION public.fixture_audio_end_audit()')
  expect((await ingest(value, op(value, 'recording.upsert', { recording_id: randomUUID(), status: 'failed', telnyx_recording_id: 'owned-provider-obligation',
    channels: 'dual', format: 'wav', started_at: null, ended_at: null, retention_until: null }))).status).toBe('applied')
  const before = (await admin('SELECT reserved_bytes,charged_bytes FROM sparra_audio_quota WHERE workspace_id=$1', [workspaceId])).rows[0]
  const contribution = (await admin('SELECT audio_reserved_bytes,audio_charged_bytes,ended_at FROM sparra_call WHERE id=$1', [value.id])).rows[0]
  expect(contribution.ended_at.toISOString()).toBe(ended)
  const owner = new Client({ connectionString: stores.runtimeUrl }); await owner.connect()
  try {
    await owner.query('BEGIN'); await owner.query("SELECT set_config('app.tenant_id',$1,true)", [workspaceId])
    await owner.query('UPDATE sparra_call SET erasure_requested_at=clock_timestamp() WHERE id=$1', [value.id]); await owner.query('COMMIT')
  } finally { await owner.end() }
  expect((await admin('SELECT count(*)::int n FROM sparra_audio_chunk WHERE call_id=$1', [value.id])).rows[0].n).toBe(0)
  const after = (await admin('SELECT reserved_bytes,charged_bytes FROM sparra_audio_quota WHERE workspace_id=$1', [workspaceId])).rows[0]
  expect(Number(after.reserved_bytes) + Number(after.charged_bytes)).toBe(Number(before.reserved_bytes) + Number(before.charged_bytes) - contribution.audio_reserved_bytes - contribution.audio_charged_bytes)
  await expect(ingest(value, tail)).rejects.toMatchObject({ code: 'PV301' })
  const leased = (await client('a').query("SELECT * FROM voice.lease_call_erasure_v1('owned-boundary',30,100)")).rows.map(row => row.lease_call_erasure_v1).find(row => row.call_id === value.id)
  expect(leased).toBeDefined()
  await client('a').query('SELECT voice.ack_call_erasure_v1($1,$2,$3)', [value.id, leased.lease_token, new Date().toISOString()])
  expect((await admin('SELECT state,original_retention_until FROM sparra_erasure WHERE call_id=$1', [value.id])).rows[0]).toMatchObject({ state: 'queued', original_retention_until: new Date(value.snapshot.retention_until) })
  const winner = [...calls.values()].find(candidate => (candidate.id === ids[2] || candidate.id === ids[3]) && candidate.snapshot.audio_available) ?? await call(2, 'a')
  await disclose(winner); expect((await ingest(winner, media(winner, 0))).status).toBe('applied')
  await admin("UPDATE sparra_call SET admitted_at=admitted_at-interval '31 days',retention_until=retention_until-interval '31 days' WHERE id=$1", [winner.id])
  await client(winner.role).query("SELECT * FROM voice.lease_call_erasure_v1('owned-expiry',30,100)")
  expect((await admin('SELECT count(*)::int n FROM sparra_call WHERE id=$1', [winner.id])).rows[0].n).toBe(0)
  expect((await admin('SELECT count(*)::int n FROM sparra_audio_chunk WHERE call_id=$1', [winner.id])).rows[0].n).toBe(0)
  expect((await admin('SELECT count(*)::int n FROM fixture_audio_end_updates')).rows[0].n).toBe(0)
})

test('native malformed versions and changed duplicate operation retain original receipt identity and digest', async () => {
  await policy('local_30d')
  const value = await call(5, 'a'), revoke = op(value, 'audio.revoke', { ...identity(value), reason: 'caller_declined' })
  for (const invalid of [null, { ...revoke, schema_version: null }, { ...revoke, schema_version: true }, { ...revoke, schema_version: 3 }, { ...revoke, kind: 'audio.unknown' }, { ...revoke, extra: 1 }]) {
    await expect(ingest(value, invalid)).rejects.toMatchObject({ code: 'PV202' })
  }
  const applied = await ingest(value, revoke); expect(applied.schema_version).toBe(2); expect(applied.status).toBe('applied')
  const receipt = (await admin('SELECT operation_id,payload_sha256,call_id FROM voice_private.operation_receipt WHERE deployment_id=$1 AND operation_id=$2', [deployment[value.role], revoke.operation_id])).rows[0]
  const expected = (await admin("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS digest", [JSON.stringify(revoke)])).rows[0].digest
  expect(receipt.payload_sha256).toBe(expected)
  expect((await ingest(value, revoke)).status).toBe('duplicate')
  const changed = { ...revoke, occurred_at: new Date(Date.parse(revoke.occurred_at) + 1).toISOString() }
  expect((await ingest(value, changed)).status).toBe('conflict')
  expect((await admin('SELECT operation_id,payload_sha256,call_id FROM voice_private.operation_receipt WHERE deployment_id=$1 AND operation_id=$2', [deployment[value.role], revoke.operation_id])).rows[0]).toEqual(receipt)
})
