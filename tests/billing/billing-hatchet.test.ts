import { Agent, ClientRequest, createServer } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { createAuthMailHatchet } from '../../src/modules/auth/mail-hatchet.server'
import { admitBillingTask, createBillingTask, stopBillingRelay } from '../../src/modules/billing/billing-hatchet.server'

const tenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const input = { outboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: tenantId })).toString('base64url'), 'synthetic'].join('.')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.restoreAllMocks() }
})

async function httpFixture(status: 200 | 503 = 200) {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    request.resume()
    const admission = request.method === 'POST'
    response.writeHead(admission ? status : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(admission ? { run: { metadata: { id: runId } } }
      : { metadata: { id: tenantId }, version: 'V1' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback address missing')
  const directory = await mkdtemp(join(tmpdir(), 'billing-cleanup-'))
  cleanups.push(async () => {
    const resolved = await realpath(directory), temp = await realpath(tmpdir())
    if (dirname(resolved) !== temp || !basename(resolved).startsWith('billing-cleanup-')) throw new Error('Owned fixture directory rejected')
    await rm(resolved, { recursive: true })
  })
  const configPath = join(directory, 'empty.yaml')
  await writeFile(configPath, '{}\n')
  const owner = new AbortController()
  const client = createAuthMailHatchet({ token, host_port: '127.0.0.1:1', api_url: `http://127.0.0.1:${address.port}`,
    tls_config: { tls_strategy: 'none' } }, configPath, owner.signal)
  cleanups.push(async () => { owner.abort() })
  await expect.poll(() => paths.length).toBe(1)
  const bootstrap = await client.api.tenantGet(tenantId)
  const bootstrapRequest = bootstrap.request
  if (!(bootstrapRequest instanceof ClientRequest)) throw new Error('Native bootstrap request missing')
  await expect.poll(() => bootstrapRequest.closed).toBe(true)
  const task = createBillingTask(client, {
    async handle() { throw new Error('Unexpected task execution') }, async stop() {},
  })
  const unsafe = vi.fn()
  return { client, task, paths, bootstrapRequest, unsafe,
    admit: () => admitBillingTask(task, input, owner.signal, unsafe) }
}

test.each([200, 503] as const)('joins a real closed native request for HTTP %i', async status => {
  const fixture = await httpFixture(status)
  expect(await fixture.admit()).toEqual(status === 200 ? { state: 'admitted', runId } : { state: 'unknown' })
  await expect(stopBillingRelay(fixture.task, Date.now() + 1000)).resolves.toBeUndefined()
  expect(fixture.paths.filter(path => path.startsWith('POST '))).toEqual([
    `POST /api/v1/stable/tenants/${tenantId}/workflow-runs/trigger` ])
  expect(fixture.unsafe).not.toHaveBeenCalled()
})

test.each(['options proxy', 'agent proxy', 'custom prototype'] as const)(
  'refuses a %s agent before dispatch', async kind => {
    const fixture = await httpFixture()
    const agent = new Agent(kind === 'options proxy' ? { proxyEnv: {} } : {})
    if (kind === 'agent proxy') Object.assign(agent, { proxyEnv: {} })
    if (kind === 'custom prototype') Object.setPrototypeOf(agent, Object.create(Agent.prototype))
    fixture.client.api.instance.defaults.httpAgent = agent
    cleanups.push(async () => { agent.destroy() })
    expect(await fixture.admit()).toEqual({ state: 'unknown' })
    expect(fixture.paths.filter(path => path.startsWith('POST '))).toEqual([])
    await expect(stopBillingRelay(fixture.task, Date.now() + 1000)).resolves.toBeUndefined()
  })

test('refuses disabled HTTPS verification before sending any request', async () => {
  const fixture = await httpFixture()
  fixture.client.api.instance.defaults.baseURL = 'https://127.0.0.1:1'
  const agent = new HttpsAgent({ rejectUnauthorized: false })
  fixture.client.api.instance.defaults.httpsAgent = agent
  cleanups.push(async () => { agent.destroy() })
  const task = createBillingTask(fixture.client, { async handle() { throw new Error('Unexpected task') }, async stop() {} })
  expect(await admitBillingTask(task, input, new AbortController().signal, fixture.unsafe)).toEqual({ state: 'unknown' })
  expect(fixture.paths.filter(path => path.startsWith('POST '))).toEqual([])
  await expect(stopBillingRelay(task, Date.now() + 1000)).resolves.toBeUndefined()
})

test('refuses a replacement serializer before dispatch while retaining native normalization of the owned function', async () => {
  const fixture = await httpFixture()
  fixture.client.api.instance.interceptors.request.use(config => {
    config.paramsSerializer = { serialize: () => 'injected=true' }
    return config
  })
  expect(await fixture.admit()).toEqual({ state: 'unknown' })
  expect(fixture.paths.filter(path => path.startsWith('POST '))).toEqual([])
  await expect(stopBillingRelay(fixture.task, Date.now() + 1000)).resolves.toBeUndefined()
})

test.each(['missing', 'conflicting', 'nested only'] as const)('treats %s public transport handles with identity checks', async mode => {
  const fixture = await httpFixture(503)
  fixture.client.api.instance.interceptors.response.use(undefined, (error: unknown) => {
    if (!error || typeof error !== 'object' || !('request' in error)) throw error
    if (mode === 'missing') throw { response: { request: { closed: true } } }
    if (mode === 'conflicting') throw { request: fixture.bootstrapRequest, response: { request: error.request } }
    throw { response: { request: error.request } }
  })
  expect(await fixture.admit()).toEqual({ state: 'unknown' })
  if (mode === 'nested only') {
    await expect(stopBillingRelay(fixture.task, Date.now() + 1000)).resolves.toBeUndefined()
    expect(fixture.unsafe).not.toHaveBeenCalled()
  } else {
    await expect(stopBillingRelay(fixture.task, Date.now() + 1000)).rejects.toThrow('transport closure unproven')
    expect(fixture.unsafe).toHaveBeenCalledOnce()
  }
})
