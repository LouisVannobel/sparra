// Lifecycle-only fixture: SQL operations/auth principal are doubles. Node req/res,
// socket writes and reader owner are actual; this is not native R1 auth/SQL proof.
import { afterEach, expect, test, vi } from 'vitest'
import { createServer, request as nodeRequest, type ServerResponse } from 'node:http'
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

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

async function bounded<T>(operation: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned native HTTP fixture deadline')), ms)
    })])
  } finally { clearTimeout(timer) }
}

test('request abort destroys actual Node output after Web EOF before native finish', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const incarnation = { incarnation: id, containerId: 'a'.repeat(64), deploymentId: 'fixture' }
  const pin: AudioMetadata = { requestId: id, workspaceId: id, recordingId: id,
    deploymentId: 'fixture', configurationRevision: 1, retentionUntil: new Date(Date.now() + 60000).toISOString(),
    state: 'ready', totalSamples: 1, lastSequence: 0, reason: null }
  const exact: AudioReadLease = { ...incarnation, workspaceId: id, callId: id, recordingId: id,
    leaseId: id, token: id, expiresAt: new Date(Date.now() + 10000) }
  controlled.acquire.mockResolvedValue(exact)
  controlled.release.mockResolvedValue(true)
  controlled.check.mockResolvedValue(undefined)
  const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
  const transactions = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: 'redis://:lifetime-fixture-only-password@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: 'isolated-lifetime-fixture-only-012345678901234567890123456789',
    RATE_LIMIT_KEY_ID: 'lifetime', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test' }))
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test',
    AUTH_SECRET: 'isolated-lifetime-fixture-only-012345678901234567890123456789' })
  if (!config) throw new Error('Lifetime fixture config missing')
  const auth = createApplicationAuth(transactions, config, limiter)
  vi.spyOn(auth, 'requirePrincipal').mockResolvedValue({ userId: 'fixture-user', sessionId: 'fixture-session',
    name: 'Fixture', email: 'fixture@example.test' })
  const resources: WebResources = { transactions, limiter, auth,
    workspaces: createPersonalWorkspaces(transactions), isReady: () => true }
  const owner = createAudioReaderOwner(transactions, incarnation)
  const abort = new AbortController()
  let response: ServerResponse | undefined
  let releaseEnd: (() => void) | undefined
  let ready!: () => void, failed!: (error: unknown) => void
  const eof = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  const server = createServer(async (incoming, outgoing) => {
    response = outgoing
    outgoing.on('error', () => {})
    const nativeEnd = outgoing.end.bind(outgoing)
    // Hold the native end invocation, without substituting response/socket/write.
    vi.spyOn(outgoing, 'end').mockImplementation(() => {
      releaseEnd = () => { nativeEnd() }
      return outgoing
    })
    try {
      const request = new Request('http://localhost/audio', { signal: abort.signal })
      Object.defineProperty(request, 'runtime', { value: { node: { req: incoming, res: outgoing } } })
      Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
      const body = await owner.stream(request, resources, pin, { start: 0, end: 43, partial: true })
      const reader = body.getReader()
      try {
        const first = await reader.read()
        expect(first.done).toBe(false)
        expect(first.value?.byteLength).toBe(44)
        outgoing.write(first.value)
        expect((await reader.read()).done).toBe(true)
        outgoing.end()
        ready()
      } finally { reader.releaseLock() }
    } catch (error) { failed(error); outgoing.destroy() }
  })
  let client: ReturnType<typeof nodeRequest> | undefined
  try {
    server.listen(0, '127.0.0.1')
    await bounded(once(server, 'listening'))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Native HTTP address missing')
    client = nodeRequest({ hostname: '127.0.0.1', port: address.port, path: '/audio' })
    client.on('error', () => {})
    client.on('response', incoming => incoming.resume())
    client.end()
    await bounded(eof)
    if (!response || !releaseEnd) throw new Error('Actual native end was not held')
    expect(response.writableFinished).toBe(false)
    expect(controlled.release).not.toHaveBeenCalled()
    abort.abort()
    expect(response.destroyed).toBe(true)
    await bounded(owner.shutdown())
    expect(controlled.release).toHaveBeenCalledExactlyOnceWith(exact)
  } finally {
    response?.destroy()
    releaseEnd?.()
    client?.destroy()
    server.closeAllConnections()
    await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    await bounded(owner.shutdown())
    await auth.close()
    await limiter.close()
    await pool.end()
  }
})
