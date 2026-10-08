import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { chromium, type BrowserContext } from 'playwright'
import { Pool } from 'pg'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { fetch as loopbackFetch } from 'undici'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { cryptoFixture, resolveVoiceProducer } from '../helpers/sparra-crypto-fixture'
import { bounded, unusedLoopbackPort } from '../helpers/web-process'
import { nativeImage } from '../helpers/native-image'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'
import { createRequestOperations, type EraseReceipt } from '../../src/modules/sparra/requests.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import type { WebResources } from '../../src/platform/resources.server'
import { audioResponse } from '../../src/modules/sparra/audio-reader.server'
import { AudioUnavailable, createAudioOperations, decryptAudioChunk } from '../../src/modules/sparra/audio.server'

// Real Google owner/PG/PgBouncer/Voice codec/compiled HTTP consumers. PCM and
// disclosure facts are synthetic fixture inputs, not native/live caller proof.
type PlaybackProducerRequest = {
  url: string; deployment_id: string; call_id: string; keyring_path: string; pcm_b64: string; revoke?: PlaybackProducerResult
}
type PlaybackProducerResult = { call_id: string; recording_id: string; retention_until: string; workspace_id: string; configuration_revision: number }
let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>
let auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
let transactions: ReturnType<typeof createTransactions>, sourceResources: WebResources
let crypto: Awaited<ReturnType<typeof cryptoFixture>>
let app: Awaited<ReturnType<Awaited<ReturnType<typeof startDisposableStores>>['startWebImage']>>
let ownerCookie: string, callId: string, origin: string
let createForeignOwner: () => Promise<string>
let eraseOwnedRequest: (id: string) => Promise<EraseReceipt>
const deployment = 'playback-fixture'
const pcm = Buffer.alloc(64)
for (let sample = 0; sample < 16; sample++) {
  pcm.writeInt16LE(1000 + sample * 37, sample * 4)
  pcm.writeInt16LE(-500 - sample * 29, sample * 4 + 2)
}

function expectedWave(): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function nativePlayback(request: PlaybackProducerRequest): Promise<PlaybackProducerResult> {
  const producer = await resolveVoiceProducer()
  const home = process.env.SPARRA_VOICE_TEST_HOME, nltk = process.env.SPARRA_VOICE_NLTK_DATA
  if (!home || !nltk || !isAbsolute(home) || !isAbsolute(nltk)) throw new Error('Voice playback prerequisite missing')
  return new Promise((accept, reject) => {
    const child = spawn(producer.pythonExecutable, ['-I', '-B', resolve('tests/helpers/sparra-audio-playback-driver.py')], {
      cwd: dirname(producer.sourceRoot), windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
        TMP: process.env.TMP, HOME: home, APPDATA: home, NLTK_DATA: nltk, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Voice playback fixture deadline')) }, 15000)
    let output = ''
    child.stdout.on('data', data => {
      output += String(data)
      if (Buffer.byteLength(output) > 4096) { child.kill(); reject(new Error('Voice playback fixture output bound')) }
    })
    child.stderr.resume()
    child.once('error', () => { clearTimeout(timer); reject(new Error('Voice playback fixture startup')) })
    child.once('close', code => {
      clearTimeout(timer)
      try {
        const reply: { ok?: PlaybackProducerResult; error?: string } = JSON.parse(output)
        if (code !== 0 || reply.error || !reply.ok || reply.ok.call_id !== request.call_id) throw new Error()
        accept(reply.ok)
      } catch { reject(new Error('Voice playback fixture failed')) }
    })
    // Only owned generated material crosses stdin; no credential argument/log export.
    child.stdin.end(JSON.stringify({ ...request, source_root: producer.sourceRoot }))
  })
}

beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrate()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  const port = await unusedLoopbackPort()
  origin = 'http://localhost:' + port
  peer = await startGoogleProtocolPeer({ ports: [port, ...[stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(url => Number(new URL(url).port))] })
  const { createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server')
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 4 })
  transactions = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const secret = randomBytes(48).toString('hex')
  limiter = createAuthRateLimiter(readRateLimitConfig({ REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'playback', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  await limiter.connect()
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', AUTH_SECRET: secret,
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })
  if (!config) throw new Error('Playback auth fixture unavailable')
  auth = createApplicationAuth(transactions, config, limiter)
  const ceremony = googleCeremony(auth, transactions, peer)
  const owner = await ceremony()
  ownerCookie = owner.cookie
  const personal = createPersonalWorkspaces(transactions)
  // These are the actual owned auth/SQL primitives. This source-only fixture has
  // no native response body owner; the compiled image owns playback separately.
  sourceResources = { transactions, auth, limiter, workspaces: personal,
    isReady: () => !pool.ending && !pool.ended && limiter.isReady() }
  eraseOwnedRequest = id => createRequestOperations(transactions).erase(owner.principal,id)
  createForeignOwner = async () => {
    const foreign = await ceremony()
    await personal.ensurePersonalWorkspace(foreign.principal)
    return foreign.cookie
  }
  const workspace = await personal.ensurePersonalWorkspace(owner.principal)
  if (!workspace) throw new Error('Playback Workspace missing')
  await stores.administrator.query("INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled) SELECT 'sparra_voice_a',oid,$1,$2,'playback-connection','+33123456789',true,false,2,true FROM pg_roles WHERE rolname='sparra_voice_a'", [deployment, workspace.id])
  await stores.administrator.query('GRANT USAGE ON SCHEMA voice TO sparra_voice_a; GRANT EXECUTE ON FUNCTION voice.begin_call_v2(text,uuid,jsonb),voice.ingest_operation_v2(jsonb) TO sparra_voice_a')
  await createActivityOperations(transactions).save(owner.principal, { expectedRevision: 0, businessName: 'Playback fixture', sector: 'garage',
    knowledge: { openingHours: '', services: '', prices: '', faq: '', instructions: '' }, transferDestination: null,
    recordingEnabled: false, recordingPolicy: 'local_30d', recordingContactPhone: '+33123456789' })
  crypto = await cryptoFixture()
  callId = randomUUID()
  const produced = await nativePlayback({ url: stores.voiceUrlA, deployment_id: deployment, call_id: callId,
    keyring_path: crypto.path, pcm_b64: pcm.toString('base64') })
  expect(produced.call_id).toBe(callId)
  const state = (await stores.administrator.query('SELECT audio_state,audio_last_sequence,audio_total_samples,ended_at FROM sparra_call WHERE id=$1', [callId])).rows[0]
  expect(state).toMatchObject({ audio_state: 'ready', audio_last_sequence: 0, audio_total_samples: 16, ended_at: null })
  app = await stores.startWebImage(await nativeImage('web'),'valid',
    {secret,googleClientId:'fixture.apps.googleusercontent.com',googleClientSecret:'fixture-only'},
    JSON.stringify(crypto.keyring),false,port,{incarnation:randomUUID(),deploymentId:'playback-app-fixture'})
  origin = app.url
}, 180000)

afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [async() => {if(app){await stores.signalWeb(app.id,'SIGTERM');expect(await stores.waitWeb(app.id)).toBe(0)}}, () => auth?.close(), () => limiter?.close(),
    () => pool?.end(), () => peer?.close(), () => crypto?.cleanup(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Playback fixture cleanup failed')
}, 30000)

function playback(cookie: string, method: 'GET' | 'HEAD' = 'GET', range?: string, id = callId) {
  return loopbackFetch(origin + '/api/sparra/audio/' + id, { method, redirect: 'manual',
    headers: { cookie, ...(range === undefined ? {} : { range }) }, signal: AbortSignal.timeout(10000) })
}

function sourceRequest(cookie: string, method: 'GET' | 'HEAD' = 'HEAD', range?: string, id = callId) {
  const request = new Request('http://localhost:3000/api/sparra/audio/' + id, { method,
    headers: { cookie, ...(range === undefined ? {} : { range }) }, signal: AbortSignal.timeout(10000) })
  Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  return request
}

test('compiled private GET returns the actual Voice PCM in the exact WAV44 representation', async () => {
  const principal = await auth.requirePrincipal(sourceRequest(ownerCookie))
  const operations = createAudioOperations(transactions), pin = await operations.read(principal, callId)
  // Opaque metadata fixture for source SQL/crypto checks, not a startup or
  // container attestation. No native response or plaintext holder is created.
  const exact = await operations.acquire(principal, pin, { incarnation: randomUUID(),
    containerId: 'a'.repeat(64), deploymentId: 'source-playback-metadata-fixture' },
  Date.now() + 10000, new AbortController().signal)
  let plaintext: Buffer | undefined
  vi.stubEnv('SPARRA_AEAD_KEYRING_PATH', crypto.path)
  try {
    const signal = new AbortController().signal
    const chunk = await operations.page(principal, pin, exact, 0, signal)
    plaintext = await decryptAudioChunk(chunk)
    expect(createHash('sha256').update(plaintext).digest('hex')).toBe(createHash('sha256').update(pcm).digest('hex'))
    expect(plaintext).toEqual(pcm)
    await expect(operations.page(principal, pin, exact, 1, signal)).rejects.toBeInstanceOf(AudioUnavailable)
    await expect(operations.page(principal, { ...pin, deploymentId: 'foreign-deployment' }, exact, 0, signal)).rejects.toBeInstanceOf(AudioUnavailable)
    await expect(decryptAudioChunk({ ...chunk, recordingId: randomUUID() })).rejects.toBeInstanceOf(AudioUnavailable)
    await expect(decryptAudioChunk({ ...chunk, keyVersion: chunk.keyVersion + 1 })).rejects.toBeInstanceOf(AudioUnavailable)
  } finally {
    plaintext?.fill(0); vi.unstubAllEnvs()
    expect(await operations.release(exact)).toBe(true)
  }
  const response = await playback(ownerCookie)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('audio/wav')
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-length')).toBe(String(expectedWave().length))
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  expect(Buffer.from(await response.arrayBuffer())).toEqual(expectedWave())
})

test('raw playback refuses anonymous and cross-Workspace callers without exposing PCM', async () => {
  for (const [caller, status] of [['anonymous', 401], ['foreign', 404]] as const) {
    const cookie = caller === 'foreign' ? await createForeignOwner() : ''
    const source = await audioResponse(sourceRequest(cookie), callId, sourceResources)
    expect(source.status).toBe(status)
    expect(Buffer.from(await source.arrayBuffer()).includes(pcm)).toBe(false)
    const response = await playback(cookie)
    expect(response.status).toBe(status)
    expect(Buffer.from(await response.arrayBuffer()).includes(pcm)).toBe(false)
  }
  const malformed = await playback(ownerCookie, 'GET', undefined, 'not-a-uuid')
  expect(malformed.status).toBe(400)
  await malformed.arrayBuffer()
  const malformedSource = await audioResponse(sourceRequest(ownerCookie, 'HEAD', undefined, 'not-a-uuid'), 'not-a-uuid', sourceResources)
  expect(malformedSource.status).toBe(400)
  await malformedSource.arrayBuffer()
})

test('authenticated HEAD returns WAV metadata and no binary body', async () => {
  const source = await audioResponse(sourceRequest(ownerCookie), callId, sourceResources)
  expect(source.status).toBe(200)
  expect(source.headers.get('content-type')).toBe('audio/wav')
  expect(source.headers.get('content-length')).toBe(String(expectedWave().length))
  expect((await source.arrayBuffer()).byteLength).toBe(0)
  const unavailableSourceBody = await audioResponse(sourceRequest(ownerCookie, 'GET'), callId, sourceResources)
  expect(unavailableSourceBody.status).toBe(409)
  expect(Buffer.from(await unavailableSourceBody.arrayBuffer()).includes(pcm)).toBe(false)
  const response = await playback(ownerCookie, 'HEAD')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('audio/wav')
  expect(response.headers.get('content-length')).toBe(String(expectedWave().length))
  expect((await response.arrayBuffer()).byteLength).toBe(0)
})

test('native single Range returns exact bytes and rejects malformed or multipart ranges', async () => {
  const wave = expectedWave()
  for (const [start, end] of [[0, 43], [44, 47]]) {
    const source = await audioResponse(sourceRequest(ownerCookie, 'HEAD', 'bytes=' + start + '-' + end), callId, sourceResources)
    expect(source.status).toBe(206)
    expect(source.headers.get('content-range')).toBe('bytes ' + start + '-' + end + '/' + wave.length)
    expect(source.headers.get('content-length')).toBe(String(end - start + 1))
    expect((await source.arrayBuffer()).byteLength).toBe(0)
    const response = await playback(ownerCookie, 'GET', 'bytes=' + start + '-' + end)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes ' + start + '-' + end + '/' + wave.length)
    expect(response.headers.get('content-length')).toBe(String(end - start + 1))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wave.subarray(start, end + 1))
  }
  for (const range of ['bytes=' + wave.length + '-', 'bytes=0-1,3-4', 'bytes=none']) {
    const source = await audioResponse(sourceRequest(ownerCookie, 'HEAD', range), callId, sourceResources)
    expect(source.status).toBe(416)
    await source.arrayBuffer()
    const response = await playback(ownerCookie, 'GET', range)
    expect(response.status).toBe(416)
    await response.arrayBuffer()
  }
})

async function largeNativeCall() {
  const data=Buffer.alloc(2_048_000)
  for(let offset=0;offset<data.length;offset+=pcm.length)pcm.copy(data,offset)
  try{
    return await nativePlayback({url:stores.voiceUrlA,deployment_id:deployment,call_id:randomUUID(),
      keyring_path:crypto.path,pcm_b64:data.toString('base64')})
  }finally{data.fill(0)}
}
async function pausedNativeResponse(id:string) {
  return bounded(new Promise<{response:IncomingMessage;terminal:Promise<void>;close():void}>((accept,reject)=>{
    const request=httpRequest(origin+'/api/sparra/audio/'+id,{headers:{cookie:ownerCookie},agent:false})
    request.once('error',()=>reject(new Error('Paused playback request failed')))
    request.once('response',response=>{
      response.pause()
      response.on('error',()=>{})
      const terminal=new Promise<void>(resolve=>{
        response.once('aborted',resolve);response.once('close',resolve)
      })
      accept({response,terminal,close:()=>{response.destroy();request.destroy()}})
    })
    request.end()
  }),3000)
}
async function observedReaderState(id:string,state:'active'|'released') {
  const deadline=Date.now()+2000
  while(Date.now()<deadline){
    const row=(await stores.administrator.query<{state:string;lease_id:string}>('SELECT state,lease_id FROM sparra_audio_reader WHERE call_id=$1',[id])).rows[0]
    if(row?.state===state)return row.lease_id
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  throw new Error('Exact reader state was not observed')
}
test('native audio revoke leaves the exact released slot and truncates the paused client response',async()=>{
  const call=await largeNativeCall(),held=await pausedNativeResponse(call.call_id)
  let leaseId:string|undefined
  try{
    expect(held.response.statusCode).toBe(200)
    expect(held.response.complete).toBe(false)
    leaseId=await observedReaderState(call.call_id,'active')
    await nativePlayback({url:stores.voiceUrlA,deployment_id:deployment,call_id:call.call_id,
      keyring_path:crypto.path,pcm_b64:'',revoke:call})
    expect(await observedReaderState(call.call_id,'released')).toBe(leaseId)
    // Received client bytes cannot be recalled. Resume only after the control
    // action/server-slot observation to receive the real truncated FIN/RST.
    held.response.resume()
    await bounded(held.terminal,2000)
    expect(held.response.complete).toBe(false)
    expect(await observedReaderState(call.call_id,'released')).toBe(leaseId)
    const row=(await stores.administrator.query('SELECT audio_state,status,ended_at FROM sparra_call WHERE id=$1',[call.call_id])).rows[0]
    expect(row).toMatchObject({audio_state:'declined',status:'active',ended_at:null})
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM sparra_audio_chunk WHERE call_id=$1',[call.call_id])).rows[0].n).toBe(0)
  }catch(error){
    if(leaseId){
      try{
        const order=(await stores.administrator.query<{released_before_audio_denied:boolean}>(
          `SELECT r.released_at < c.audio_denied_at AS released_before_audio_denied
           FROM sparra_audio_reader AS r JOIN sparra_call AS c ON c.id=r.call_id AND c.workspace_id=r.workspace_id
           WHERE r.lease_id=$1 AND r.call_id=$2 AND isfinite(r.released_at) AND isfinite(c.audio_denied_at)`,
          [leaseId,call.call_id])).rows[0]
        if(typeof order?.released_before_audio_denied==='boolean')console.error('native_audio_reader_released_before_audio_denied',order.released_before_audio_denied)
      }catch{}
    }
    throw error
  }finally{held.close()}
})
test('native owner erase terminates a paused reader without completing unacknowledged Voice cleanup',async()=>{
  const call=await largeNativeCall(),held=await pausedNativeResponse(call.call_id)
  try{
    expect(held.response.statusCode).toBe(200)
    expect(held.response.complete).toBe(false)
    const leaseId=await observedReaderState(call.call_id,'active')
    const receipt=await eraseOwnedRequest(call.call_id)
    expect(receipt).toEqual({requestId:call.call_id,state:'queued'})
    expect(await observedReaderState(call.call_id,'released')).toBe(leaseId)
    held.response.resume()
    await bounded(held.terminal,2000)
    expect(held.response.complete).toBe(false)
    expect(await observedReaderState(call.call_id,'released')).toBe(leaseId)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM sparra_audio_chunk WHERE call_id=$1',[call.call_id])).rows[0].n).toBe(0)
    const fence=(await stores.administrator.query('SELECT state,local_cleanup_completed_at,original_retention_until,provider_call_control_id FROM sparra_erasure WHERE call_id=$1',[call.call_id])).rows[0]
    expect(fence).toMatchObject({state:'queued',local_cleanup_completed_at:null,provider_call_control_id:'playback-'+call.call_id})
    expect(fence.original_retention_until.toISOString()).toBe(call.retention_until)
  }finally{held.close()}
})

test('actual private browser player clears its native source on owner erase at 320 and 1280',async()=>{
  const screenshots=process.env.SPARRA_PLAYBACK_SCREENSHOT_DIR
  if(!screenshots||!isAbsolute(screenshots))throw new Error('Owned playback screenshot directory required')
  await mkdir(screenshots,{recursive:true})
  const call=await largeNativeCall()
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required'],timeout:10000})
  const context=await browser.newContext({viewport:{width:320,height:800}})
  try{
    const cookies=ownerCookie.split('; ').map<Parameters<BrowserContext['addCookies']>[0][number]>(value=>{
      const separator=value.indexOf('=')
      if(separator<1)throw new Error('Native owner cookie malformed')
      return {name:value.slice(0,separator),value:value.slice(separator+1),domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax'}
    }).filter(cookie=>cookie.value.length>0)
    expect(cookies.filter(cookie=>cookie.name.endsWith('.session_token')).length).toBe(1)
    for(const cookie of cookies)await context.addCookies([cookie])
    const page=await context.newPage()
    await page.goto(origin+'/app/demandes/'+call.call_id+'?lang=fr',{waitUntil:'networkidle',timeout:10000})
    const player=page.locator('audio')
    await player.waitFor({state:'visible',timeout:3000})
    expect(await player.getAttribute('preload')).toBe('none')
    expect(await player.getAttribute('src')).toBe('/api/sparra/audio/'+call.call_id)
    for(const width of [320,1280]){
      await page.setViewportSize({width,height:800})
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.screenshot({path:join(screenshots,'private-audio-'+width+'.png'),fullPage:true})
    }
    const captured=await player.elementHandle()
    if(!captured)throw new Error('Native player handle unavailable')
    await player.evaluate(async element=>{
      if(!(element instanceof HTMLAudioElement))throw new Error('Native audio element required')
      await element.play()
    })
    expect(await player.evaluate(element=>element instanceof HTMLAudioElement&&!element.paused)).toBe(true)
    expect(await player.evaluate(element=>element instanceof HTMLAudioElement
      &&element.readyState>HTMLMediaElement.HAVE_NOTHING&&element.networkState!==HTMLMediaElement.NETWORK_EMPTY)).toBe(true)
    await page.getByRole('button',{name:/^Effacer/}).click()
    await page.getByRole('button',{name:/^Confirmer/}).click()
    await page.waitForFunction(element=>element instanceof HTMLAudioElement&&element.paused
      &&!element.isConnected&&!element.hasAttribute('src')
      &&element.readyState===HTMLMediaElement.HAVE_NOTHING&&element.networkState===HTMLMediaElement.NETWORK_EMPTY,
      captured,{timeout:3000})
    const replay=await captured.evaluate(async element=>{
      if(!(element instanceof HTMLAudioElement))throw new Error('Native audio element required')
      let playingEvents=0
      const onPlaying=()=>{playingEvents++}
      element.addEventListener('playing',onPlaying)
      try{
        const attempt=element.play().then(()=>'resolved',()=>'rejected')
        const attemptOutcome=await Promise.race([attempt,new Promise<string>(accept=>setTimeout(()=>accept('pending'),250))])
        const observed={attemptOutcome,playingEvents,readyState:element.readyState,hasSrc:element.hasAttribute('src')}
        element.pause()
        element.load()
        const stoppedOutcome=await Promise.race([attempt,new Promise<string>(accept=>setTimeout(()=>accept('pending'),250))])
        return {observed,stoppedOutcome,playingEvents,paused:element.paused,readyState:element.readyState,
          noSource:element.networkState===HTMLMediaElement.NETWORK_EMPTY||element.networkState===HTMLMediaElement.NETWORK_NO_SOURCE}
      }finally{
        element.pause()
        element.load()
        element.removeEventListener('playing',onPlaying)
      }
    })
    expect(replay.observed.attemptOutcome).not.toBe('resolved')
    expect(replay.observed).toMatchObject({playingEvents:0,readyState:0,hasSrc:false})
    expect(replay).toMatchObject({stoppedOutcome:'rejected',playingEvents:0,paused:true,readyState:0,noSource:true})
    expect(await page.locator('audio').count()).toBe(0)
    const fence=(await stores.administrator.query('SELECT state,local_cleanup_completed_at FROM sparra_erasure WHERE call_id=$1',[call.call_id])).rows[0]
    expect(fence).toMatchObject({state:'queued',local_cleanup_completed_at:null})
    await captured.dispose()
  }finally{
    try{await bounded(context.close(),3000)}finally{await bounded(browser.close(),3000)}
  }
})

test('compiled R1 session loss releases the exact paused reader without erasing audio or ending the phone call',async()=>{
  const call=await largeNativeCall()
  const before=(await stores.administrator.query('SELECT audio_state,status,ended_at,retention_until,recording_id,audio_total_samples,audio_last_sequence FROM sparra_call WHERE id=$1',[call.call_id])).rows[0]
  expect(before).toMatchObject({audio_state:'ready',status:'active',ended_at:null,recording_id:call.recording_id})
  expect(before.retention_until.toISOString()).toBe(call.retention_until)
  const chunksBefore=(await stores.administrator.query('SELECT count(*)::int AS n,sum(octet_length(ciphertext))::int AS bytes FROM sparra_audio_chunk WHERE call_id=$1',[call.call_id])).rows[0]
  expect(chunksBefore.n).toBeGreaterThan(0)
  expect(chunksBefore.bytes).toBeGreaterThan(0)
  const held=await pausedNativeResponse(call.call_id)
  try{
    expect(held.response.statusCode).toBe(200)
    expect(held.response.complete).toBe(false)
    const leaseId=await observedReaderState(call.call_id,'active')
    // Revoke only the real Google-issued owning session through R1's native
    // logout consumer. The unchanged cookie remains the subsequent request input.
    const logoutRequest=Object.assign(new Request('http://localhost:3000/_serverFn/fixture',{
      method:'POST',headers:{origin:'http://localhost:3000',cookie:ownerCookie,'x-real-ip':'192.0.2.180'},
    }),{runtime:{node:{req:{socket:{remoteAddress:'127.0.0.1'}}}}})
    Object.defineProperty(logoutRequest,'appAuthDeadlineAtMs',{value:Date.now()+10000})
    const principal=await auth.requirePrincipal(logoutRequest)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session WHERE id=$1',[principal.sessionId])).rows[0].n).toBe(1)
    const loggedOut=await auth.logout(logoutRequest)
    expect(loggedOut.headers.getSetCookie().some(cookie=>cookie.includes('Max-Age=0'))).toBe(true)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session WHERE id=$1',[principal.sessionId])).rows[0].n).toBe(0)
    expect(await observedReaderState(call.call_id,'released')).toBe(leaseId)
    // Already received bytes cannot be recalled. Drain only after native logout
    // and exact server-slot release to observe the truncated peer response.
    held.response.resume()
    await bounded(held.terminal,2000)
    expect(held.response.complete).toBe(false)
    expect(await observedReaderState(call.call_id,'released')).toBe(leaseId)
    const denied=await playback(ownerCookie,'GET',undefined,call.call_id)
    expect(denied.status).toBe(401)
    expect(Buffer.from(await denied.arrayBuffer()).includes(pcm)).toBe(false)
    expect((await stores.administrator.query('SELECT audio_state,status,ended_at,retention_until,recording_id,audio_total_samples,audio_last_sequence FROM sparra_call WHERE id=$1',[call.call_id])).rows[0]).toEqual(before)
    expect((await stores.administrator.query('SELECT count(*)::int AS n,sum(octet_length(ciphertext))::int AS bytes FROM sparra_audio_chunk WHERE call_id=$1',[call.call_id])).rows[0]).toEqual(chunksBefore)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM sparra_erasure WHERE call_id=$1',[call.call_id])).rows[0].n).toBe(0)
  }finally{
    held.close()
    await bounded(held.terminal,2000)
  }
})
