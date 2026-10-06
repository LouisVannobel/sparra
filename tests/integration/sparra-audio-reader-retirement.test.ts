import { afterAll, beforeAll, expect, test } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { nativeImage } from '../helpers/native-image'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { sparraAudioReader } from '../../src/modules/sparra/schema.server'

// Native owned Docker lifecycle and real migrator CLI. These are unknown reader
// metadata obligations under R1, not fabricated playable audio or an HTTP join.
let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let owner: ReturnType<typeof createTransactions>, personal: ReturnType<typeof createPersonalWorkspaces>
let auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>
let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>, ceremony: ReturnType<typeof googleCeremony>
let app: Awaited<ReturnType<Awaited<ReturnType<typeof startDisposableStores>>['startWebImage']>>
let migrator: string, workspaceA: string, workspaceB: string
const incarnationA = randomUUID(), incarnationB = randomUUID(), deployment = 'reader-retirement-fixture'
const options = () => ({ deadlineAtMs: Date.now() + 10000, statementTimeoutMs: 1000,
  cleanupTimeoutMs: 1000, correlationId: randomUUID() })
const admin = (query: string, values?: unknown[]) => stores.administrator.query(query, values)
const slots = async () => (await admin(
  'SELECT workspace_id,lease_id,incarnation,container_id,reader_deployment_id,state,released_at FROM sparra_audio_reader ORDER BY workspace_id',
)).rows
const journal = async () => (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows

async function seedUnknownSlot(incarnation: string) {
  const { principal } = await ceremony()
  const workspace = await personal.ensurePersonalWorkspace(principal)
  if (!workspace) throw new Error('Reader retirement fixture Workspace missing')
  await owner.withPersonalWorkspacePromise(options(), principal, false, async lease => {
    if (!lease || lease.workspaceId !== workspace.id) throw new Error('Reader retirement fixture lease missing')
    await lease.db.insert(sparraAudioReader).values({
      workspaceId: workspace.id, callId: randomUUID(), recordingId: randomUUID(), leaseId: randomUUID(),
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), incarnation,
      containerId: app.id, readerDeploymentId: deployment, expiresAt: new Date(Date.now() + 60000),
      state: 'active', releasedAt: null,
    })
  })
  return workspace.id
}

beforeAll(async () => {
  const web = await nativeImage('web')
  migrator = await nativeImage('migrator')
  stores = await startDisposableStores()
  await stores.migrate()
  await admin('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  peer = await startGoogleProtocolPeer({
    ports: [3000, ...[stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(url => Number(new URL(url).port))],
  })
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 3 })
  owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const { createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server')
  limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
    RATE_LIMIT_KEY_ID: 'audio-retirement', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test',
  }))
  await limiter.connect()
  auth = createApplicationAuth(owner, readAuthConfig({
    APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', AUTH_SECRET: randomBytes(48).toString('hex'),
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only',
  })!, limiter)
  ceremony = googleCeremony(auth, owner, peer)
  personal = createPersonalWorkspaces(owner)
  app = await stores.startWebImage(web, 'valid', undefined, undefined, true, undefined,
    { incarnation: incarnationA, deploymentId: deployment })
  workspaceA = await seedUnknownSlot(incarnationA)
  // A different, unconfirmed incarnation is deliberately retained even when
  // the proof names the same full container/deployment: all three must match.
  workspaceB = await seedUnknownSlot(incarnationB)
}, 600000)

afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => auth?.close(), () => limiter?.close(), () => pool?.end(), () => peer?.close(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Reader retirement fixture cleanup failed')
  expect(stores.evidence.unrelatedUnchanged).toBe(true)
  expect(stores.evidence.consumerRetirementConfirmed).toBe(true)
  expect(stores.evidence.inventoryDelta).toEqual([])
})

test('active owned reader cannot issue retirement proof and missing proof leaves unknown slots occupied', async () => {
  const before = await slots(), beforeJournal = await journal()
  expect(before).toHaveLength(2)
  expect(before.every(row => row.state === 'active' && row.released_at === null)).toBe(true)
  await expect(stores.retireReaderImage(app.id)).rejects.toThrow('Reader retirement unconfirmed')
  const result = await stores.runMigrationImage(migrator, 'valid', 'direct', {})
  expect(result).toMatchObject({ exitCode: 1, stdout: '', stderr: 'Database migration failed\n' })
  expect(await slots()).toEqual(before)
  expect(await journal()).toEqual(beforeJournal)
})

test('actual crashed and removed reader proof releases only exact A through native migrator and replays idempotently', async () => {
  const before = await slots(), beforeJournal = await journal()
  const retainedB = before.find(row => row.workspace_id === workspaceB)
  await stores.signalWeb(app.id, 'SIGKILL')
  expect(await stores.waitWeb(app.id)).toBe(137)
  const proof = await stores.retireReaderImage(app.id)
  expect(proof).toMatchObject({ schema_version: 1, incarnation: incarnationA, container_id: app.id,
    deployment_id: deployment, restart_policy: 'no', container_state: 'removed', exit_code: 137 })
  expect(proof.proof_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(proof.exclusivity_reference).toMatch(/^[0-9a-f]{64}$/)
  expect(new Date(proof.finished_at).toISOString()).toBe(proof.finished_at)
  await expect(stores.restartWebImage(app.id)).rejects.toThrow()
  const result = await stores.runMigrationImage(migrator, 'valid', 'direct', { proof })
  expect(result).toMatchObject({ exitCode: 0, stdout: 'Audio reader retirement applied\n', stderr: '' })
  const after = await slots()
  expect(after).toHaveLength(2)
  expect(after.find(row => row.workspace_id === workspaceA)).toMatchObject({
    incarnation: incarnationA, container_id: app.id, state: 'released', released_at: expect.any(Date),
  })
  expect(after.find(row => row.workspace_id === workspaceB)).toEqual(retainedB)
  const replay = await stores.runMigrationImage(migrator, 'valid', 'direct', { proof })
  expect(replay).toMatchObject({ exitCode: 0, stdout: 'Audio reader retirement applied\n', stderr: '' })
  expect(await slots()).toEqual(after)
  expect(await journal()).toEqual(beforeJournal)
})
