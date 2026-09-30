import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import { createHatchetProbeClient, executionRecorderForWorker, until } from '../helpers/hatchet-probe'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function ownedClientTest(check: (client: ReturnType<typeof createHatchetProbeClient>, yamlReads: string[], emptyPath: string) => void | Promise<void>, handleRun?: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), `hatchet-probe-unit-${randomUUID()}-`))
  const emptyPath = join(directory, 'empty.yaml')
  await writeFile(emptyPath, '{}\n', { flag: 'wx' })
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/v1/stable/workflow-runs/') && handleRun) return handleRun(request, response)
    response.setHeader('Content-Type', 'application/json'); response.end('{"version":"V1"}')
  })
  const reads: string[] = []
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned loopback listener')
    const actualRead = fs.readFileSync
    // Guard before the real loader reads: no ambient profile is ever inspected,
    // including while demonstrating the unfixed path-selection defect.
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
      if (String(path).endsWith('.yaml')) {
        reads.push(String(path))
        if (String(path) !== emptyPath) throw Object.assign(new Error('Blocked ambient YAML read'), { code: 'ENOENT' })
      }
      return actualRead(path, options)
    })
    vi.stubEnv('HATCHET_CLIENT_WORKER_HEALTHCHECK_ENABLED', 'true')
    vi.stubEnv('HATCHET_CLIENT_WORKER_HEALTHCHECK_PORT', '8001')
    const token = `e30.${Buffer.from(JSON.stringify({ sub: randomUUID() })).toString('base64url')}.synthetic`
    const client = createHatchetProbeClient({ token, api_url: `http://127.0.0.1:${address.port}`, host_port: `127.0.0.1:${address.port}`, tls_config: { tls_strategy: 'none' } }, emptyPath, () => {})
    await client.tenant.get()
    await check(client, reads, emptyPath)
  } finally {
    vi.restoreAllMocks()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
}

test('owned SDK client refuses an inherited all-interface health listener', async () => {
  await ownedClientTest(async client => {
    expect(client.config.healthcheck?.enabled).toBe(false)
    const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') }
    try {
      // Empty registration initializes the shipped worker without starting it or
      // calling the engine. Its constructor reads the validated health options.
      const worker = await client.worker('synthetic-disabled-health', { workflows: [], slots: 1, handleKill: false })
      expect(worker._internal.enableHealthServer).toBe(false)
      expect(worker._internal.healthPort).toBe(0)
    } finally {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(signal)) if (!before[signal].includes(listener)) process.removeListener(signal, listener)
      }
    }
  })
})

test('real SDK loader reads only the owned empty config using its actual path resolution', async () => {
  await ownedClientTest((_client, reads, emptyPath) => { expect(reads).toEqual([emptyPath]) })
})

test('observer cancels a stalled SDK REST body and closes its actual socket by its deadline', async () => {
  let socketClosed = false, safetyReleased = false
  let safety: ReturnType<typeof setTimeout> | undefined
  try {
    await ownedClientTest(async client => {
      const started = performance.now()
      await expect(until(async request => {
        const result = await client.api.v1WorkflowRunGet('00000000-0000-4000-8000-000000000001', request)
        return result.data.run.status === 'COMPLETED'
      }, 'stalled run', 80)).rejects.toThrow()
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      expect(safetyReleased).toBe(false)
      expect(performance.now() - started).toBeLessThan(300)
      expect(socketClosed).toBe(true)
    }, (request, response) => {
      request.socket.once('close', () => { socketClosed = true })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"run":')
      // Test safety only: makes the broken observer settle and fail assertions.
      safety = setTimeout(() => { safetyReleased = true; response.end('{"status":"QUEUED"}}') }, 400)
    })
  } finally { clearTimeout(safety) }
})

test('a later REST poll receives only the remaining shared observation budget', async () => {
  let calls = 0, stalledSocketClosed = false, safetyReleased = false
  const timers: ReturnType<typeof setTimeout>[] = []
  try {
    await ownedClientTest(async client => {
      const started = performance.now()
      const timeouts: number[] = []
      await expect(until(async request => {
        timeouts.push(request.timeout)
        return (await client.api.v1WorkflowRunGet('00000000-0000-4000-8000-000000000002', request)).data.run.status === 'COMPLETED'
      }, 'later stalled poll', 300)).rejects.toThrow()
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      expect(calls).toBe(2)
      expect(timeouts[1]).toBeLessThan(timeouts[0] - 100)
      expect(safetyReleased).toBe(false)
      expect(performance.now() - started).toBeLessThan(500)
      expect(stalledSocketClosed).toBe(true)
    }, (request, response) => {
      calls++
      if (calls === 1) timers.push(setTimeout(() => { response.setHeader('Content-Type', 'application/json'); response.end('{"run":{"status":"QUEUED"}}') }, 140))
      else {
        request.socket.once('close', () => { stalledSocketClosed = true })
        timers.push(setTimeout(() => { safetyReleased = true; response.end('{"run":{"status":"QUEUED"}}') }, 600))
      }
    })
  } finally { timers.forEach(clearTimeout) }
})

test('a late entry from a stopped generation cannot be counted as replacement execution', () => {
  const entries = new Map<string, string[]>()
  const stopped = executionRecorderForWorker('00000000-0000-4000-8000-000000000011', entries)
  const replacement = executionRecorderForWorker('00000000-0000-4000-8000-000000000012', entries)
  replacement('queued-outbox')
  stopped('queued-outbox')
  expect(entries.get('queued-outbox')).toEqual(['00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000011'])
})

test('an entered handler keeps its generation while its completion crosses replacement creation', async () => {
  const entries = new Map<string, string[]>()
  const original = executionRecorderForWorker('00000000-0000-4000-8000-000000000021', entries)
  let finish = () => {}
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const handler = (async () => { original('in-flight'); await waiting })()
  executionRecorderForWorker('00000000-0000-4000-8000-000000000022', entries)('replacement-input')
  finish()
  await handler
  expect(entries.get('in-flight')).toEqual(['00000000-0000-4000-8000-000000000021'])
  expect(entries.get('replacement-input')).toEqual(['00000000-0000-4000-8000-000000000022'])
})
