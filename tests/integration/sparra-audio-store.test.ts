import { afterAll, beforeAll, expect, test } from 'vitest'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

// Real owned PG/PgBouncer store consumers. Synthetic policy/disclosure/PCM facts
// do not qualify caller choice, Pipecat capture, local writer or provider audio.
type Snapshot = {
  schema_version: 2; workspace_id: string; call_id: string; configuration_revision: number
  knowledge: { business_name: string; sector: string; opening_hours: string; services: string; prices: string; faq: string; instructions: string }
  transfer_destination: string | null; retention_until: string
  recording_policy: 'off' | 'local_30d'; recording_contact_phone: string | null
  audio_available: boolean; recording_id: string | null
}
type AudioRow = {
  audio_state: string; audio_reserved_bytes: string | number; audio_charged_bytes: string | number
  audio_denied_at: Date | null; audio_total_samples: number | null; audio_last_sequence: number | null
  audio_finish_reason: string | null; ended_at: Date | null; status: string; retention_until: Date
}
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
let stores: Awaited<ReturnType<typeof startDisposableStores>>, machine: Client
const workspaceId = '11111111-1111-4111-8111-111111111111'
const deployment = 'audio-store-fixture'
const reservation = 20_447_648
let revision = 0
const admin = (sql: string, values?: unknown[]) => stores.administrator.query(sql, values)

async function appendRevision(policy: 'off' | 'local_30d') {
  revision++
  await admin("INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled,recording_policy,recording_contact_phone) VALUES($1,$2,'Audio store fixture','garage','','','','','',false,$3,$4)",
    [workspaceId, revision, policy, policy === 'local_30d' ? '+33123456789' : null])
}

async function grantIfDefined(signature: 'voice.begin_call_v2(text,uuid,jsonb)' | 'voice.ingest_operation_v2(jsonb)') {
  const found = (await admin('SELECT to_regprocedure($1) IS NOT NULL AS present', [signature])).rows[0]
  if (found.present) await admin('GRANT EXECUTE ON FUNCTION ' + signature + ' TO sparra_voice_a')
}

function routing(id: string) {
  return { schema_version: 1, direction: 'incoming', connection_id: 'connection-a', to_e164: '+33123456789', from_e164: null,
    telnyx_call_control_id: 'fixture-call-' + id, telnyx_call_leg_id: null, telnyx_call_session_id: null, admitted_at: new Date().toISOString() }
}

async function begin(id = randomUUID()) {
  await grantIfDefined('voice.begin_call_v2(text,uuid,jsonb)')
  const route = routing(id)
  const snapshot = (await machine.query<{ v: Snapshot }>('SELECT voice.begin_call_v2($1::text,$2::uuid,$3::jsonb) AS v',
    [deployment, id, JSON.stringify(route)])).rows[0].v
  return { id, route, snapshot }
}

function operation(call: Awaited<ReturnType<typeof begin>>, kind: AudioStoreOperation['kind'], payload: AudioStorePayload): AudioStoreOperation {
  return { schema_version: 2, operation_id: randomUUID(), deployment_id: deployment, call_id: call.id,
    occurred_at: new Date().toISOString(), kind, payload }
}

async function ingest(op: AudioStoreOperation) {
  await grantIfDefined('voice.ingest_operation_v2(jsonb)')
  return (await machine.query('SELECT voice.ingest_operation_v2($1::jsonb) AS v', [JSON.stringify(op)])).rows[0].v
}

const audioRow = async (id: string) => (await stores.administrator.query<AudioRow>('SELECT audio_state,audio_reserved_bytes,audio_charged_bytes,audio_denied_at,audio_total_samples,audio_last_sequence,audio_finish_reason,ended_at,status,retention_until FROM sparra_call WHERE id=$1', [id])).rows[0]
const allocated = (row: AudioRow) => Number(row.audio_reserved_bytes) + Number(row.audio_charged_bytes)
const chunkCount = async (id: string) => (await admin('SELECT count(*)::int n FROM sparra_audio_chunk WHERE call_id=$1', [id])).rows[0].n

function identity(call: Awaited<ReturnType<typeof begin>>): AudioIdentity {
  if (call.snapshot.recording_id === null) throw new Error('Native audio reservation required by fixture')
  return { schema_version: 2, workspace_id: workspaceId, recording_id: call.snapshot.recording_id,
    configuration_revision: call.snapshot.configuration_revision, retention_until: call.snapshot.retention_until }
}

async function disclose(call: Awaited<ReturnType<typeof begin>>) {
  const at = call.route.admitted_at
  expect((await ingest(operation(call, 'call.upsert', {
    telnyx_call_control_id: call.route.telnyx_call_control_id, telnyx_call_leg_id: null, telnyx_call_session_id: null,
    status: 'active', disclosure_state: 'completed', started_at: at, ended_at: null, end_reason: null,
    retention_until: call.snapshot.retention_until, transcript_loss_count: 0,
    disclosure_evidence: { schema_version: 1, started_at: at, completed_at: at, failed_at: null, input_gate_opened_at: at },
  }))).status).toBe('applied')
}

function chunk(call: Awaited<ReturnType<typeof begin>>, sequence: number) {
  const nonce = randomBytes(12), pcm = Buffer.alloc(32_000, sequence + 1), key = randomBytes(32)
  const metadata = { ...identity(call), deployment_id: deployment, call_id: call.id, sequence, sample_count: 8000,
    sample_rate: 8000, channels: 2, sample_format: 's16le', crypto_version: 1, key_version: 1 }
  const canonical = Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from('sparra.audio.chunk.v1\u0000' + JSON.stringify(canonical), 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(pcm), cipher.final(), cipher.getAuthTag()])
  const op = operation(call, 'audio.chunk', { ...identity(call), sequence, sample_count: 8000, sample_rate: 8000,
    channels: 2, sample_format: 's16le', crypto_version: 1, key_version: 1,
    nonce_b64: nonce.toString('base64'), ciphertext_b64: ciphertext.toString('base64') })
  return { op, nonce, ciphertext, pcm }
}

beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await admin("INSERT INTO \"user\"(id,name,email) VALUES('audio-store-owner','Audio store owner','audio-store-owner@example.test')")
  await admin("INSERT INTO workspace(id,owner_user_id) VALUES($1,'audio-store-owner')", [workspaceId])
  await appendRevision('local_30d')
  await admin("INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled) SELECT 'sparra_voice_a',oid,$1,$2,'connection-a','+33123456789',true,false,2,true FROM pg_roles WHERE rolname='sparra_voice_a'", [deployment, workspaceId])
  await admin('GRANT USAGE ON SCHEMA voice TO sparra_voice_a')
  machine = new Client({ connectionString: stores.voiceUrlA }); await machine.connect()
}, 180000)

afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => machine?.end(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Audio store fixture cleanup failed')
}, 30000)

test('native begin V2 pins strict snapshot and original expiry once with bounded reservation', async () => {
  const call = await begin()
  expect(Object.keys(call.snapshot).sort()).toEqual(['schema_version', 'workspace_id', 'call_id', 'configuration_revision', 'knowledge', 'transfer_destination', 'retention_until', 'recording_policy', 'recording_contact_phone', 'audio_available', 'recording_id'].sort())
  expect(call.snapshot).toMatchObject({ schema_version: 2, workspace_id: workspaceId, call_id: call.id,
    configuration_revision: 1, recording_policy: 'local_30d', recording_contact_phone: '+33123456789', audio_available: true,
    retention_until: new Date(Date.parse(call.route.admitted_at) + 2_592_000_000).toISOString() })
  expect(call.snapshot.recording_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(allocated(await audioRow(call.id))).toBe(reservation)
  await appendRevision('off')
  const replay = (await machine.query('SELECT voice.begin_call_v2($1::text,$2::uuid,$3::jsonb) AS v',
    [deployment, call.id, JSON.stringify(call.route)])).rows[0].v
  expect(replay).toEqual(call.snapshot)
  expect(allocated(await audioRow(call.id))).toBe(reservation)
  await expect(machine.query('SELECT voice.begin_call_v1($1::text,$2::uuid,$3::jsonb)',
    [deployment, call.id, JSON.stringify(call.route)])).rejects.toMatchObject({ code: '42501' })
})

test('native V2 chunks store binary envelopes once and contiguous finish becomes ready', async () => {
  await appendRevision('local_30d')
  const call = await begin(); await disclose(call)
  const before = await audioRow(call.id), first = chunk(call, 0), second = chunk(call, 1)
  expect((await ingest(first.op)).status).toBe('applied')
  const stored = (await admin('SELECT nonce,ciphertext FROM sparra_audio_chunk WHERE call_id=$1 AND sequence=0', [call.id])).rows[0]
  expect(Buffer.isBuffer(stored.nonce)).toBe(true); expect(Buffer.isBuffer(stored.ciphertext)).toBe(true)
  expect(stored.nonce.equals(first.nonce)).toBe(true); expect(stored.ciphertext.equals(first.ciphertext)).toBe(true)
  expect(stored.ciphertext.equals(first.pcm)).toBe(false)
  const charged = await audioRow(call.id)
  expect(Number(charged.audio_charged_bytes)).toBeGreaterThan(Number(before.audio_charged_bytes))
  expect(allocated(charged)).toBe(reservation)
  expect((await ingest(first.op)).status).toBe('duplicate')
  expect(await audioRow(call.id)).toEqual(charged); expect(await chunkCount(call.id)).toBe(1)
  expect((await ingest(chunk(call, 0).op)).status).toBe('conflict')
  expect(await audioRow(call.id)).toEqual(charged)
  expect((await ingest(second.op)).status).toBe('applied')
  expect((await ingest(operation(call, 'audio.finish', { ...identity(call), last_sequence: 1, total_samples: 16000, reason: 'complete' }))).status).toBe('applied')
  const ready = await audioRow(call.id)
  expect(ready).toMatchObject({ audio_state: 'ready', audio_total_samples: 16000, audio_last_sequence: 1, audio_finish_reason: 'complete', ended_at: null, status: 'active' })
  expect(Number(ready.audio_reserved_bytes)).toBe(0); expect(await chunkCount(call.id)).toBe(2)
})

test('native audio revoke deletes binary content and rejects late chunks without ending phone', async () => {
  await appendRevision('local_30d')
  const call = await begin(); await disclose(call)
  const first = chunk(call, 0); expect((await ingest(first.op)).status).toBe('applied')
  const before = await audioRow(call.id)
  const revoke = operation(call, 'audio.revoke', { ...identity(call), reason: 'caller_declined' })
  expect((await ingest(revoke)).status).toBe('applied')
  expect((await ingest(revoke)).status).toBe('duplicate')
  expect(await chunkCount(call.id)).toBe(0)
  const denied = await audioRow(call.id)
  expect(denied.audio_denied_at).not.toBeNull(); expect(Number(denied.audio_reserved_bytes)).toBe(0)
  expect(Number(denied.audio_charged_bytes)).toBeLessThanOrEqual(2048)
  expect({ ended: denied.ended_at, status: denied.status, retention: denied.retention_until }).toEqual(
    { ended: before.ended_at, status: before.status, retention: before.retention_until })
  await expect(ingest({ ...first.op, operation_id: randomUUID() })).rejects.toMatchObject({ code: 'PV301' })
  expect(await chunkCount(call.id)).toBe(0); expect(await audioRow(call.id)).toEqual(denied)
})
