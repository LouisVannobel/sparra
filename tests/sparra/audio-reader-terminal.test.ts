// Lifecycle regressions only: actual Node req/res, sockets and reader owner.
// Auth/SQL delivery are controlled doubles; this is not native R1/PG proof.
import { expect, test, vi } from 'vitest'
import { createServer, request as nodeRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Pool } from 'pg'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { AudioMetadata, AudioReadLease } from '../../src/modules/sparra/audio.server'
import type { WebResources } from '../../src/platform/resources.server'

const controlled = vi.hoisted(() => ({
  acquire: vi.fn(), release: vi.fn(), check: vi.fn(), page: vi.fn(),
  enqueue: vi.fn(async (_principal, _pin, _exact, _signal, put: () => void) => put()),
}))
vi.mock('../../src/modules/sparra/audio.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/sparra/audio.server')>()
  return { ...actual, createAudioOperations: () => controlled }
})
import { createAudioReaderOwner } from '../../src/modules/sparra/audio-reader.server'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(operation: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native terminal fixture deadline')), ms)
    })])
  } finally { clearTimeout(timer) }
}
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const incarnation = { incarnation: workspaceId, containerId: 'c'.repeat(64), deploymentId: 'terminal-fixture' }
const pin: AudioMetadata = { requestId: workspaceId, workspaceId, recordingId: workspaceId,
  deploymentId: 'terminal-fixture', configurationRevision: 1,
  retentionUntil: new Date(Date.now() + 60000).toISOString(), state: 'ready',
  totalSamples: 1, lastSequence: 0, reason: null }
function lease(id: string): AudioReadLease {
  return { ...incarnation, workspaceId, callId: workspaceId, recordingId: workspaceId,
    leaseId: id, token: id, expiresAt: new Date(Date.now() + 10000) }
}
async function nativeFixture(handle: (incoming: IncomingMessage, outgoing: ServerResponse,
  owner: ReturnType<typeof createAudioReaderOwner>, resources: WebResources) => Promise<void>) {
  vi.clearAllMocks()
  controlled.check.mockResolvedValue(undefined)
  const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
  const transactions = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: 'redis://:terminal-fixture-only-password@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: 'isolated-terminal-fixture-only-012345678901234567890123456789',
    RATE_LIMIT_KEY_ID: 'terminal', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test',
    AUTH_SECRET: 'isolated-terminal-fixture-only-012345678901234567890123456789' })
  if (!config) throw new Error('Terminal fixture config missing')
  const auth = createApplicationAuth(transactions, config, limiter)
  const principal = { userId: 'fixture-user', sessionId: 'fixture-session', name: 'Fixture', email: 'fixture@example.test' }
  const principalSpy = vi.spyOn(auth, 'requirePrincipal').mockResolvedValue(principal)
  const resources: WebResources = { transactions, limiter, auth,
    workspaces: createPersonalWorkspaces(transactions), isReady: () => true }
  const owner = createAudioReaderOwner(transactions, incarnation), clients: ClientRequest[] = []
  const responses: ServerResponse[] = []
  const handlers: Promise<void>[] = []
  const server = createServer((incoming, outgoing) => {
    responses.push(outgoing); outgoing.on('error', () => {})
    handlers.push(handle(incoming, outgoing, owner, resources).catch(() => { outgoing.destroy() }))
  })
  server.listen(0, '127.0.0.1')
  await bounded(once(server, 'listening'))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Terminal fixture address missing')
  return { owner, principal, principalSpy,
    connect(path: string) {
      const client = nodeRequest({ hostname: '127.0.0.1', port: address.port, path })
      client.on('error', () => {}); client.on('response', response => { response.on('error', () => {}); response.resume() })
      clients.push(client); client.end(); return client
    },
    async close() {
      for (const response of responses) response.destroy()
      for (const client of clients) client.destroy()
      server.closeAllConnections()
      await bounded(new Promise<void>(resolve => server.close(() => resolve())))
      await bounded(Promise.all(handlers)).catch(() => {})
      await bounded(owner.shutdown(), 500).catch(() => {})
      await auth.close(); await limiter.close(); await pool.end(); vi.restoreAllMocks()
    } }
}
function nativeRequest(incoming: IncomingMessage, outgoing: ServerResponse, signal?: AbortSignal): Request {
  const request = new Request('http://localhost' + incoming.url, { signal })
  Object.defineProperty(request, 'runtime', { value: { node: { req: incoming, res: outgoing } } })
  Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  return request
}

test.each([false, true])('late old release cannot lose successor ownership (unknown return: %s)', async unknown => {
  const a = lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), b = lease('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const bAuthEntered = barrier(), resumeBAuth = barrier(), aReleaseCommitted = barrier(), resumeARelease = barrier()
  const bRegistered = barrier(), aReleaseDelivered = barrier(), bReleaseDelivered = barrier()
  let sqlSlot: AudioReadLease | null = null, acquired = 0
  let bResponse: ServerResponse | undefined, bReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const fixture = await nativeFixture(async (incoming, outgoing, owner, resources) => {
    const body = await owner.stream(nativeRequest(incoming, outgoing), resources, pin, { start: 0, end: 43, partial: true })
    const reader = body.getReader()
    if (incoming.url === '/b') { bResponse = outgoing; bReader = reader; bRegistered.resolve(); return }
    try {
      const first = await reader.read()
      outgoing.end(first.value)
    } finally { reader.releaseLock() }
  })
  fixture.principalSpy.mockImplementation(async request => {
    if (new URL(request.url).pathname === '/b' && acquired === 0) {
      bAuthEntered.resolve(); await resumeBAuth.promise
    }
    return fixture.principal
  })
  controlled.acquire.mockImplementation(async () => {
    if (acquired === 0) await bAuthEntered.promise
    if (sqlSlot) throw new Error('Controlled SQL slot still active')
    const exact = acquired++ === 0 ? a : b
    sqlSlot = exact
    return exact
  })
  controlled.release.mockImplementation(async (exact: AudioReadLease) => {
    if (sqlSlot !== exact) throw new Error('Controlled release lost exact capability')
    sqlSlot = null
    if (exact === a) {
      aReleaseCommitted.resolve(); await resumeARelease.promise
      aReleaseDelivered.resolve()
      if (unknown) throw new Error('Committed release delivery unconfirmed')
    } else bReleaseDelivered.resolve()
    return true
  })
  try {
    fixture.connect('/a'); fixture.connect('/b')
    await bounded(aReleaseCommitted.promise)
    expect(sqlSlot).toBeNull()
    resumeBAuth.resolve()
    await bounded(bRegistered.promise)
    expect(sqlSlot).toBe(b)
    if (unknown) {
      let shutdownDone = false
      const shutdown = fixture.owner.shutdown().then(() => { shutdownDone = true; return null },
        error => { shutdownDone = true; return error })
      await bounded(bReleaseDelivered.promise)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(shutdownDone).toBe(false)
      resumeARelease.resolve()
      await bounded(aReleaseDelivered.promise)
      expect(await bounded(shutdown)).toEqual(new Error('Audio reader cleanup unconfirmed'))
    } else {
      resumeARelease.resolve()
      await bounded(aReleaseDelivered.promise)
      await new Promise<void>(resolve => setImmediate(resolve))
      await bounded(fixture.owner.shutdown())
    }
    expect(bResponse?.destroyed).toBe(true)
    expect(controlled.release.mock.calls.map(([exact]) => exact)).toEqual([a, b])
    expect(sqlSlot).toBeNull()
    if (!bReader) throw new Error('Successor native body missing')
    await expect(bounded(bReader.read())).rejects.toThrow('Conversation stopped')
  } finally {
    resumeBAuth.resolve(); resumeARelease.resolve()
    bReader?.releaseLock()
    await fixture.close()
  }
})

test('native close before successful acquisition delivery releases exact lease without output', async () => {
  const exact = lease('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  const acquireCommitted = barrier(), resumeAcquire = barrier(), nativeClosed = barrier(), handlerDone = barrier()
  const abort = new AbortController()
  let response: ServerResponse | undefined, produced = false
  const fixture = await nativeFixture(async (incoming, outgoing, owner, resources) => {
    response = outgoing
    outgoing.once('close', () => { abort.abort(); nativeClosed.resolve() })
    try {
      const body = await owner.stream(nativeRequest(incoming, outgoing, abort.signal), resources, pin,
        { start: 0, end: 43, partial: true })
      const reader = body.getReader()
      try { const first = await reader.read(); produced = !first.done && Boolean(first.value?.byteLength) }
      finally { reader.releaseLock() }
    } finally { handlerDone.resolve() }
  })
  controlled.acquire.mockImplementation(async () => {
    acquireCommitted.resolve(); await resumeAcquire.promise; return exact
  })
  controlled.release.mockResolvedValue(true)
  try {
    const client = fixture.connect('/close-before-delivery')
    await bounded(acquireCommitted.promise)
    client.destroy()
    await bounded(nativeClosed.promise)
    expect(response?.destroyed).toBe(true)
    expect(abort.signal.aborted).toBe(true)
    expect(controlled.release).not.toHaveBeenCalled()
    resumeAcquire.resolve()
    await bounded(handlerDone.promise)
    await bounded(fixture.owner.shutdown())
    expect(produced).toBe(false)
    expect(controlled.enqueue).not.toHaveBeenCalled()
    expect(controlled.release).toHaveBeenCalledExactlyOnceWith(exact)
  } finally {
    resumeAcquire.resolve()
    await fixture.close()
  }
})
