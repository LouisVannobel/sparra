// Actual Node output/reader lifecycle; principal, SQL and decryption boundaries
// are controlled. These witnesses do not qualify native R1 or a PostgreSQL race.
import { afterEach, expect, test, vi } from 'vitest'
import { createServer, request as nodeRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Pool } from 'pg'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { AudioMetadata, AudioReadLease } from '../../src/modules/sparra/audio.server'
import type { WebResources } from '../../src/platform/resources.server'

const controlled = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(), check: vi.fn(), page: vi.fn(),
  enqueue: vi.fn(), decrypt: vi.fn() }))
vi.mock('../../src/modules/sparra/audio.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/sparra/audio.server')>()
  return { ...actual, createAudioOperations: () => controlled, decryptAudioChunk: controlled.decrypt }
})
import { AudioUnavailable } from '../../src/modules/sparra/audio.server'
import { createAudioReaderOwner } from '../../src/modules/sparra/audio-reader.server'

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([value, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native interruption fixture deadline')), 2000)
  })]) } finally { clearTimeout(timer) }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 25))
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const incarnation = { incarnation: id, containerId: 'c'.repeat(64), deploymentId: 'interruption-fixture' }
const pin = (samples: number, lastSequence: number): AudioMetadata => ({ requestId: id, workspaceId: id,
  recordingId: id, deploymentId: incarnation.deploymentId, configurationRevision: 1,
  retentionUntil: new Date(Date.now() + 60000).toISOString(), state: 'ready',
  totalSamples: samples, lastSequence, reason: null })

function fixture() {
  const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
  const transactions = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: 'redis://:interruption-fixture-only-password@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: 'isolated-interruption-fixture-only-012345678901234567890123456789',
    RATE_LIMIT_KEY_ID: 'interruption', TRUSTED_PROXY_IPS: '127.0.0.1', NODE_ENV: 'test',
  }))
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test',
    AUTH_SECRET: 'isolated-interruption-fixture-only-012345678901234567890123456789' })
  if (!config) throw new Error('Interruption fixture config missing')
  const auth = createApplicationAuth(transactions, config, limiter)
  const principal = vi.spyOn(auth, 'requirePrincipal').mockResolvedValue({ userId: 'fixture-user',
    sessionId: 'fixture-session', name: 'Fixture', email: 'fixture@example.test' })
  const resources: WebResources = { transactions, limiter, auth,
    workspaces: createPersonalWorkspaces(transactions), isReady: () => true }
  const owner = createAudioReaderOwner(transactions, incarnation)
  controlled.acquire.mockImplementation(async () => {
    const exact: AudioReadLease = { ...incarnation, workspaceId: id, callId: id, recordingId: id,
      leaseId: id, token: id, expiresAt: new Date(Date.now() + 10000) }
    return exact
  })
  controlled.check.mockResolvedValue(undefined)
  return { owner, resources, principal, close: async () => {
    await bounded(owner.shutdown()).catch(() => {})
    await auth.close(); await limiter.close(); await pool.end()
  } }
}
function request(incoming: IncomingMessage, outgoing: ServerResponse) {
  const value = new Request('http://localhost/interruption')
  Object.defineProperty(value, 'runtime', { value: { node: { req: incoming, res: outgoing } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  return value
}

test('lost auth probe destroys actual writefalse output with no SQL or decrypt active', async () => {
  const f = fixture(), metadata = pin(4_800_000, 599)
  let serverResponse: ServerResponse | undefined, clientResponse: IncomingMessage | undefined
  let client: ClientRequest | undefined, forwarding: Promise<void> | undefined
  let sqlActive = 0, decryptActive = 0, written = 0, writeFalse = 0, waitingDrain = false, serverClosed = false
  let observing = true
  const releaseStates: { closed: boolean; sqlActive: number; decryptActive: number }[] = []
  controlled.page.mockImplementation(async () => {
    sqlActive++
    try { return { sampleCount: 8000 } } finally { sqlActive-- }
  })
  controlled.decrypt.mockImplementation(async () => {
    decryptActive++
    try { return Buffer.alloc(32000, 73) } finally { decryptActive-- }
  })
  controlled.check.mockImplementation(async () => {
    sqlActive++
    try { return undefined } finally { sqlActive-- }
  })
  controlled.enqueue.mockImplementation(async (_principal, _pin, _exact, _signal, put: () => void) => {
    sqlActive++
    try { put() } finally { sqlActive-- }
  })
  controlled.release.mockImplementation(async () => {
    releaseStates.push({ closed: serverClosed, sqlActive, decryptActive })
    return true
  })
  const server = createServer({ highWaterMark: 16384 }, (incoming, outgoing) => {
    serverResponse = outgoing
    outgoing.on('error', () => {})
    const closed = new Promise<void>(resolve => outgoing.once('close', () => { serverClosed = true; resolve() }))
    forwarding = (async () => {
      const body = await f.owner.stream(request(incoming, outgoing), f.resources, metadata,
        { start: 0, end: 44 + metadata.totalSamples * 4 - 1, partial: false })
      const reader = body.getReader()
      outgoing.setHeader('Content-Length', 44 + metadata.totalSamples * 4)
      try {
        while (!outgoing.destroyed) {
          const next = await reader.read()
          if (next.done) { outgoing.end(); break }
          written += next.value.byteLength
          // This is the real Node return value, not a substituted write result.
          if (!outgoing.write(next.value)) {
            writeFalse++
            waitingDrain = true
            try { await Promise.race([once(outgoing, 'drain'), closed]) }
            finally { waitingDrain = false }
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    })().catch(() => {})
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Interruption address missing')
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      client = nodeRequest({ host: '127.0.0.1', port: address.port }, value => {
        value.on('error', () => {}); value.pause(); resolve(value)
      })
      client.once('error', () => reject(new Error('Interruption request failed'))); client.end()
    })
    clientResponse = await bounded(response)
    await bounded((async () => {
      while (observing) {
        const observed = written
        await tick()
        if (waitingDrain && written === observed && writeFalse > 0) break
      }
    })())
    expect(sqlActive).toBe(0); expect(decryptActive).toBe(0)
    expect(written).toBeLessThan(44 + metadata.totalSamples * 4)
    f.principal.mockRejectedValue(new Error('Controlled principal loss'))
    await expect.poll(() => releaseStates.length, { timeout: 1000, interval: 10 }).toBe(1)
    expect(releaseStates).toEqual([{ closed: true, sqlActive: 0, decryptActive: 0 }])
    expect(serverResponse?.destroyed).toBe(true)
    clientResponse.resume()
    if (!forwarding) throw new Error('Native forwarding missing')
    await bounded(forwarding)
    expect(clientResponse.complete).toBe(false)
    await bounded(f.owner.shutdown())
  } finally {
    observing = false
    clientResponse?.destroy(); client?.destroy(); server.closeAllConnections()
    if (forwarding) await bounded(forwarding).catch(() => {})
    await bounded(new Promise<void>(resolve => server.close(() => resolve())))
    await f.close()
  }
})

test('denial before final enqueue releases no PCM into actual Node output', async () => {
  const f = fixture(), metadata = pin(8000, 0)
  let entered!: () => void, deny!: () => void
  const held = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { deny = resolve })
  let client: ClientRequest | undefined, forwarding: Promise<void> | undefined, written = 0
  let result: Promise<void> | undefined
  controlled.page.mockResolvedValue({ sampleCount: 8000 })
  controlled.decrypt.mockResolvedValue(Buffer.alloc(32000, 73))
  controlled.release.mockResolvedValue(true)
  controlled.enqueue.mockImplementation(async () => {
    entered(); await gate; throw new AudioUnavailable()
  })
  const server = createServer((incoming, outgoing) => {
    outgoing.on('error', () => {})
    forwarding = (async () => {
      const body = await f.owner.stream(request(incoming, outgoing), f.resources, metadata,
        { start: 44, end: 47, partial: true })
      const reader = body.getReader()
      try {
        const value = await reader.read()
        if (value.value) { written += value.value.byteLength; outgoing.write(value.value) }
        outgoing.end()
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    })().catch(() => {})
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Final enqueue address missing')
    result = new Promise<void>(resolve => {
      client = nodeRequest({ host: '127.0.0.1', port: address.port }, response => {
        response.on('data', () => {})
        response.once('end', resolve); response.once('close', resolve); response.on('error', () => {})
      })
      client.once('error', () => resolve()); client.end()
    })
    await bounded(held)
    expect(written).toBe(0)
    deny()
    await bounded(result)
    if (!forwarding) throw new Error('Final enqueue forwarding missing')
    await bounded(forwarding)
    expect(written).toBe(0)
    await bounded(f.owner.shutdown())
  } finally {
    deny(); client?.destroy(); server.closeAllConnections()
    if (forwarding) await bounded(forwarding).catch(() => {})
    await bounded(new Promise<void>(resolve => server.close(() => resolve())))
    await f.close()
  }
})
