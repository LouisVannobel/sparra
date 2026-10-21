import { expect, test, vi } from 'vitest'
import { Effect } from 'effect'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { authRpcPath } from '../helpers/auth-rpc'
import { rpcBody } from '../helpers/auth-rpc'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { cryptoFixture, resolveVoiceProducer } from '../helpers/sparra-crypto-fixture'
import { startConnectedVoice } from '../helpers/sparra-voice-driver'
import { startCalendarProtocolPeer } from '../helpers/calendar-protocol-peer.mjs'
import { createCalendarWorkerResources } from '../../src/platform/calendar-runtime.server'

type TransportObservation = { peer: Awaited<ReturnType<typeof startCalendarProtocolPeer>> | undefined; stops: number }
const transport = vi.hoisted((): TransportObservation => ({ peer: undefined, stops: 0 }))
vi.mock('../../src/platform/db/resources.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/platform/db/resources.server')>()
  return { ...actual, acquireDatabase: (...args: Parameters<typeof actual.acquireDatabase>) => actual.acquireDatabase(...args).pipe(Effect.map(database => ({ ...database,
    stop() {
      if (args[1] === 'calendar_worker') {
        expect(transport.peer?.evidence()).toMatchObject({ activeClientSockets: 0, activeRequests: 0 })
        transport.stops++
      }
      database.stop()
    },
  }))) }
})

test('compiled Calendar RPC exports are available to the authenticated native consumer', async () => {
  for (const name of ['getCalendar', 'beginCalendarConnection', 'saveCalendarPolicy', 'disconnectCalendar'] as const) {
    expect(await authRpcPath(name)).toMatch(/^\/_serverFn\/[a-f0-9]{64}$/)
  }
})

test.each(['confirmed', 'lost-response-restart', 'no-ack', 'retry-after-no-ack', 'cancelled-repeat', 'moved-repeat', 'selection-recovery'] as const)('native phone-only Calendar %s preserves booking authority and the authenticated compiled Inbox', async mode => {
  const stores = await startDisposableStores()
  let crypto: Awaited<ReturnType<typeof cryptoFixture>> | undefined
  let app: ReturnType<typeof startWeb> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let voice: ReturnType<typeof startConnectedVoice> | undefined
  let worker: ReturnType<typeof createCalendarWorkerResources> | undefined
  let peer: Awaited<ReturnType<typeof startCalendarProtocolPeer>> | undefined
  let voiceStopped = false
  let functionalFailure: unknown
  transport.stops = 0
  try {
    await stores.migrate()
    crypto = await cryptoFixture()
    await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime; GRANT SELECT ON public.passkey TO runtime')
    const port = await unusedLoopbackPort(), origin = 'http://localhost:' + port
    const env = { NODE_ENV: 'test', APP_ORIGIN: origin, PORT: String(port), DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
      RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'calendar-consumer', TRUSTED_PROXY_IPS: '127.0.0.1',
      AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only',
      REQUEST_TIMEOUT_MS: '10000', SPARRA_AEAD_KEYRING_PATH: crypto.path }
    app = startWeb({ ...env, FIXTURE_GOOGLE_PROTOCOL: 'yes' }); await bounded(app.ready)
    browser = await chromium.launch({ headless: true })
    let context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': '127.0.1.8' } }), page = await context.newPage()
    page.setDefaultTimeout(10000)
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
      const url = new URL(route.request().url()), code = await app!.registerGoogle(url.href, 'calendar-consumer-owner')
      const callback = url.searchParams.get('client_id') === 'fixture-calendar-client' ? '/api/calendar/google/callback' : '/api/auth/callback/google'
      await route.fulfill({ status: 302, headers: { location: origin + callback + '?code=' + code + '&state=' + url.searchParams.get('state') } })
    })
    await page.goto(origin + '/login?lang=en')
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await page.waitForURL(origin + '/account?lang=en')
    const rpc = async (name: Parameters<typeof authRpcPath>[0], data: unknown) => context.request.post(origin + await authRpcPath(name), { headers: { origin, 'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, data: await rpcBody(data) })
    expect((await rpc('ensurePersonalWorkspace', {})).status()).toBe(200)
    expect((await rpc('saveActivity', { expectedRevision: 0, businessName: 'Native capture fixture', sector: 'garage', knowledge: { openingHours: '', services: '', prices: '', faq: '', instructions: '' }, transferDestination: null, recordingEnabled: false })).status()).toBe(200)
    const workspace = (await stores.administrator.query('SELECT id FROM workspace')).rows[0].id
    await app.cleanup(); expect(app.child.exitCode).toBe(0)
    const calendarEnv = { SPARRA_GOOGLE_CALENDAR_CLIENT_ID: 'fixture-calendar-client', SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET: 'fixture-only', SPARRA_CALENDAR_TOKEN_KEY: randomBytes(32).toString('base64url') }
    app = startWeb({ ...env, ...calendarEnv, FIXTURE_CALENDAR_PROTOCOL: 'yes' }); await bounded(app.ready)
    const anonymous = await context.request.get(origin + await authRpcPath('getCalendar') + '?payload=' + encodeURIComponent(await rpcBody({})), { headers: { cookie: '', origin, 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true' } })
    expect(anonymous.status()).toBe(401)
    const read = await context.request.get(origin + await authRpcPath('getCalendar') + '?payload=' + encodeURIComponent(await rpcBody({})), { headers: { origin, 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true' } })
    expect(read.status()).toBe(200); expect(read.headers()['cache-control']).toBe('no-store')
    expect((await context.request.post(origin + await authRpcPath('disconnectCalendar'), { headers: { origin: 'https://foreign.example.test', 'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, data: await rpcBody({}) })).status()).toBe(403)
    await page.goto(origin + '/app/entreprise?lang=en')
    await page.getByRole('button', { name: 'Connect Google', exact: true }).click()
    await page.getByText('Connected account : calendar-owner@example.test', { exact: true }).waitFor()
    const firstPolicy={ expectedRevision: 0, calendarId: 'fixture-calendar', enabled: true, policy: { version: 1, timeZone: 'Europe/Paris', services: [{ id: 'oil-change', name: 'Vidange', durationMinutes: 30 }], weeklyHours: [0,1,2,3,4,5,6].map(day => ({ day, ranges: [{ start: '09:00', end: '12:00' }] })), bufferMinutes: 0, noticeMinutes: 0 } }
    expect((await rpc('saveCalendarPolicy', firstPolicy)).status()).toBe(200)
    expect((await rpc('saveCalendarPolicy', {...firstPolicy,policy:{...firstPolicy.policy,services:[]}})).status()).toBe(400)
    expect((await rpc('saveCalendarPolicy', firstPolicy)).status()).toBe(409)
    await page.reload()
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Google Calendar', exact: true }) })
    await panel.getByLabel('Duration (minutes) 1', { exact: true }).fill('35')
    await panel.getByRole('button', { name: 'Save', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.getByText('Settings saved.', { exact: true }).waitFor(); await page.reload()
    expect(await panel.getByLabel('Duration (minutes) 1', { exact: true }).inputValue()).toBe('35')
    await stores.administrator.query("INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,contract_version,local_audio_enabled) SELECT 'sparra_voice_a',oid,'fixture-a',$1,'connection-a','+33123456789',true,2,true FROM pg_roles WHERE rolname='sparra_voice_a'", [workspace])
    await stores.administrator.query('GRANT USAGE ON SCHEMA voice TO sparra_voice_a; GRANT EXECUTE ON FUNCTION voice.begin_call_v2(text,uuid,jsonb),voice.ingest_operation_v2(jsonb),voice.lease_call_erasure_v1(text,integer,integer),voice.ack_call_erasure_v1(uuid,uuid,timestamptz),voice.lease_recording_purge_v1(text,integer,integer),voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz),voice.calendar_catalog_v1(uuid),voice.calendar_submit_v1(uuid,uuid,jsonb),voice.calendar_result_v1(uuid,uuid) TO sparra_voice_a')
    await stores.administrator.query("ALTER ROLE calendar_worker PASSWORD 'calendar-fixture-password'")
    const workerUrl = new URL(stores.directRuntimeUrl); workerUrl.username = 'calendar_worker'; workerUrl.password = 'calendar-fixture-password'
    peer = await startCalendarProtocolPeer()
    transport.peer = peer
    const workerEnv = { ...calendarEnv, APP_ORIGIN: origin, SPARRA_CALENDAR_DATABASE_URL: workerUrl.href }
    worker = createCalendarWorkerResources(workerEnv)
    expect((await worker.ready()).enabled).toBe(true)
    const ownerStorage = await context.storageState(); await browser.close(); browser = undefined
    const evidence = join(crypto.directory, 'native-evidence'); await mkdir(evidence)
    const voiceInput = { url: stores.voiceUrlA, keyring_path: crypto.path, evidence_path: evidence, state_path: join(crypto.directory, 'voice-state'), audio_candidate: true as const, calendar_consumer: true as const, workspace_id: workspace }
    const producer = await resolveVoiceProducer()
    voice = startConnectedVoice(voiceInput, producer)
    expect(await voice.ready).toMatchObject({ ready: true })
    const admitted = await voice.command('audio-off-admit'); expect(admitted.call_id).toBeDefined()
    expect(await voice.command('calendar-search')).toMatchObject({ offered: true })
    const firstVoice=voice,firstWorker=worker,firstPeer=peer
    async function checkUnacknowledgedRecap() {
      if(mode!=='no-ack'&&mode!=='retry-after-no-ack')return false
      expect(await firstVoice.command('calendar-without-ack')).toMatchObject({ no_booking: true })
      expect((await stores.administrator.query("SELECT count(*)::int n FROM sparra_calendar_command WHERE kind='book_appointment'")).rows[0].n).toBe(0)
      expect(firstPeer.events()).toHaveLength(0)
      if (mode === 'no-ack') {
        expect(await firstVoice.stop()).toEqual({ code: 0, signal: null }); voiceStopped = true
        await firstWorker.dispose(); expect(firstWorker.hasFailed()).toBe(false)
        expect(transport.stops).toBe(1)
        return true
      }
      return false
    }
    if(await checkUnacknowledgedRecap())return
    const recap = await voice.command('calendar-select')
    expect(recap).toMatchObject({ acknowledged: true, recap_persisted: true })
    expect(peer.events()).toHaveLength(0)
    const bookingPeer=peer
    async function confirmOrRecoverBooking() {
      if(mode!=='lost-response-restart'&&mode!=='selection-recovery') {
        expect(await voice!.command('calendar-confirm')).toMatchObject({ confirmed: true, no_confirmation_inference: true })
        return
      }
      bookingPeer.setMode('hold-insert')
      expect(await voice!.command('calendar-confirm-start')).toMatchObject({ confirmation_started: true })
      await expect.poll(() => bookingPeer.events().length, { timeout: 10000 }).toBe(1)
      const original = (await stores.administrator.query("SELECT id,event_id FROM sparra_calendar_command WHERE kind='book_appointment'")).rows[0]
      await voice!.crash(); voiceStopped = true
      await worker!.dispose(); expect(worker!.hasFailed()).toBe(false)
      await expect.poll(() => bookingPeer.evidence()).toMatchObject({ activeClientSockets: 0, activeSockets: 0, activeRequests: 0 })
      expect((await stores.administrator.query('SELECT state FROM sparra_calendar_command WHERE id=$1', [original.id])).rows[0].state).toBe('unknown')
      bookingPeer.setMode('normal')
      if (mode === 'selection-recovery') {
        browser = await chromium.launch({ headless: true })
        context = await browser.newContext({ storageState: ownerStorage, extraHTTPHeaders: { 'x-real-ip': '127.0.1.8' } })
        expect((await rpc('saveCalendarPolicy', { expectedRevision: 2, calendarId: 'fixture-calendar-b', enabled: true, policy: { version: 1, timeZone: 'Europe/Paris', services: [{ id: 'oil-change', name: 'Vidange', durationMinutes: 35 }], weeklyHours: [0,1,2,3,4,5,6].map(day => ({ day, ranges: [{ start: '09:00', end: '12:00' }] })), bufferMinutes: 0, noticeMinutes: 0 } })).status()).toBe(200)
        await browser.close(); browser = undefined
      }
      voice = startConnectedVoice(voiceInput, producer); voiceStopped = false
      expect(await voice.ready).toMatchObject({ ready: true })
      expect(await voice.command('calendar-recovered')).toMatchObject({ recovered: true, no_inference: true, no_speech: true })
      worker = createCalendarWorkerResources(workerEnv); await worker.ready()
      await expect.poll(async () => (await stores.administrator.query('SELECT state FROM sparra_calendar_command WHERE id=$1', [original.id])).rows[0].state, { timeout: 70000, interval: 500 }).toBe('confirmed')
      expect((await stores.administrator.query("SELECT id,event_id FROM sparra_calendar_command WHERE kind='book_appointment'")).rows).toEqual([original])
      expect(bookingPeer.requests().some(value => value.method === 'GET' && value.path.endsWith('/' + original.event_id))).toBe(true)
    }
    await confirmOrRecoverBooking()
    async function observeChangedBooking() {
      if(mode!=='cancelled-repeat'&&mode!=='moved-repeat')return
      const original = (await stores.administrator.query("SELECT id,event_id,request,result,possible_send_fence,window_start,window_end FROM sparra_calendar_command WHERE kind='book_appointment'")).rows[0]
      bookingPeer.changeEvent(original.event_id, mode === 'cancelled-repeat' ? 'cancelled' : 'moved')
      expect(await voice!.command('calendar-search')).toMatchObject({ offered: true })
      const changed = (await stores.administrator.query('SELECT observed_state,current_start FROM sparra_calendar_command WHERE id=$1', [original.id])).rows[0]
      expect(changed.observed_state).toBe(mode === 'cancelled-repeat' ? 'cancelled' : 'confirmed')
      expect(changed.current_start?.toISOString()).not.toBe(original.window_start.toISOString())
      const repeatedRecap = await voice!.command('calendar-select')
      expect(repeatedRecap).toMatchObject({ acknowledged: true, recap_persisted: true, selected_start: original.window_start.toISOString(), selected_end: original.window_end.toISOString() })
      expect(repeatedRecap.recap_turn_id).not.toBe(recap.recap_turn_id)
      expect(repeatedRecap.playback_mark).not.toBe(recap.playback_mark)
      expect(await voice!.command('calendar-confirm-unconfirmed')).toMatchObject({ unconfirmed: true, no_stale_speech: true, no_stale_result: true, no_confirmation_inference: true })
      expect((await stores.administrator.query("SELECT id,event_id,request,result,possible_send_fence,window_start,window_end FROM sparra_calendar_command WHERE kind='book_appointment'")).rows).toEqual([original])
    }
    await observeChangedBooking()
    const events = peer.events(); expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ summary: 'Vidange', description: origin + '/app/demandes/' + admitted.call_id })
    expect(peer.requests().filter(value => value.method === 'POST' && value.path.includes('/events?'))).toHaveLength(1)
    const proof = (await stores.administrator.query(`SELECT q.request->'confirmation' proof,
      c.encrypted_turns->(q.request->'confirmation'->>'recapTurnId')->>'role' recap_role,
      c.encrypted_turns->(q.request->'confirmation'->>'recapTurnId')->>'source' recap_source,
      c.encrypted_turns->(q.request->'confirmation'->>'confirmationTurnId')->>'role' confirmation_role,
      c.encrypted_turns->(q.request->'confirmation'->>'confirmationTurnId')->>'source' confirmation_source
      FROM sparra_calendar_command q JOIN sparra_call c ON c.id=q.call_id WHERE q.kind='book_appointment'`)).rows
    expect(proof).toHaveLength(1)
    expect(proof[0]).toMatchObject({ proof: { recapTurnId: recap.recap_turn_id, playbackMark: recap.playback_mark }, recap_role: 'assistant', recap_source: 'pipecat_assistant', confirmation_role: 'user', confirmation_source: 'stt_final' })
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ storageState: ownerStorage, extraHTTPHeaders: { 'x-real-ip': '127.0.1.8' } })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const inbox = await context.newPage(); inbox.setDefaultTimeout(10000)
    await inbox.goto(origin + '/app/demandes/' + admitted.call_id + '?lang=en')
    await inbox.getByText('Google reference : ' + events[0]!.id, { exact: true }).waitFor()
    expect(await inbox.locator('body').innerText()).toContain('Vidange')
    expect(await voice.stop()).toEqual({ code: 0, signal: null }); voiceStopped = true
    await worker.dispose(); expect(worker.hasFailed()).toBe(false)
    expect(transport.stops).toBe(mode === 'lost-response-restart' || mode === 'selection-recovery' ? 2 : 1)
    await expect.poll(() => peer!.evidence()).toMatchObject({ activeClientSockets: 0, activeSockets: 0, activeRequests: 0, disallowed: 0 })
    if (mode === 'confirmed') {
      // Actual emitted entry: Calendar starts even though absent Hatchet config
      // remains a separately visible failure. No mock replaces either lifecycle.
      const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/helpers/mail-process.mjs')).href, resolve('.output/worker/index.mjs')], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'test', ...workerEnv },
      })
      let output = ''
      child.stdout!.on('data', chunk => { output += String(chunk) }); child.stderr!.on('data', chunk => { output += String(chunk) })
      const exited = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
      try {
        await expect.poll(() => output.includes('Calendar worker ready'), { timeout: 15000 }).toBe(true)
        expect(output).toContain('Application worker unavailable')
        child.send('shutdown'); expect(await bounded(exited, 15000)).toBe(1)
        expect(output).toContain('Application worker stopped')
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.send('shutdown'); await bounded(exited, 15000).catch(() => { child.kill('SIGKILL') }) }
        await bounded(exited, 6000)
      }
    }
  } catch (error) {
    functionalFailure = error
    console.log('CALENDAR_NATIVE_FAILURE', { workerFailed: worker?.hasFailed(), peer: peer?.evidence(), requests: peer?.requests().map(({method,path})=>({method,path})), commands: (await stores.administrator.query('SELECT kind,state FROM sparra_calendar_command')).rows })
    throw error
  }
  finally {
    const failures: unknown[] = functionalFailure === undefined ? [] : [functionalFailure]
    for (const close of [() => voice && !voiceStopped ? voice.stop() : undefined, () => worker?.dispose(), () => peer?.close(), () => browser?.close(), () => app?.cleanup(), () => crypto?.cleanup(), () => stores.cleanup()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Calendar consumer execution or retirement failed')
    transport.peer = undefined
  }
}, 180000)
