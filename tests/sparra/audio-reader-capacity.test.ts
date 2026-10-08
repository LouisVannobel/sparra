// Global holder capacity only: actual Node req/res and stream owner, controlled
// SQL/principal boundaries. This does not qualify native R1 auth or SQL release.
import { expect, test, vi } from 'vitest'
import { createServer, request as nodeRequest, type ClientRequest } from 'node:http'
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

async function bounded<T>(operation: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native capacity fixture deadline')), ms)
    })])
  } finally { clearTimeout(timer) }
}

test('eight global permits are reserved before concurrent Workspace acquires await', async () => {
  const incarnation = { incarnation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    containerId: 'a'.repeat(64), deploymentId: 'capacity-fixture' }
  let releaseAcquire!: () => void, allEntered!: () => void
  const gate = new Promise<void>(resolve => { releaseAcquire = resolve })
  const entered = new Promise<void>(resolve => { allEntered = resolve })
  controlled.acquire.mockImplementation(async (_principal, pin: AudioMetadata) => {
    await gate
    const exact: AudioReadLease = { ...incarnation, workspaceId: pin.workspaceId,
      callId: pin.requestId, recordingId: pin.recordingId, leaseId: pin.requestId,
      token: pin.requestId, expiresAt: new Date(Date.now() + 10000) }
    return exact
  })
  controlled.check.mockResolvedValue(undefined)
  // No fake cleanup ACK: native output joins, but uncertain SQL release stays
  // occupied and shutdown reports that exact unconfirmed ownership.
  controlled.release.mockResolvedValue(false)
  const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
  const transactions = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: 'redis://:capacity-fixture-only-password@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: 'isolated-capacity-fixture-only-012345678901234567890123456789',
    RATE_LIMIT_KEY_ID: 'capacity', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test',
  }))
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test',
    AUTH_SECRET: 'isolated-capacity-fixture-only-012345678901234567890123456789' })
  if (!config) throw new Error('Capacity fixture config missing')
  const auth = createApplicationAuth(transactions, config, limiter)
  vi.spyOn(auth, 'requirePrincipal').mockResolvedValue({ userId: 'fixture-user', sessionId: 'fixture-session',
    name: 'Fixture', email: 'fixture@example.test' })
  const resources: WebResources = { transactions, limiter, auth,
    workspaces: createPersonalWorkspaces(transactions), isReady: () => true }
  const owner = createAudioReaderOwner(transactions, incarnation)
  const clients: ClientRequest[] = []
  let arrivals = 0
  const server = createServer(async (incoming, outgoing) => {
    outgoing.on('error', () => {})
    const index = Number(incoming.url?.slice(1))
    const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0')
    const pin: AudioMetadata = { requestId: id, workspaceId: id, recordingId: id,
      deploymentId: 'capacity-fixture', configurationRevision: 1,
      retentionUntil: new Date(Date.now() + 60000).toISOString(), state: 'ready',
      totalSamples: 1, lastSequence: 0, reason: null }
    const request = new Request('http://localhost/' + index)
    Object.defineProperty(request, 'runtime', { value: { node: { req: incoming, res: outgoing } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    if (++arrivals === 9) allEntered()
    try {
      const body = await owner.stream(request, resources, pin, { start: 0, end: 43, partial: true })
      const reader = body.getReader()
      try {
        const header = await reader.read()
        if (!header.value || header.done) throw new Error('Capacity fixture header missing')
        outgoing.write(header.value)
        if (!(await reader.read()).done) throw new Error('Capacity fixture EOF missing')
        outgoing.end()
      } finally { reader.releaseLock() }
    } catch {
      outgoing.statusCode = 409
      outgoing.end('Holder unavailable')
    }
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Capacity fixture address missing')
    const results = Array.from({ length: 9 }, (_, index) => new Promise<number>((resolve, reject) => {
      const client = nodeRequest({ host: '127.0.0.1', port: address.port, path: '/' + (index + 1) }, response => {
        response.resume()
        response.once('end', () => resolve(response.statusCode ?? 0))
        response.once('error', () => reject(new Error('Capacity fixture response failed')))
      })
      clients.push(client)
      client.once('error', () => reject(new Error('Capacity fixture request failed')))
      client.end()
    }))
    await bounded(entered)
    releaseAcquire()
    const statuses = await bounded(Promise.all(results))
    expect(statuses.filter(status => status === 200)).toHaveLength(8)
    expect(statuses.filter(status => status === 409)).toHaveLength(1)
    await expect(bounded(owner.shutdown())).rejects.toThrow('Audio reader cleanup unconfirmed')
  } finally {
    releaseAcquire()
    for (const client of clients) client.destroy()
    server.closeAllConnections()
    await bounded(new Promise<void>(resolve => server.close(() => resolve())))
    await bounded(owner.shutdown()).catch(() => {})
    await auth.close(); await limiter.close(); await pool.end()
    vi.restoreAllMocks()
  }
})

test('shutdown joins held admission and cleans its known slot without constructing late output', async () => {
  vi.clearAllMocks()
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const incarnation = { incarnation: id, containerId: 'b'.repeat(64), deploymentId: 'shutdown-fixture' }
  const pin: AudioMetadata = { requestId: id, workspaceId: id, recordingId: id,
    deploymentId: 'shutdown-fixture', configurationRevision: 1,
    retentionUntil: new Date(Date.now() + 60000).toISOString(), state: 'ready',
    totalSamples: 1, lastSequence: 0, reason: null }
  let acquireEntered!: () => void, releaseAcquire!: () => void
  const entered = new Promise<void>(resolve => { acquireEntered = resolve })
  const gate = new Promise<void>(resolve => { releaseAcquire = resolve })
  let acquired = false, shutdownDone = false
  const releases: { acquired: boolean; shutdownDone: boolean }[] = []
  controlled.acquire.mockImplementation(async () => {
    acquireEntered()
    await gate
    acquired = true
    const exact: AudioReadLease = { ...incarnation, workspaceId: id, callId: id, recordingId: id,
      leaseId: id, token: id, expiresAt: new Date(Date.now() + 10000) }
    return exact
  })
  controlled.check.mockResolvedValue(undefined)
  controlled.release.mockImplementation(async () => {
    releases.push({ acquired, shutdownDone })
    return true
  })
  const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
  const transactions = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: 'redis://:shutdown-fixture-only-password@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: 'isolated-shutdown-fixture-only-012345678901234567890123456789',
    RATE_LIMIT_KEY_ID: 'shutdown', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test',
  }))
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test',
    AUTH_SECRET: 'isolated-shutdown-fixture-only-012345678901234567890123456789' })
  if (!config) throw new Error('Shutdown fixture config missing')
  const auth = createApplicationAuth(transactions, config, limiter)
  vi.spyOn(auth, 'requirePrincipal').mockResolvedValue({ userId: 'fixture-user', sessionId: 'fixture-session',
    name: 'Fixture', email: 'fixture@example.test' })
  const resources: WebResources = { transactions, limiter, auth,
    workspaces: createPersonalWorkspaces(transactions), isReady: () => true }
  const owner = createAudioReaderOwner(transactions, incarnation)
  let client: ClientRequest | undefined
  let reply: Promise<{ value: { status: number; bytes: Buffer } | null; error: unknown }> | undefined
  let shutdown: Promise<void> | undefined
  const server = createServer(async (incoming, outgoing) => {
    outgoing.on('error', () => {})
    const request = new Request('http://localhost/shutdown')
    Object.defineProperty(request, 'runtime', { value: { node: { req: incoming, res: outgoing } } })
    Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
    try {
      const body = await owner.stream(request, resources, pin, { start: 0, end: 43, partial: true })
      const reader = body.getReader()
      try {
        const header = await reader.read()
        outgoing.end(header.value)
      } finally { reader.releaseLock() }
    } catch {
      outgoing.statusCode = 409
      outgoing.end('Holder unavailable')
    }
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Shutdown fixture address missing')
    reply = new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
      client = nodeRequest({ host: '127.0.0.1', port: address.port }, response => {
        const bytes: Buffer[] = []
        response.on('data', chunk => bytes.push(Buffer.from(chunk)))
        response.once('end', () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(bytes) }))
        response.once('error', () => reject(new Error('Shutdown fixture response failed')))
      })
      client.once('error', () => reject(new Error('Shutdown fixture request failed')))
      client.end()
    }).then(value => ({ value, error: null }), error => ({ value: null, error }))
    await bounded(entered)
    shutdown = owner.shutdown().then(() => { shutdownDone = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(shutdownDone).toBe(false)
    expect(releases).toEqual([])
    releaseAcquire()
    const result = await bounded(reply)
    await bounded(shutdown)
    expect(result.error).toBeNull()
    expect(result.value?.status).toBe(409)
    expect(result.value?.bytes.includes(Buffer.from('RIFF'))).toBe(false)
    expect(releases).toEqual([{ acquired: true, shutdownDone: false }])
    expect(shutdownDone).toBe(true)
  } finally {
    releaseAcquire()
    if (reply) await bounded(reply).catch(() => {})
    client?.destroy()
    server.closeAllConnections()
    await bounded(new Promise<void>(resolve => server.close(() => resolve())))
    if (shutdown) await bounded(shutdown).catch(() => {})
    await bounded(owner.shutdown()).catch(() => {})
    await auth.close(); await limiter.close(); await pool.end()
    vi.restoreAllMocks()
  }
})
