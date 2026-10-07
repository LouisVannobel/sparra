// One paired native PARTIAL hangup candidate: actual CallSession/Pipecat/SQLite/PgBouncer/PG
// and compiled private reader. Controlled media/inference is synthetic, not a
// qualified release, live carrier call or full Task4/B1–B5 acceptance.
import { afterEach, beforeEach, expect, test } from 'vitest'
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
let cookie: string, origin: string, workspaceId: string
let expectedVoiceExit = 0
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

beforeEach(async () => {
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
    transferDestination: null, recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789' })
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
    evidence_path: evidence, state_path: join(crypto.directory, 'voice-state'), audio_candidate: true, workspace_id: workspaceId }, producer)
  expect(await voice.ready).toMatchObject({ ready: true, candidate: true })
  phase('voice-ready')
  web = await stores.startWebImage(await nativeImage('web'), 'valid',
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

test('native candidate CLI refuses stopped success after post-close fixture failure (protocol only)', async () => {
  // One actual candidate composition. This probes the CLI shutdown contract;
  // it does not qualify a call, capture, recording or provider purge.
  await expect(voice.stop(true)).rejects.toThrow('Connected Voice RuntimeError')
  expect(voice.nativeCloseCompleted()).toBe(true)
  expect(await voice.cleanup()).toEqual({ code: 1, signal: null })
  expectedVoiceExit = 1
})
