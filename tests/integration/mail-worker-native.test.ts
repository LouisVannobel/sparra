import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { startDisposableStores, startDisposableHatchet } from '../fixtures/db/disposable-stores'
import { startMailHttpPeer } from '../fixtures/mail-http'
import { bounded } from '../helpers/web-process'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { authorizeEmailRequest, materializeDelivery } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'

test('built application relay and native worker consume the real SQL snapshot through controlled TLS and drain on shutdown', async () => {
  const runId = randomUUID()
  let peer: Awaited<ReturnType<typeof startMailHttpPeer>> | undefined
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let engine: Awaited<ReturnType<typeof startDisposableHatchet>> | undefined
  let child: ReturnType<typeof spawn> | undefined, exit: Promise<number | null> | undefined
  let pool: Pool | undefined
  let output = '', outcome: Record<string, unknown> = {}, shutdownAt: number | undefined
  try {
    peer = await startMailHttpPeer()
    stores = await startDisposableStores()
    pool = new Pool({ connectionString: stores.runtimeUrl }); pool.on('error', () => {})
    await stores.migrate()
    await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE ON auth_email_request,auth_email_command,email_delivery,auth_email_outbox TO runtime; GRANT SELECT,UPDATE ON "user" TO runtime')
    engine = await startDisposableHatchet()
    const key = randomBytes(32), codec = createAuthEmailEnvelope({ currentKeyId: 'native', keys: { native: key } })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const options = () => ({ deadlineAtMs: Date.now()+5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
    const apiOrigin = peer.origin
    const command = await owner.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { email: 'owned-synthetic@example.test', purpose: 'magic-link', locale: 'en', expectedGeneration: 0, lifetimeSeconds: 600 }))
    const delivery = await owner.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, { appOrigin: 'https://app.example.test', apiOrigin, projectId: 'fixture', credentialId: 'native', from: { name: 'Product', email: 'auth@example.test' }, reply: 'reply@example.test', replayWindowSeconds: null }))
    child = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/helpers/mail-process.mjs')).href, resolve('.output/worker/index.mjs')], {
      windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'], env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: peer.certificate,
        AUTH_MAIL_RELAY_DATABASE_URL: stores.mailRelayUrl, AUTH_MAIL_WORKER_DATABASE_URL: stores.mailWorkerUrl,
        AUTH_MAIL_KEY_ID: 'native', AUTH_MAIL_KEYS_JSON: JSON.stringify({ native: key.toString('base64') }),
        AUTH_MAIL_PROJECT_ID: 'fixture', AUTH_MAIL_CREDENTIAL_ID: 'native', AUTH_MAIL_API_ORIGIN: peer.origin, AUTH_MAIL_PLUNK_SECRET: 'sk_controlled_local_fixture_only',
        HATCHET_CLIENT_TOKEN: engine.config.token, HATCHET_CLIENT_HOST_PORT: engine.config.host_port, HATCHET_CLIENT_API_URL: engine.config.api_url, HATCHET_CLIENT_TLS_STRATEGY: 'none',
      },
    })
    key.fill(0)
    child.stdout!.on('data', chunk => { output += String(chunk) }); child.stderr!.on('data', chunk => { output += String(chunk) })
    exit = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('close', done) })
    const deadline = performance.now()+35000
    let queued = false, admitted = false
    while (performance.now()<deadline) {
      if (child.exitCode !== null) break
      const row = (await stores.administrator.query('SELECT d.provider_state,d.ciphertext IS NULL AS purged,d.verifier_hash IS NOT NULL AS verifier,o.admission_state FROM email_delivery d JOIN auth_email_outbox o ON o.delivery_id=d.id WHERE d.id=$1', [delivery!.id])).rows[0]
      queued = row.provider_state === 'plunk_queued' && row.purged && row.verifier
      admitted = row.admission_state === 'admitted'
      if (queued && admitted) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect({ queued, admitted, ready: output.includes('Auth mail worker ready') }).toEqual({ queued: true, admitted: true, ready: true })
    expect(peer.evidence()).toEqual({ calls: 1, directFragment: true })
    // The real SDK heartbeat thread runs every four seconds. A controlled
    // outage spans two intervals and must not leak its raw RPC error output.
    await engine.withEngineStopped(async () => { await new Promise(resolve => setTimeout(resolve, 8500)) })
    expect({ onlyReady: output.trim() === 'Auth mail worker ready', outputBytes: Buffer.byteLength(output) }).toEqual({ onlyReady: true, outputBytes: Buffer.byteLength('Auth mail worker ready\n') })
    expect(child.exitCode).toBeNull()
    shutdownAt = performance.now(); child.send('shutdown')
    const code = await bounded(exit, 15000)
    outcome.shutdownBy15s = { processExited: true, scopeStopped: output.includes('Auth mail worker stopped') }
    expect(performance.now()-shutdownAt).toBeLessThanOrEqual(15000)
    expect(code).toBe(0)
    const lines = output.trim().split(/\r?\n/)
    const expected = ['Auth mail worker ready','Auth mail lifecycle native-stop-completed','Auth mail lifecycle native-start-completed','Auth mail lifecycle handlers-stopped','Auth mail lifecycle relay-stopped','Auth mail worker stopped']
    const nativeOutcomes = ['Auth mail lifecycle native-start-resolved','Auth mail lifecycle native-start-cancelled']
    // Never place raw child content in assertion diagnostics.
    expect({ unexpectedLines: lines.filter(line => !expected.includes(line) && !nativeOutcomes.includes(line)).length,
      expectedCounts: expected.map(line => lines.filter(value => value === line).length),
      nativeOutcomeCount: lines.filter(line => nativeOutcomes.includes(line)).length,
    }).toEqual({ unexpectedLines: 0, expectedCounts: [1,1,1,1,1,1], nativeOutcomeCount: 1 })
    expect(peer.evidence()).toEqual({ calls: 1, directFragment: true })
    outcome = { ...outcome, queued, admitted, exitCode: code, ...peer.evidence(), outputSanitized: true, controlledEngineOutageMs: 8500, shutdownElapsedMs: performance.now()-shutdownAt }
  } finally {
    if (shutdownAt !== undefined) outcome.shutdownBy15s ??= { processExited: false, scopeStopped: output.includes('Auth mail worker stopped') }
    if (shutdownAt !== undefined) outcome.shutdownObservation = { elapsedMs: performance.now()-shutdownAt, scopeStopped: output.includes('Auth mail worker stopped'), nativeStopCompleted: output.includes('Auth mail lifecycle native-stop-completed'), nativeStartCompleted: output.includes('Auth mail lifecycle native-start-completed'), nativeStartResolved: output.includes('Auth mail lifecycle native-start-resolved'), nativeStartCancelled: output.includes('Auth mail lifecycle native-start-cancelled'), nativeStartFailed: output.includes('Auth mail lifecycle native-start-failed'), handlersStopped: output.includes('Auth mail lifecycle handlers-stopped'), relayStopped: output.includes('Auth mail lifecycle relay-stopped'), processExitedBeforeCleanup: child !== undefined && child.exitCode !== null }
    const cleanupFailures: string[] = []
    try {
      if (child && child.exitCode === null && child.signalCode === null) { outcome.forcedCleanup = true; child.kill('SIGKILL') }
      if (exit) await bounded(exit, 6000)
    } catch { cleanupFailures.push('child') }
    // Keep reverse acquisition order, and continue through every owned cleanup.
    try { await pool?.end() } catch { cleanupFailures.push('pool') }
    try { await engine?.cleanup() } catch { cleanupFailures.push('engine') }
    try { await stores?.cleanup() } catch { cleanupFailures.push('stores') }
    try { await peer?.close() } catch { cleanupFailures.push('peer') }
    await writeFile(resolve(`.superpowers/sdd/2026-09-10-functional-auth/task-7-i4-maintenance-native-${runId}.json`), JSON.stringify({ runId, outcome, cleanupFailures, appStores: stores?.evidence, engine: engine?.evidence }, null, 2)+'\n', { flag: 'wx' })
    expect(cleanupFailures).toEqual([])
  }
}, 150000)
