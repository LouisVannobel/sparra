import { expect, test, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HatchetLogger } from '@hatchet-dev/typescript-sdk/clients/hatchet-client/hatchet-logger.js'
import { createAuthMailHatchet, createAuthMailTask, runAuthMailTask } from '../../src/modules/auth/mail-hatchet.server'
import { createAuthMailHandler, type HandlerResult } from '../../src/modules/auth/mail-worker.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { randomBytes } from 'node:crypto'

test('application native configuration suppresses direct heartbeat debug as well as forwarded raw errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-mail-sdk-'))
  const path = join(directory, 'empty.yaml'); await writeFile(path, '{}\n')
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url'), 'synthetic'].join('.')
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const client = createAuthMailHatchet({ token, host_port: '127.0.0.1:1', api_url: 'http://127.0.0.1:1', tls_config: { tls_strategy: 'none' } }, path)
    const thread = new HatchetLogger('HeartbeatThread', client.config.log_level)
    await thread.debug('synthetic diagnostic')
    await client.config.logger('HeartbeatController').error('synthetic sensitive error')
    expect(debug).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
  } finally { debug.mockRestore(); error.mockRestore(); await rm(directory, { recursive: true }) }
})
test('actual task declaration carries the finite retry candidate and preserves execution/idempotency bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-mail-policy-'))
  const path = join(directory, 'empty.yaml'); await writeFile(path, '{}\n')
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toString('base64url'), 'synthetic'].join('.')
  const handler = createAuthMailHandler({ async claimDelivery() { return null }, async finalizeDelivery() { return false } },
    createAuthEmailEnvelope({ currentKeyId: 'k', keys: { k: randomBytes(32) } }), { async send() { return { state: 'held' } } })
  try {
    const client = createAuthMailHatchet({ token, host_port: '127.0.0.1:1', api_url: 'http://127.0.0.1:1', tls_config: { tls_strategy: 'none' } }, path)
    const task = createAuthMailTask(client, handler)
    expect(task.taskDef).toMatchObject({ name: 'auth-email-delivery', retries: 4, backoff: { factor: 5, maxSeconds: 30 }, executionTimeout: '30s', scheduleTimeout: '10m' })
    expect(task.definition.idempotency).toEqual({ strategy: 'ttl', ttlMs: 600000, expression: "'auth-email-delivery:' + input.outboxId" })
    expect(client.config.retrier?.maxAttempts).toBe(1)
    const zero = client.task({ ...task.taskDef, retries: 0 })
    expect(zero.taskDef.retries).toBe(0)
    expect(zero.taskDef.fn).toBe(task.taskDef.fn)
  } finally { await handler.stop(); await rm(directory, { recursive: true }) }
})
test.each([
  ['worker_stopping', 'AUTH_MAIL_WORKER_STOPPING'],
  ['outbox_in_flight', 'AUTH_MAIL_OUTBOX_IN_FLIGHT'],
  ['capacity_busy', 'AUTH_MAIL_CAPACITY_BUSY'],
  ['claim_unresolved', 'AUTH_MAIL_CLAIM_UNRESOLVED'],
] as const)('native boundary rejects %s only after fulfilled handler result, with a constant safe code', async (reason, code) => {
  let settled = false
  const handler = { async handle(): Promise<HandlerResult> { settled = true; return { state: 'deferred', reason } } }
  const result = await runAuthMailTask(handler, { outboxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, new AbortController().signal).then(() => null, error => error)
  expect(settled).toBe(true)
  expect(result instanceof Error && result.message === code && result.cause === undefined).toBe(true)
})
test.each(['inert', 'cancelled', 'held', 'effect_unknown', 'plunk_queued'] as const)('native boundary preserves fulfilled %s without deliberate retry', async state => {
  expect(await runAuthMailTask({ async handle() { return { state } } }, {}, new AbortController().signal)).toEqual({ state })
})
