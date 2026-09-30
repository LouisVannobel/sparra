import { expect, test, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionListener } from '@hatchet-dev/typescript-sdk/clients/dispatcher/action-listener.js'
import { createAuthMailHatchet } from '../../src/modules/auth/mail-hatchet.server'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mail-listener-'))
  const path = join(directory, 'empty.yaml'); await writeFile(path, '{}\n')
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url'), 'synthetic'].join('.')
  const owner = new AbortController()
  const client = createAuthMailHatchet({ token, host_port: '127.0.0.1:1', api_url: 'http://127.0.0.1:1', tls_config: { tls_strategy: 'none' } }, path, owner.signal)
  return { client, owner, cleanup: () => rm(directory, { recursive: true }) }
}

test.each(['listen', 'listenV2'] as const)('%s refuses synchronously after terminal stop', async method => {
  const f = await fixture()
  try {
    f.owner.abort()
    expect(() => f.client.dispatcher.client[method]({ workerId: 'owned' })).toThrowError(expect.objectContaining({ name: 'AbortError' }))
  } finally { await f.cleanup() }
})

test.each(['listen', 'listenV2'] as const)('%s created before stop refuses first advancement', async method => {
  const f = await fixture()
  try {
    const iterable = f.client.dispatcher.client[method]({ workerId: 'owned' })
    f.owner.abort()
    await expect(iterable[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'AbortError' })
  } finally { await f.cleanup() }
})

test.each([1, 2] as const)('actual strategy %s inner retry delay joins after stop without late heartbeat admission', async strategy => {
  const f = await fixture()
  const listener = new ActionListener(f.client.dispatcher, 'owned')
  listener.listenStrategy = strategy
  listener.retries = 1; listener.lastConnectionAttempt = Date.now()
  // Network unsubscribe and thread launch are the external boundaries only.
  const unsubscribe = vi.spyOn(listener.client, 'unsubscribe').mockResolvedValue({ tenantId: 'synthetic', workerId: 'owned' })
  const heartbeat = vi.spyOn(listener.heartbeat, 'start').mockResolvedValue()
  vi.useFakeTimers()
  try {
    const iteration = listener.getListenClient()
    const outcome = iteration.then(() => 'admitted', error => error.name)
    expect(vi.getTimerCount()).toBe(1) // actual getListenClient installed its inner sleep
    f.owner.abort(); await listener.unregister()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await outcome).toBe('AbortError')
    expect(heartbeat).not.toHaveBeenCalled()
  } finally {
    listener.abortController?.abort()
    vi.useRealTimers(); unsubscribe.mockRestore(); heartbeat.mockRestore()
    await f.cleanup()
  }
})

test.each([1, 2] as const)('actual strategy %s actions iterator completes after stop inside its inner retry delay', async strategy => {
  const f = await fixture()
  const listener = new ActionListener(f.client.dispatcher, 'owned')
  listener.listenStrategy = strategy; listener.retries = 1; listener.lastConnectionAttempt = Date.now()
  const unsubscribe = vi.spyOn(listener.client, 'unsubscribe').mockResolvedValue({ tenantId: 'synthetic', workerId: 'owned' })
  const heartbeat = vi.spyOn(listener.heartbeat, 'start').mockResolvedValue()
  vi.useFakeTimers()
  const iterator = listener.actions()
  try {
    const next = iterator.next()
    expect(vi.getTimerCount()).toBe(1)
    f.owner.abort(); await listener.unregister()
    await vi.advanceTimersByTimeAsync(5000)
    expect((await next).done).toBe(true)
    expect((await iterator.next()).done).toBe(true)
    expect(heartbeat).not.toHaveBeenCalled()
  } finally {
    listener.abortController?.abort(); vi.useRealTimers()
    unsubscribe.mockRestore(); heartbeat.mockRestore(); await f.cleanup()
  }
})
