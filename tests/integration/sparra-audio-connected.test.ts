// Separate normal ON and PARTIAL hangup candidates: actual CallSession/Pipecat/SQLite/PgBouncer/PG
// and compiled private reader. Controlled media/inference is synthetic, not a
// qualified release, live carrier call or full Task4/B1–B5 acceptance.
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { fetch as loopbackFetch } from 'undici'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { cryptoFixture, resolveVoiceProducer } from '../helpers/sparra-crypto-fixture'
import { startConnectedVoice } from '../helpers/sparra-voice-driver'
import { bounded, unusedLoopbackPort, startWeb } from '../helpers/web-process'
import { nativeImage } from '../helpers/native-image'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, crypto: Awaited<ReturnType<typeof cryptoFixture>>
let issuer: ReturnType<typeof startWeb>
let voice: ReturnType<typeof startConnectedVoice>
let web: Awaited<ReturnType<Awaited<ReturnType<typeof startDisposableStores>>['startWebImage']>>
let webImage: Awaited<ReturnType<typeof nativeImage>>
let cookie: string, origin: string, workspaceId: string
let expectedVoiceExit = 0
const TRANSFER_CAPTURE_TEST = 'native accepted local capture joins before real request_human transfer intent and SDK dispatch'
const startRequire = createRequire(import.meta.resolve('@tanstack/react-start'))
const nativeRequire = createRequire(startRequire.resolve('@tanstack/start-client-core/package.json'))
// Use the selected transitive package's actual declaration, including its
// required options, without introducing another package or runtime alias.
const { fromCrossJSON }: typeof import('../../node_modules/.pnpm/seroval@1.6.7/node_modules/seroval/dist/index') = nativeRequire('seroval')
const phaseEpoch = performance.now()
function phase(name: string) { console.log('PAIRED_APP_PHASE ' + name + ' elapsed_ms=' + Math.round(performance.now() - phaseEpoch)) }
type RpcNode = import('../../node_modules/.pnpm/seroval@1.6.7/node_modules/seroval/dist/index').SerovalNode
function googleRpcNode(value: unknown, depth = 0): RpcNode {
  if (!value || typeof value !== 'object' || depth > 3 || !('t' in value)) throw new Error('Native Google node unavailable')
  const base = { i: undefined, s: undefined, c: undefined, m: undefined, p: undefined, e: undefined,
    a: undefined, f: undefined, b: undefined, o: undefined, l: undefined }
  // Start includes an undefined error member in its successful envelope.
  // Seroval represents null/undefined as public Constant nodes 0/1.
  if (value.t === 2 && 's' in value && (value.s === 0 || value.s === 1)) {
    return { ...base, t: 2, s: value.s }
  }
  // The two consumed DTOs contain only objects and URL/receipt strings.
  // Preserve their public Seroval tags/IDs/flags while checking every child;
  // the native decoder still owns the actual object/reference construction.
  if (value.t === 1 && 's' in value && typeof value.s === 'string' && value.s.length <= 8192) {
    return { ...base, t: 1, s: value.s }
  }
  if ((value.t === 10 || value.t === 11) && 'i' in value && typeof value.i === 'number'
    && Number.isSafeInteger(value.i) && value.i >= 0 && 'o' in value
    && (value.o === 0 || value.o === 1 || value.o === 2 || value.o === 3) && 'p' in value && value.p
    && typeof value.p === 'object' && 'k' in value.p && 'v' in value.p
    && Array.isArray(value.p.k) && Array.isArray(value.p.v) && value.p.k.length <= 8
    && value.p.k.length === value.p.v.length) {
    const keys: string[] = []
    for (const key of value.p.k) {
      if (typeof key !== 'string' || key.length > 128) throw new Error('Native Google node unavailable')
      keys.push(key)
    }
    return { ...base, t: value.t, i: value.i, o: value.o, p: { k: keys, v: value.p.v.map(child => googleRpcNode(child, depth + 1)) } }
  }
  console.log('PAIRED_SEROVAL_NODE rejected depth=' + depth + ' tag=' +
    (typeof value.t === 'number' && Number.isSafeInteger(value.t) ? value.t : 'non-numeric'))
  throw new Error('Native Google node unavailable')
}

async function nativeRpc(name: Parameters<typeof authRpcPath>[0], data: unknown, cookies = cookie) {
  return loopbackFetch(origin + await authRpcPath(name), { method: 'POST', redirect: 'manual',
    headers: { origin, cookie: cookies ?? '', 'content-type': 'application/json', 'x-tsr-serverFn': 'true', 'x-real-ip': '127.0.1.5' },
    body: await rpcBody(data), signal: AbortSignal.timeout(10000) })
}
function issuedCookies(headers: Readonly<{ getSetCookie(): string[] }>) {
  return headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('=')).join('; ')
}

// Cold image construction must finish before any per-call disposable ownership
// starts: a timed-out hook cannot cancel a pending build or its continuation.
beforeAll(async () => { webImage = await nativeImage('web') })

beforeEach(async context => {
  const transferFixture = context.task.name === TRANSFER_CAPTURE_TEST
  expectedVoiceExit = 0
  phase('stores-start')
  stores = await startDisposableStores(); await stores.migrate()
  phase('stores-migrated')
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  const port = await unusedLoopbackPort()
  const secret = randomBytes(48).toString('hex')
  origin = 'http://localhost:' + port
  issuer = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, PORT: String(port), DATABASE_URL: stores.runtimeUrl,
    REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'audio-connected',
    TRUSTED_PROXY_IPS: '127.0.0.1', AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'fixture-only', FIXTURE_GOOGLE_PROTOCOL: 'yes', REQUEST_TIMEOUT_MS: '10000' })
  expect((await bounded(issuer.ready)).port).toBe(port)
  phase('google-start')
  const begun = await nativeRpc('beginGoogleSignIn', { locale: 'fr' }, '')
  expect(begun.status).toBe(200)
  const envelope = fromCrossJSON<unknown>(googleRpcNode(await begun.json()), { refs: new Map() })
  if (!envelope || typeof envelope !== 'object' || !('result' in envelope) || !envelope.result
    || typeof envelope.result !== 'object' || !('url' in envelope.result) || typeof envelope.result.url !== 'string') {
    throw new Error('Native Google RPC result missing')
  }
  const authorization = new URL(envelope.result.url), subject = 'audio-candidate-owner'
  const code = await issuer.registerGoogle(authorization.href, subject)
  const callback = await loopbackFetch(origin + '/api/auth/callback/google?code=' + code + '&state=' + authorization.searchParams.get('state'),
    { redirect: 'manual', headers: { cookie: issuedCookies(begun.headers), 'x-real-ip': '127.0.1.5' }, signal: AbortSignal.timeout(10000) })
  expect(callback.status).toBe(302); cookie = issuedCookies(callback.headers)
  expect(cookie.includes('__Secure-better-auth.session_token=')).toBe(true)
  await callback.body?.cancel()
  phase('google-ready')
  const workspaceResponse = await nativeRpc('ensurePersonalWorkspace', {})
  expect(workspaceResponse.status).toBe(200); await workspaceResponse.body?.cancel()
  const workspace = (await stores.administrator.query('SELECT w.id FROM workspace w JOIN "user" u ON u.id=w.owner_user_id WHERE u.email=$1',
    [subject + '@example.test'])).rows[0]
  if (!workspace) throw new Error('Native candidate Workspace missing')
  workspaceId = workspace.id
  await stores.administrator.query("INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled) SELECT 'sparra_voice_a',oid,'fixture-a',$1,'connection-a','+33123456789',true,false,2,true FROM pg_roles WHERE rolname='sparra_voice_a'", [workspaceId])
  await stores.administrator.query('GRANT USAGE ON SCHEMA voice TO sparra_voice_a; GRANT EXECUTE ON FUNCTION voice.begin_call_v2(text,uuid,jsonb),voice.ingest_operation_v2(jsonb),voice.lease_call_erasure_v1(text,integer,integer),voice.ack_call_erasure_v1(uuid,uuid,timestamptz),voice.lease_recording_purge_v1(text,integer,integer),voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz) TO sparra_voice_a')
  const saved = await nativeRpc('saveActivity', { expectedRevision: 0,
    businessName: 'Native capture fixture', sector: 'garage', knowledge: { openingHours: '', services: '', prices: '', faq: '', instructions: '' },
    transferDestination: transferFixture ? '+33102030406' : null, recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789' })
  expect(saved.status).toBe(200); await saved.body?.cancel()
  phase('policy-ready')
  expect(await issuer.googleEvidence()).toMatchObject({ activeClientSockets: 0, activeRequests: 0, disallowed: 0 })
  await issuer.cleanup()
  expect(issuer.child.exitCode).toBe(0); expect(issuer.child.signalCode).toBeNull()
  expect((await stores.administrator.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND state<>'idle'")).rows[0].n).toBe(0)
  phase('setup-child-retired')
  crypto = await cryptoFixture()
  const evidence = join(crypto.directory, 'native-evidence'); await mkdir(evidence)
  const producer = await resolveVoiceProducer()
  phase('voice-start')
  voice = startConnectedVoice({ url: stores.voiceUrlA, keyring_path: crypto.path,
    evidence_path: evidence, state_path: join(crypto.directory, 'voice-state'), audio_candidate: true, workspace_id: workspaceId,
    ...(transferFixture ? { audio_transfer_fixture: true } : {}) }, producer)
  expect(await voice.ready).toMatchObject({ ready: true, candidate: true })
  phase('voice-ready')
  web = await stores.startWebImage(webImage, 'valid',
    { secret, googleClientId: 'fixture.apps.googleusercontent.com', googleClientSecret: 'fixture-only' },
    JSON.stringify(crypto.keyring), false, port, { incarnation: randomUUID(), deploymentId: 'native-capture-app' })
  origin = web.url
  phase('web-ready')
}, 20000)

afterEach(async () => {
  const failures: unknown[] = []
  for (const close of [async () => {
    const ended = await voice?.cleanup()
    if (ended) expect(ended).toEqual({ code: expectedVoiceExit, signal: null })
  }, async () => {
    if (web) { await stores.signalWeb(web.id, 'SIGTERM'); expect(await stores.waitWeb(web.id)).toBe(0) }
  }, () => issuer?.cleanup(), () => crypto?.cleanup(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Paired native capture cleanup failed')
}, 10000)

async function exactReader(callId: string, state: 'active' | 'released') {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const row = (await stores.administrator.query<{ lease_id: string; state: string }>(
      'SELECT lease_id,state FROM sparra_audio_reader WHERE call_id=$1', [callId])).rows[0]
    if (row?.state === state) return row.lease_id
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Paired exact reader state missing')
}
async function pausedPrivateReader(callId: string) {
  return bounded(new Promise<{ response: IncomingMessage; terminal: Promise<void>; close(): void }>((resolve, reject) => {
    const request = httpRequest(origin + '/api/sparra/audio/' + callId, { agent: false, headers: { cookie } })
    request.once('error', () => reject(new Error('Paired reader request failed')))
    request.once('response', response => {
      response.pause(); response.on('error', () => {})
      const terminal = new Promise<void>(done => { response.once('close', done); response.once('aborted', done) })
      resolve({ response, terminal, close() { response.destroy(); request.destroy() } })
    })
    request.end()
  }), 2000)
}

async function saveRecordingPolicy(policy: 'off' | 'local_30d', expectedRevision: number) {
  const saved = await nativeRpc('saveActivity', { expectedRevision,
    businessName: 'Native capture fixture', sector: 'garage', knowledge: { openingHours: '', services: '', prices: '', faq: '', instructions: '' },
    transferDestination: null, recordingEnabled: false, recordingPolicy: policy,
    recordingContactPhone: policy === 'local_30d' ? '+33123456789' : null })
  expect(saved.status).toBe(200); await saved.body?.cancel()
  const revision = (await stores.administrator.query<{ revision: number; recording_policy: string }>(
    'SELECT revision,recording_policy FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision DESC LIMIT 1',
    [workspaceId])).rows[0]
  expect(revision).toEqual({ revision: expectedRevision + 1, recording_policy: policy })
}

test('native OFF call keeps its original pin when the owner saves ON during the call', async () => {
  await saveRecordingPolicy('off', 1)
  const admitted = await voice.command('audio-off-admit')
  expect(admitted).toMatchObject({ revision: 2, recording_policy: 'off', audio_available: false, recording_id: null })
  if (!admitted.call_id || !admitted.retention_until) throw new Error('Native OFF admission facts missing')
  const callId = admitted.call_id
  const pin = (await stores.administrator.query<{
    configuration_revision: number; recording_id: null; audio_state: string; audio_reserved_bytes: number;
    audio_charged_bytes: number; admitted_at: Date; retention_until: Date; status: string; ended_at: Date | null
  }>('SELECT configuration_revision,recording_id,audio_state,audio_reserved_bytes,audio_charged_bytes,admitted_at,retention_until,status,ended_at FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(pin).toMatchObject({ configuration_revision: 2, recording_id: null, audio_state: 'off',
    audio_reserved_bytes: 0, audio_charged_bytes: 0, status: 'active', ended_at: null })
  expect(pin.retention_until.toISOString()).toBe(admitted.retention_until)
  expect(pin.retention_until.getTime() - pin.admitted_at.getTime()).toBe(2_592_000_000)
  await saveRecordingPolicy('local_30d', 2)
  expect(await voice.command('audio-off-replay')).toEqual({
    original_pin: true, capture_owned: false, audio_chunks: 0, phone_live: true,
  })
  expect((await stores.administrator.query('SELECT configuration_revision,recording_id,audio_state,audio_reserved_bytes,audio_charged_bytes,admitted_at,retention_until,status,ended_at FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(pin)
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].count).toBe(0)
  const waveform = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
    { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  expect(waveform.status).toBe(409); await waveform.body?.cancel()
  const restarted = await voice.command('audio-next-candidate')
  expect(restarted).toMatchObject({
    previous_run_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    run_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    previous_consumed: true, current_consumed: false,
    previous_run_preserved: true, previous_closed: true,
  })
  expect(restarted.run_id).not.toBe(restarted.previous_run_id)
  // This existing consumer admits with native caller1 and waits for an actual
  // audio.chunk ACK. Its separate revoke action is deliberately never invoked.
  const next = await voice.command('audio-opposition-prime')
  expect(next).toMatchObject({ revision: 3, recording_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  expect(next.total_samples).toBeGreaterThanOrEqual(8000)
  expect(next.audio_chunks).toBeGreaterThanOrEqual(1)
  if (!next.call_id || !next.recording_id || !next.retention_until) {
    throw new Error('Native post-toggle ON admission facts missing')
  }
  expect(next.call_id).not.toBe(callId)
  const nextPin = (await stores.administrator.query<{
    configuration_revision: number; recording_id: string; audio_state: string;
    admitted_at: Date; retention_until: Date; status: string; ended_at: Date | null; recording_policy: string
  }>(`SELECT c.configuration_revision,c.recording_id,c.audio_state,c.admitted_at,c.retention_until,c.status,c.ended_at,r.recording_policy
    FROM sparra_call c JOIN sparra_knowledge_revision r ON r.workspace_id=c.workspace_id AND r.revision=c.configuration_revision
    WHERE c.id=$1`, [next.call_id])).rows[0]
  expect(nextPin).toMatchObject({ configuration_revision: 3, recording_id: next.recording_id,
    recording_policy: 'local_30d', audio_state: 'recording', status: 'active', ended_at: null })
  expect(nextPin.admitted_at.getTime()).toBeGreaterThanOrEqual(pin.admitted_at.getTime())
  expect(nextPin.retention_until.toISOString()).toBe(next.retention_until)
  expect(nextPin.retention_until.getTime() - nextPin.admitted_at.getTime()).toBe(2_592_000_000)
  const nextChunks = (await stores.administrator.query<{
    count: number; samples: number; original_pin: boolean
  }>(`SELECT count(*)::integer AS count,coalesce(sum(sample_count),0)::integer AS samples,
    bool_and(recording_id=$2 AND configuration_revision=3 AND retention_until=$3) AS original_pin
    FROM sparra_audio_chunk WHERE workspace_id=$4 AND call_id=$1`,
  [next.call_id, next.recording_id, next.retention_until, workspaceId])).rows[0]
  expect(nextChunks.count).toBeGreaterThanOrEqual(1)
  expect(nextChunks.samples).toBeGreaterThanOrEqual(8000)
  expect(nextChunks.original_pin).toBe(true)
  const immutablePin = { configuration_revision: pin.configuration_revision, recording_id: pin.recording_id,
    audio_state: pin.audio_state, audio_reserved_bytes: pin.audio_reserved_bytes,
    audio_charged_bytes: pin.audio_charged_bytes, admitted_at: pin.admitted_at, retention_until: pin.retention_until }
  expect((await stores.administrator.query('SELECT configuration_revision,recording_id,audio_state,audio_reserved_bytes,audio_charged_bytes,admitted_at,retention_until FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(immutablePin)
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].count).toBe(0)
  expect(await voice.stop()).toEqual({ code: 0, signal: null })
  expect(voice.nativeCloseCompleted()).toBe(true)
  // The normal ON consumer separately retains its full512000-sample WAV gate.
  // This chain proves the actual next admission uses the newly saved revision.
})

test('native caller two before acceptance keeps the call active without retaining audio', async () => {
  const admitted = await voice.command('audio-decline-admit')
  expect(admitted).toMatchObject({ revision: 1, recording_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  if (!admitted.call_id || !admitted.retention_until) throw new Error('Native declined admission facts missing')
  const callId = admitted.call_id
  const original = (await stores.administrator.query('SELECT configuration_revision,admitted_at,retention_until,status,ended_at,from_e164,encrypted_turns,encrypted_message_result FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(original).toMatchObject({ configuration_revision: 1, status: 'active', ended_at: null, from_e164: null })
  expect(original.retention_until.toISOString()).toBe(admitted.retention_until)
  expect(original.retention_until.getTime() - original.admitted_at.getTime()).toBe(2_592_000_000)
  expect(await voice.command('audio-decline-check')).toEqual({
    choice_off: true, audio_chunks: 0, phone_live: true, capture_joined: true,
  })
  const audio = (await stores.administrator.query('SELECT audio_state,audio_denied_at,audio_reserved_bytes FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(audio).toMatchObject({ audio_state: 'declined', audio_denied_at: expect.any(Date), audio_reserved_bytes: 0 })
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].count).toBe(0)
  expect((await stores.administrator.query('SELECT configuration_revision,admitted_at,retention_until,status,ended_at,from_e164,encrypted_turns,encrypted_message_result FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(original)
  const waveform = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
    { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  expect(waveform.status).toBe(409); await waveform.body?.cancel()
  expect(await voice.stop()).toEqual({ code: 0, signal: null })
  expect(voice.nativeCloseCompleted()).toBe(true)
  // No caller transcript is fabricated. This compares the actual stored
  // ciphertext fields; acoustic transcription remains a separate gate.
})

test('native caller two during capture rejects reactivation after processing late caller one and PCM', async () => {
  const admitted = await voice.command('audio-opposition-prime')
  expect(admitted.total_samples).toBeGreaterThanOrEqual(8000)
  expect(admitted.audio_chunks).toBeGreaterThanOrEqual(1)
  if (!admitted.call_id || !admitted.recording_id || !admitted.retention_until) {
    throw new Error('Native opposition admission facts missing')
  }
  const callId = admitted.call_id
  const pin = (await stores.administrator.query('SELECT configuration_revision,recording_id,admitted_at,retention_until,status,ended_at,from_e164 FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(pin).toMatchObject({ configuration_revision: 1, recording_id: admitted.recording_id,
    status: 'active', ended_at: null, from_e164: null })
  expect(pin.retention_until.toISOString()).toBe(admitted.retention_until)
  expect(pin.retention_until.getTime() - pin.admitted_at.getTime()).toBe(2_592_000_000)
  expect((await stores.administrator.query('SELECT audio_state FROM sparra_call WHERE id=$1', [callId])).rows[0].audio_state).toBe('recording')
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].count).toBeGreaterThanOrEqual(1)
  expect(await voice.command('audio-opposition-revoke')).toEqual({
    choice_off: true, capture_joined: true, phone_live: true,
  })
  const denied = (await stores.administrator.query('SELECT audio_state,audio_denied_at,audio_reserved_bytes FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(denied).toEqual({ audio_state: 'declined', audio_denied_at: expect.any(Date), audio_reserved_bytes: 0 })
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].count).toBe(0)
  expect((await stores.administrator.query('SELECT configuration_revision,recording_id,admitted_at,retention_until,status,ended_at,from_e164 FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(pin)
  const waveform = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
    { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  expect(waveform.status).toBe(409); await waveform.body?.cancel()
  expect(await voice.command('audio-opposition-late')).toEqual({
    late_dtmf_handled: true, late_pcm_processed: 8, choice_off: true, capture_joined: true, phone_live: true,
  })
  expect((await stores.administrator.query('SELECT audio_state,audio_denied_at,audio_reserved_bytes FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(denied)
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].count).toBe(0)
  expect((await stores.administrator.query('SELECT configuration_revision,recording_id,admitted_at,retention_until,status,ended_at,from_e164 FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(pin)
  expect(await voice.stop()).toEqual({ code: 0, signal: null })
  expect(voice.nativeCloseCompleted()).toBe(true)
  // Actual native serializer/frame IDs and pass-through tap/keypad consumers
  // prove late input processing. This does not assert acoustic transcription,
  // a second admission, transfer, capture cutoff, expiry or all B1-B5 races.
})

test('native PARTIAL hangup capture and private reader join erase after the real Voice ACK', async () => {
  phase('test-entered')
  const admitted = await voice.command('audio-admit')
  phase('audio-admit-ready')
  expect(admitted.call_id).toMatch(/^[0-9a-f-]{36}$/); expect(admitted.recording_id).toMatch(/^[0-9a-f-]{36}$/)
  if (!admitted.call_id || !admitted.retention_until) throw new Error('Native admission facts missing')
  const callId = admitted.call_id
  const completed = await voice.command('audio-finish')
  phase('audio-finish-ready')
  expect(completed.total_samples).toBeGreaterThanOrEqual(512000)
  expect(completed.pcm_sha256).toMatch(/^[0-9a-f]{64}$/)
  const audio = (await stores.administrator.query('SELECT audio_state,audio_total_samples,retention_until,admitted_at FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(audio.audio_state).toBe('partial')
  expect(audio.audio_total_samples).toBe(completed.total_samples)
  expect(audio.retention_until.toISOString()).toBe(admitted.retention_until)
  expect(audio.retention_until.getTime() - audio.admitted_at.getTime()).toBe(2_592_000_000)
  const waveform = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
    { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  expect(waveform.status).toBe(200)
  const bytes = Buffer.from(await waveform.arrayBuffer())
  try {
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.readUInt32LE(40)).toBe(completed.total_samples! * 4)
    expect(createHash('sha256').update(bytes.subarray(44)).digest('hex')).toBe(completed.pcm_sha256)
  } finally { bytes.fill(0) }
  expect(await voice.command('audio-hold-ack')).toMatchObject({ ack_held: true })
  const held = await pausedPrivateReader(callId)
  try {
    expect(held.response.statusCode).toBe(200)
    const leaseId = await exactReader(callId, 'active')
    const erased = await nativeRpc('eraseRequest', { requestId: callId })
    expect(erased.status).toBe(200)
    const eraseEnvelope = fromCrossJSON<unknown>(googleRpcNode(await erased.json()), { refs: new Map() })
    if (!eraseEnvelope || typeof eraseEnvelope !== 'object' || !('result' in eraseEnvelope)
      || !eraseEnvelope.result || typeof eraseEnvelope.result !== 'object'
      || !('requestId' in eraseEnvelope.result) || !('state' in eraseEnvelope.result)) {
      throw new Error('Native erasure receipt result missing')
    }
    expect(eraseEnvelope.result.requestId === callId).toBe(true)
    expect(eraseEnvelope.result.state).toBe('queued')
    const erasureFacts = (await stores.administrator.query(`SELECT state='queued' AS queued,
      lease_token IS NOT NULL AS leased,local_cleanup_completed_at IS NULL AS cleanup_pending,
      EXISTS(SELECT 1 FROM sparra_call c WHERE c.id=e.call_id) AS call_present,
      EXISTS(SELECT 1 FROM sparra_call c WHERE c.id=e.call_id AND c.erasure_requested_at IS NOT NULL) AS call_fenced
      FROM sparra_erasure e WHERE call_id=$1`, [callId])).rows[0]
    if (!erasureFacts) throw new Error('Native erasure receipt not persisted')
    console.log('PAIRED_ERASURE_STATE ' + JSON.stringify(erasureFacts))
    expect(erasureFacts).toMatchObject({ queued: true, cleanup_pending: true, call_present: false })
    expect(await voice.command('audio-erasure-held')).toMatchObject({ writer_cleaned: true, ack_held: true,
      cleanup_commit_held: true, cleanup_command: 'erase' })
    expect(await exactReader(callId, 'released')).toBe(leaseId)
    held.response.resume(); await bounded(held.terminal, 2000)
    expect(held.response.complete).toBe(false)
    const queued = (await stores.administrator.query('SELECT state,local_cleanup_completed_at,original_retention_until FROM sparra_erasure WHERE call_id=$1', [callId])).rows[0]
    expect(queued).toMatchObject({ state: 'queued', local_cleanup_completed_at: null })
    expect(queued.original_retention_until.toISOString()).toBe(admitted.retention_until)
    expect(await voice.command('audio-release-ack')).toMatchObject({ cleaned: true, ack_before_scrub: false })
    const receipt = (await stores.administrator.query('SELECT state,local_cleanup_completed_at FROM sparra_erasure WHERE call_id=$1', [callId])).rows[0]
    expect(receipt).toMatchObject({ state: 'completed', local_cleanup_completed_at: expect.any(Date) })
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_audio_chunk WHERE call_id=$1', [callId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_call WHERE id=$1', [callId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM voice_private.recording_purge WHERE call_id=$1', [callId])).rows[0].n).toBe(0)
    expect(await exactReader(callId, 'released')).toBe(leaseId)
    expect(await voice.stop()).toEqual({ code: 0, signal: null })
  } finally { held.close() }
})

test('native ON capture reaches ready through normal EndFrame and serves its original 30-day WAV', async () => {
  const admitted = await voice.command('audio-admit')
  expect(admitted.call_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(admitted.recording_id).toMatch(/^[0-9a-f-]{36}$/)
  if (!admitted.call_id || !admitted.recording_id || !admitted.retention_until || admitted.revision === undefined) {
    throw new Error('Native normal admission facts missing')
  }
  const callId = admitted.call_id
  const completed = await voice.command('audio-complete')
  expect(completed.total_samples).toBeGreaterThanOrEqual(512000)
  expect(completed.pcm_sha256).toMatch(/^[0-9a-f]{64}$/)
  if (completed.total_samples === undefined || completed.pcm_sha256 === undefined) {
    throw new Error('Native normal capture facts missing')
  }
  const audio = (await stores.administrator.query<{
    audio_state: string; audio_finish_reason: string | null; audio_total_samples: number;
    audio_last_sequence: number | null; audio_reserved_bytes: number; retention_until: Date; admitted_at: Date
  }>('SELECT audio_state,audio_finish_reason,audio_total_samples,audio_last_sequence,audio_reserved_bytes,retention_until,admitted_at FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(audio).toMatchObject({ audio_state: 'ready', audio_finish_reason: 'complete',
    audio_total_samples: completed.total_samples, audio_reserved_bytes: 0 })
  if (audio.audio_last_sequence === null) throw new Error('Native normal final sequence missing')
  expect(audio.retention_until.toISOString()).toBe(admitted.retention_until)
  expect(audio.retention_until.getTime() - audio.admitted_at.getTime()).toBe(2_592_000_000)
  const chunks = (await stores.administrator.query<{
    count: number; samples: number; first_sequence: number; last_sequence: number; original_pin: boolean
  }>(`SELECT count(*)::integer AS count,coalesce(sum(sample_count),0)::integer AS samples,
    min(sequence) AS first_sequence,max(sequence) AS last_sequence,
    bool_and(recording_id=$2 AND configuration_revision=$3 AND retention_until=$4) AS original_pin
    FROM sparra_audio_chunk WHERE workspace_id=$5 AND call_id=$1`,
  [callId, admitted.recording_id, admitted.revision, admitted.retention_until, workspaceId])).rows[0]
  expect(chunks).toEqual({ count: audio.audio_last_sequence + 1, samples: completed.total_samples,
    first_sequence: 0, last_sequence: audio.audio_last_sequence, original_pin: true })
  const waveform = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
    { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  expect(waveform.status).toBe(200)
  const bytes = Buffer.from(await waveform.arrayBuffer())
  try {
    expect(bytes.length).toBe(44 + completed.total_samples * 4)
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8)
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE')
    expect(bytes.subarray(12, 16).toString()).toBe('fmt ')
    expect(bytes.readUInt32LE(16)).toBe(16)
    expect(bytes.readUInt16LE(20)).toBe(1)
    expect(bytes.readUInt16LE(22)).toBe(2)
    expect(bytes.readUInt32LE(24)).toBe(8000)
    expect(bytes.readUInt32LE(28)).toBe(32000)
    expect(bytes.readUInt16LE(32)).toBe(4)
    expect(bytes.readUInt16LE(34)).toBe(16)
    expect(bytes.subarray(36, 40).toString()).toBe('data')
    expect(bytes.readUInt32LE(40)).toBe(completed.total_samples * 4)
    expect(createHash('sha256').update(bytes.subarray(44)).digest('hex')).toBe(completed.pcm_sha256)
  } finally { bytes.fill(0) }
  expect(await exactReader(callId, 'released')).toMatch(/^[0-9a-f-]{36}$/)
  expect((await stores.administrator.query('SELECT count(*)::integer AS count FROM voice_private.recording_purge WHERE call_id=$1', [callId])).rows[0].count).toBe(0)
  expect(await voice.stop()).toEqual({ code: 0, signal: null })
  expect(voice.nativeCloseCompleted()).toBe(true)
})

test('native candidate CLI refuses stopped success after post-close fixture failure (protocol only)', async () => {
  // One actual candidate composition. This probes the CLI shutdown contract;
  // it does not qualify a call, capture, recording or provider purge.
  await expect(voice.stop(true)).rejects.toThrow('Connected Voice RuntimeError')
  expect(voice.nativeCloseCompleted()).toBe(true)
  expect(await voice.cleanup()).toEqual({ code: 1, signal: null })
  expectedVoiceExit = 1
})

test(TRANSFER_CAPTURE_TEST, async () => {
  const transferred = await voice.command('audio-transfer-boundary')
  expect(transferred).toMatchObject({ capture_joined: true, phone_live: true,
    checks: ['native-transfer-real-tool-tail-joined-before-intent-and-sdk'] })
  if (!transferred.call_id || !transferred.retention_until) throw new Error('Native transfer admission facts missing')
  const call = (await stores.administrator.query<{
    admitted_at: Date; retention_until: Date; status: string; ended_at: Date | null
  }>('SELECT admitted_at,retention_until,status,ended_at FROM sparra_call WHERE id=$1', [transferred.call_id])).rows[0]
  expect(call).toMatchObject({ status: 'active', ended_at: null })
  expect(call.retention_until.toISOString()).toBe(transferred.retention_until)
  expect(call.retention_until.getTime() - call.admitted_at.getTime()).toBe(2_592_000_000)
  const callId = transferred.call_id
  // Capture/transfer authority commits to SQLite before SDK dispatch; the
  // private reader consumes the separate real PG delivery of that finish.
  await expect.poll(async () => (await stores.administrator.query(`SELECT audio_state,
    audio_finish_reason,audio_total_samples > 0 AS has_samples FROM sparra_call WHERE id=$1`,
  [callId])).rows[0], { timeout: 2000, interval: 20 }).toEqual({ audio_state: 'partial',
    audio_finish_reason: 'transfer', has_samples: true })
  async function persistedCallState() {
    const calls = await stores.administrator.query(`SELECT id,configuration_revision,recording_id,
      deployment_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id,
      admitted_at,retention_until,status,ended_at,encrypted_turns::text,
      encrypted_message_result::text,transcript_loss_count,audio_state,audio_total_samples,
      audio_last_sequence,audio_finish_reason,audio_reserved_bytes,audio_charged_bytes
      FROM sparra_call WHERE workspace_id=$1 ORDER BY id`, [workspaceId])
    const revisions = await stores.administrator.query(`SELECT revision,recording_policy,
      recording_enabled,recording_contact_phone FROM sparra_knowledge_revision
      WHERE workspace_id=$1 ORDER BY revision`, [workspaceId])
    return { calls: calls.rows, revisions: revisions.rows }
  }
  const original = await persistedCallState()
  expect(original.calls).toHaveLength(1)
  expect(original.calls[0]).toMatchObject({ id: callId, audio_state: 'partial',
    audio_finish_reason: 'transfer', audio_reserved_bytes: 0, status: 'active', ended_at: null })
  expect(original.calls[0].audio_total_samples).toBeGreaterThan(0)
  const waveform = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
    { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  expect(waveform.status).toBe(200)
  const baseline = Buffer.from(await waveform.arrayBuffer())
  try {
    expect(baseline.subarray(0, 4).toString()).toBe('RIFF')
    expect(baseline.subarray(8, 12).toString()).toBe('WAVE')
    const baselineLease = await exactReader(callId, 'released')
    expect(baselineLease).toMatch(/^[0-9a-f-]{36}$/)
    const leases = new Set([baselineLease])
    expect(baseline.length).toBe(44 + original.calls[0].audio_total_samples * 4)
    expect(await persistedCallState()).toEqual(original)
    // The same original phone remains live after capture ends. Each compiled
    // GET consumes its own exact native lease, including non-aligned PCM bytes.
    for (const [start, end] of [[0, 43], [44, 73], [45, 98], [baseline.length - 32, baseline.length - 1]]) {
      const ranged = await loopbackFetch(origin + '/api/sparra/audio/' + callId,
        { headers: { cookie, range: 'bytes=' + start + '-' + end }, signal: AbortSignal.timeout(10000) })
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get('content-range')).toBe('bytes ' + start + '-' + end + '/' + baseline.length)
      expect(ranged.headers.get('content-length')).toBe(String(end - start + 1))
      const bytes = Buffer.from(await ranged.arrayBuffer())
      try { expect(bytes).toEqual(baseline.subarray(start, end + 1)) }
      finally { bytes.fill(0) }
      const lease = await exactReader(callId, 'released')
      expect(lease).toMatch(/^[0-9a-f-]{36}$/)
      expect(leases.has(lease)).toBe(false)
      leases.add(lease)
      expect((await stores.administrator.query(`SELECT call_id,lease_id,state,released_at
        FROM sparra_audio_reader WHERE workspace_id=$1`, [workspaceId])).rows).toEqual([
        { call_id: callId, lease_id: lease, state: 'released', released_at: expect.any(Date) },
      ])
      expect(await persistedCallState()).toEqual(original)
    }
    expect(leases.size).toBe(5)
    expect(await voice.command('audio-transfer-reader-live')).toEqual({ call_id: callId,
      live_call_count: 1, answer_actions: 1, transfer_actions: 1, hangup_actions: 0,
      bridge_seen: false, original_end_seen: false, provider_actions_unchanged: true })
    expect(await persistedCallState()).toEqual(original)
  } finally { baseline.fill(0) }
}, 20000)
