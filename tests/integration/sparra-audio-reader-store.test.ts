import { afterAll, beforeAll, expect, test } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { eq, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { createServer, request as nodeRequest, type ClientRequest, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { AudioUnavailable, createAudioOperations, type AudioReadLease, type AudioMetadata } from '../../src/modules/sparra/audio.server'
import { createAudioReaderOwner } from '../../src/modules/sparra/audio-reader.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import type { WebResources } from '../../src/platform/resources.server'
import { sparraAudioReader } from '../../src/modules/sparra/schema.server'

// Native SQL cleanup authority only. Owner-issued reader metadata is seeded
// under R1; this does not assert playable audio, native HTTP join or retirement.
let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let owner: ReturnType<typeof createTransactions>, personal: ReturnType<typeof createPersonalWorkspaces>
let auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>, ceremony: ReturnType<typeof googleCeremony>
let audio: ReturnType<typeof createAudioOperations>

const options = () => ({
  deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000,
  cleanupTimeoutMs: 1000, correlationId: randomUUID(),
})
const admin = (query: string, values?: unknown[]) => stores.administrator.query(query, values)
const slot = async (workspaceId: string) => (await admin(
  'SELECT workspace_id,call_id,recording_id,lease_id,incarnation,state,released_at FROM sparra_audio_reader WHERE workspace_id=$1',
  [workspaceId],
)).rows[0]

async function ownerFixture() {
  const { principal } = await ceremony()
  const workspace = await personal.ensurePersonalWorkspace(principal)
  expect(workspace).not.toBeNull()
  return { principal, workspace: workspace! }
}
async function seedSlot(target: Awaited<ReturnType<typeof ownerFixture>>): Promise<AudioReadLease> {
  const exact: AudioReadLease = {
    workspaceId: target.workspace.id, callId: randomUUID(), recordingId: randomUUID(),
    leaseId: randomUUID(), token: randomUUID(), incarnation: randomUUID(),
    containerId: 'a'.repeat(64), deploymentId: 'reader-store-fixture', expiresAt: new Date(Date.now() + 10000),
  }
  await owner.withPersonalWorkspacePromise(options(), target.principal, false, async lease => {
    expect(lease?.workspaceId).toBe(target.workspace.id)
    if (!lease) throw new Error('Reader fixture Workspace unavailable')
    const [previous] = await lease.db.select().from(sparraAudioReader)
      .where(eq(sparraAudioReader.workspaceId, target.workspace.id))
    if (previous) expect(previous.state).toBe('released')
    const values = {
      workspaceId: exact.workspaceId, callId: exact.callId, recordingId: exact.recordingId,
      leaseId: exact.leaseId, tokenHash: createHash('sha256').update(exact.token).digest('hex'),
      incarnation: exact.incarnation, containerId: exact.containerId, readerDeploymentId: exact.deploymentId,
      expiresAt: exact.expiresAt, state: 'active' as const, releasedAt: null,
    }
    await lease.db.insert(sparraAudioReader).values(values)
      .onConflictDoUpdate({ target: sparraAudioReader.workspaceId, set: values })
  })
  return exact
}

beforeAll(async () => {
  stores = await startDisposableStores()
  const hashes = readMigrationFiles({ migrationsFolder: 'drizzle' }).map(migration => migration.hash)
  const journal = async () => (await admin('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows.map(row => row.hash)
  expect((await admin("SELECT to_regclass('drizzle.__drizzle_migrations') AS journal")).rows).toEqual([{ journal: null }])
  await stores.migrateGoogleAccountPrefix()
  expect(await journal()).toEqual(hashes.slice(0, 10))
  await stores.migrateSessionManagementPrefix()
  expect(await journal()).toEqual(hashes.slice(0, 11))
  await stores.migrateRecoveryAdmissionPrefix()
  expect(await journal()).toEqual(hashes.slice(0, 12))
  await stores.migrate()
  expect(await journal()).toEqual(hashes)
  await admin('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  peer = await startGoogleProtocolPeer({
    ports: [3000, ...[stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(url => Number(new URL(url).port))],
  })
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 3 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const { createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server')
  limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'audio-reader-store', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test',
  }))
  await limiter.connect()
  auth = createApplicationAuth(owner, readAuthConfig({
    APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only',
  })!, limiter)
  ceremony = googleCeremony(auth, owner, peer)
  personal = createPersonalWorkspaces(owner)
  // Call through the actual owner, checking the native leased connection before
  // and after the production release query rather than synthesizing its scope.
  const nativeAuth = owner.withAuthPromise.bind(owner)
  const observed: typeof owner = { ...owner, withAuthPromise: (invocation, call) => nativeAuth(invocation, async lease => {
    const scope = () => lease.db.select({ tenant: sql<string>`current_setting('app.tenant_id',true)`, login: sql<string>`session_user` })
      .from(sql`(select 1) AS reader_scope`)
    expect(await scope()).toEqual([{ tenant: '00000000-0000-0000-0000-000000000000', login: 'runtime' }])
    expect(await lease.db.select({ id: sparraAudioReader.leaseId }).from(sparraAudioReader)).toEqual([])
    const result = await call(lease)
    expect(await scope()).toEqual([{ tenant: '00000000-0000-0000-0000-000000000000', login: 'runtime' }])
    return result
  }) }
  audio = createAudioOperations(observed)
})

afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => auth?.close(), () => limiter?.close(), () => pool?.end(), () => peer?.close(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Audio reader store fixture cleanup failed')
})

test('exact release uses auth sentinel and waits for the physical Workspace lock', async () => {
  const target = await ownerFixture(), exact = await seedSlot(target), before = await slot(target.workspace.id)
  expect(await audio.release({ ...exact, token: randomUUID() })).toBe(false)
  expect(await audio.release({ ...exact, incarnation: randomUUID() })).toBe(false)
  expect(await slot(target.workspace.id)).toEqual(before)
  await admin('BEGIN')
  await admin('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [target.workspace.id])
  const released = audio.release(exact).then(value => ({ value, error: null }), error => ({ value: null, error }))
  try {
    await expect.poll(async () => (await admin(
      "SELECT exists(SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock') waiting",
    )).rows[0].waiting, { timeout: 750, interval: 10 }).toBe(true)
    expect(await slot(target.workspace.id)).toEqual(before)
  } finally { await admin('COMMIT') }
  expect(await released).toEqual({ value: true, error: null })
  expect(await slot(target.workspace.id)).toMatchObject({ lease_id: exact.leaseId, state: 'released', released_at: expect.any(Date) })
})

test('cleanup releases the exact slot after auth loss and Workspace becomes deleting', async () => {
  const target = await ownerFixture(), exact = await seedSlot(target)
  await admin('DELETE FROM session WHERE id=$1', [target.principal.sessionId])
  await admin("UPDATE workspace SET lifecycle='deleting' WHERE id=$1", [target.workspace.id])
  expect(await personal.readWorkspace(target.principal)).toBeNull()
  expect(await audio.release(exact)).toBe(true)
  const released = await slot(target.workspace.id)
  expect(released).toMatchObject({ lease_id: exact.leaseId, state: 'released', released_at: expect.any(Date) })
  expect(await audio.release(exact)).toBe(true)
  expect(await slot(target.workspace.id)).toEqual(released)
})

test('stale A capability cannot release replacement B or a foreign Workspace slot', async () => {
  const target = await ownerFixture(), foreign = await ownerFixture()
  const a = await seedSlot(target), foreignExact = await seedSlot(foreign)
  expect(await audio.release(a)).toBe(true)
  const b = await seedSlot(target), beforeB = await slot(target.workspace.id)
  const beforeForeign = await slot(foreign.workspace.id)
  expect(await audio.release(a)).toBe(false)
  expect(await audio.release({ ...b, token: a.token })).toBe(false)
  expect(await audio.release({ ...b, incarnation: a.incarnation })).toBe(false)
  expect(await slot(target.workspace.id)).toEqual(beforeB)
  expect(await slot(foreign.workspace.id)).toEqual(beforeForeign)
  expect((await admin('SELECT count(*)::int AS count FROM sparra_audio_reader WHERE workspace_id=$1', [target.workspace.id])).rows).toEqual([{ count: 1 }])
  expect(await audio.release(b)).toBe(true)
  expect(await slot(foreign.workspace.id)).toEqual(beforeForeign)
  expect(await audio.release(foreignExact)).toBe(true)
})

test('final enqueue waits for the physical Workspace lock and emits nothing after denial commits', async () => {
  const target = await ownerFixture(), callId = randomUUID(), recordingId = randomUUID()
  const admittedAt = new Date(), retentionUntil = new Date(admittedAt.getTime() + 2_592_000_000)
  // Bounded administrative authorization rows only: no native capture, chunks,
  // playable recording or qualified Voice profile is asserted by this witness.
  await admin(`INSERT INTO sparra_knowledge_revision
    (workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions)
    VALUES($1,1,'Reader lock fixture','garage','','','','','')`, [target.workspace.id])
  await admin(`INSERT INTO sparra_call
    (id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,
     admitted_at,retention_until,status,recording_id,audio_state,
     audio_total_samples,audio_last_sequence,audio_finish_reason)
    VALUES($1::uuid,$2,1,'reader-enqueue-fixture',($1::uuid)::text,$3,$4,'active',$5,'ready',8000,0,'complete')`,
  [callId, target.workspace.id, admittedAt, retentionUntil, recordingId])
  const signal = new AbortController().signal, pin = await audio.read(target.principal, callId)
  const exact = await audio.acquire(target.principal, pin, {
    incarnation: randomUUID(), containerId: 'c'.repeat(64), deploymentId: 'reader-enqueue-fixture',
  }, Date.now() + 10000, signal)
  let emitted = 0
  await audio.enqueue(target.principal, pin, exact, signal, () => { emitted++ })
  expect(emitted).toBe(1)
  emitted = 0
  const before = (await admin('SELECT admitted_at,retention_until,status,ended_at FROM sparra_call WHERE id=$1', [callId])).rows[0]
  await admin('BEGIN')
  await admin('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [target.workspace.id])
  const blocker = (await admin('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const enqueued = audio.enqueue(target.principal, pin, exact, signal, () => { emitted++ })
    .then(() => ({ error: null }), error => ({ error }))
  try {
    await expect.poll(async () => (await admin(`SELECT exists(
      SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock'
        AND $1::integer = ANY(pg_blocking_pids(pid))) waiting`, [blocker])).rows[0].waiting,
    { timeout: 750, interval: 10 }).toBe(true)
    expect(emitted).toBe(0)
    await admin('UPDATE sparra_call SET audio_denied_at=clock_timestamp() WHERE id=$1', [callId])
  } finally { await admin('COMMIT') }
  expect((await enqueued).error).toBeInstanceOf(AudioUnavailable)
  expect(emitted).toBe(0)
  expect((await admin('SELECT admitted_at,retention_until,status,ended_at FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual(before)
  expect(await audio.release(exact)).toBe(true)
  expect(await slot(target.workspace.id)).toMatchObject({ lease_id: exact.leaseId, state: 'released', released_at: expect.any(Date) })
})

function deliveryBarrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function nativeBounded<T>(operation: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native reader delivery deadline')), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function readerAuthorizationFixture() {
  const signed = await ceremony(), workspace = await personal.ensurePersonalWorkspace(signed.principal)
  if (!workspace) throw new Error('Reader lifecycle Workspace missing')
  const callId = randomUUID(), recordingId = randomUUID(), admittedAt = new Date()
  const retentionUntil = new Date(admittedAt.getTime() + 2_592_000_000)
  // Authorization metadata only. The range is the WAV44 header; no recording,
  // capture, chunks, carrier or qualified Voice profile is fabricated here.
  await admin(`INSERT INTO sparra_knowledge_revision
    (workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions)
    VALUES($1,1,'Reader lifecycle fixture','garage','','','','','')`, [workspace.id])
  await admin(`INSERT INTO sparra_call
    (id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,
     admitted_at,retention_until,status,recording_id,audio_state,audio_total_samples,audio_last_sequence,audio_finish_reason)
    VALUES($1::uuid,$2,1,'reader-lifecycle-fixture',($1::uuid)::text,$3,$4,'active',$5,'ready',1,0,'complete')`,
  [callId, workspace.id, admittedAt, retentionUntil, recordingId])
  const pin = await createAudioOperations(owner).read(signed.principal, callId)
  return { ...signed, pin }
}
async function nativeReaderSocket(transactions: typeof owner, pin: AudioMetadata, cookie: string) {
  const incarnation = { incarnation: randomUUID(), containerId: 'e'.repeat(64), deploymentId: 'reader-lifecycle-fixture' }
  const readerOwner = createAudioReaderOwner(transactions, incarnation)
  const resources: WebResources = { transactions, auth, limiter, workspaces: personal, isReady: () => true }
  const clients: ClientRequest[] = [], responses: ServerResponse[] = [], handlers: Promise<void>[] = []
  const bRegistered = deliveryBarrier(), closed = deliveryBarrier(), handled = deliveryBarrier()
  let bResponse: ServerResponse | undefined, bReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const server = createServer((incoming, outgoing) => {
    const abort = new AbortController()
    responses.push(outgoing); outgoing.on('error', () => {})
    outgoing.once('close', () => { abort.abort(); if (incoming.url === '/close') closed.resolve() })
    const request = new Request('http://localhost:3000' + incoming.url, { signal: abort.signal, headers: { cookie } })
    Object.defineProperty(request, 'runtime', { value: { node: { req: incoming, res: outgoing } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    handlers.push((async () => {
      const body = await readerOwner.stream(request, resources, pin, { start: 0, end: 43, partial: true })
      const reader = body.getReader()
      if (incoming.url === '/b') { bReader = reader; bResponse = outgoing; bRegistered.resolve(); return }
      try {
        const first = await reader.read()
        expect(first.value?.byteLength).toBe(44)
        outgoing.end(first.value)
      } finally { reader.releaseLock() }
    })().catch(() => { outgoing.destroy() }).finally(() => {
      if (incoming.url === '/close') handled.resolve()
    }))
  })
  server.listen(0, '127.0.0.1')
  await nativeBounded(once(server, 'listening'))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Native reader address missing')
  peer.allowPort(address.port)
  return { owner: readerOwner, bRegistered: bRegistered.promise, closed: closed.promise, handled: handled.promise,
    successor: () => ({ response: bResponse, reader: bReader }),
    connect(path: string) {
      const client = nodeRequest({ host: '127.0.0.1', port: address.port, path })
      client.on('error', () => {})
      client.on('response', response => { response.on('error', () => {}); response.resume() })
      clients.push(client); client.end(); return client
    },
    async close() {
      for (const response of responses) response.destroy()
      for (const client of clients) client.destroy()
      server.closeAllConnections()
      await nativeBounded(new Promise<void>(resolve => server.close(() => resolve())))
      await nativeBounded(Promise.all(handlers)).catch(() => {})
      await nativeBounded(readerOwner.shutdown(), 500).catch(() => {})
      bReader?.releaseLock()
    } }
}

test.each([false, true])('native R1 COMMIT handoff keeps successor and held release joined (unknown return: %s)', async unknown => {
  const target = await readerAuthorizationFixture()
  const aAcquireEntered = deliveryBarrier(), bAcquireEntered = deliveryBarrier(), resumeBAcquire = deliveryBarrier()
  const aReleaseCommitted = deliveryBarrier(), resumeARelease = deliveryBarrier(), bReleaseCommitted = deliveryBarrier()
  let acquires = 0, releases = 0, aLeaseId: string | undefined, bLeaseId: string | undefined
  // Only delivery is scheduled. Both transaction methods execute their actual
  // callbacks, R1 authority, native COMMIT and client retirement before waiting.
  const observed: typeof owner = { ...owner,
    withPersonalWorkspacePromise: async (invocation, principal, create, use) => {
      const index = acquires++
      if (index === 0) { aAcquireEntered.resolve(); await bAcquireEntered.promise }
      if (index === 1) { bAcquireEntered.resolve(); await resumeBAcquire.promise }
      const result = await owner.withPersonalWorkspacePromise(invocation, principal, create, use)
      if (index < 2) expect(await slot(target.pin.workspaceId)).toMatchObject({ state: 'active' })
      return result
    },
    withAuthPromise: async (invocation, use) => {
      const index = releases++, result = await owner.withAuthPromise(invocation, use)
      const released = await slot(target.pin.workspaceId)
      expect(released).toMatchObject({ state: 'released' })
      if (index === 0) {
        aLeaseId = released.lease_id; aReleaseCommitted.resolve(); await resumeARelease.promise
        if (unknown) throw new PgTransactionError('query', 'unknown', randomUUID())
      } else { expect(released.lease_id).toBe(bLeaseId); bReleaseCommitted.resolve() }
      return result
    },
  }
  const native = await nativeReaderSocket(observed, target.pin, target.cookie)
  try {
    native.connect('/a')
    await nativeBounded(aAcquireEntered.promise)
    native.connect('/b')
    await nativeBounded(aReleaseCommitted.promise)
    expect(await slot(target.pin.workspaceId)).toMatchObject({ lease_id: aLeaseId, state: 'released' })
    resumeBAcquire.resolve()
    await nativeBounded(native.bRegistered)
    const b = await slot(target.pin.workspaceId)
    expect(b).toMatchObject({ state: 'active' }); expect(b.lease_id).not.toBe(aLeaseId); bLeaseId = b.lease_id
    let shutdownDone = false
    const shutdown = native.owner.shutdown().then(() => { shutdownDone = true; return null },
      error => { shutdownDone = true; return error })
    await nativeBounded(bReleaseCommitted.promise)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(shutdownDone).toBe(false)
    resumeARelease.resolve()
    const failure = await nativeBounded(shutdown)
    if (unknown) expect(failure).toEqual(new Error('Audio reader cleanup unconfirmed'))
    else expect(failure).toBeNull()
    expect(native.successor().response?.destroyed).toBe(true)
    const reader = native.successor().reader
    if (!reader) throw new Error('Native successor reader missing')
    await expect(nativeBounded(reader.read())).rejects.toThrow('Conversation stopped')
    expect(releases).toBe(2)
    expect(await slot(target.pin.workspaceId)).toMatchObject({ lease_id: bLeaseId, state: 'released' })
  } finally {
    resumeBAcquire.resolve(); resumeARelease.resolve()
    await native.close()
  }
})

test('native R1 acquire COMMIT followed by early TCP close joins exact release without enqueue', async () => {
  const target = await readerAuthorizationFixture(), acquireCommitted = deliveryBarrier(), resumeAcquire = deliveryBarrier()
  let first = true, acceptedLeaseId: string | undefined, enqueues = 0, releases = 0
  const observed: typeof owner = { ...owner,
    withPersonalWorkspacePromise: async (invocation, principal, create, use) => {
      if (!first) enqueues++
      const result = await owner.withPersonalWorkspacePromise(invocation, principal, create, use)
      if (first) {
        first = false
        const accepted = await slot(target.pin.workspaceId)
        expect(accepted).toMatchObject({ state: 'active' }); acceptedLeaseId = accepted.lease_id
        acquireCommitted.resolve(); await resumeAcquire.promise
      }
      return result
    },
    withAuthPromise: async (invocation, use) => {
      const result = await owner.withAuthPromise(invocation, use)
      expect(await slot(target.pin.workspaceId)).toMatchObject({ lease_id: acceptedLeaseId, state: 'released' })
      releases++; return result
    },
  }
  const native = await nativeReaderSocket(observed, target.pin, target.cookie)
  try {
    const client = native.connect('/close')
    await nativeBounded(acquireCommitted.promise)
    client.destroy()
    await nativeBounded(native.closed)
    expect(releases).toBe(0)
    resumeAcquire.resolve()
    await nativeBounded(native.handled)
    await nativeBounded(native.owner.shutdown())
    expect(enqueues).toBe(0); expect(releases).toBe(1)
    expect(await slot(target.pin.workspaceId)).toMatchObject({ lease_id: acceptedLeaseId, state: 'released' })
  } finally { resumeAcquire.resolve(); await native.close() }
})
