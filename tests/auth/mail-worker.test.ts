import { expect, test, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createAuthMailHandler } from '../../src/modules/auth/mail-worker.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { createMailSnapshot } from '../../src/modules/auth/mail-snapshot.server'
import type { MailStore, MailClaim } from '../../src/modules/auth/mail-store.server'
import type { PlunkResult } from '../../src/modules/auth/plunk.server'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function fixture(replayWindowSeconds: number | null = null) {
  const codec = createAuthEmailEnvelope({ currentKeyId: 'k', keys: { k: randomBytes(32) } })
  const now = new Date(), expiresAt = new Date(now.getTime() + 600000)
  const snap = createMailSnapshot({ appOrigin: 'https://app.example.test', apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'k', from: { name: 'Product', email: 'auth@example.test' }, reply: 'reply@example.test', replayWindowSeconds }, { recipient: 'one@example.test', locale: 'en' }, id, randomBytes(32))
  const claim: MailClaim = { outboxId: id, deliveryId: id, purpose: 'magic-link', generation: 1, fence: 1, format: 'auth-plunk-v1', hash: snap.hash, ...codec.seal(snap.bytes, { deliveryId: id, purpose: 'magic-link', generation: 1, expiresAt }, now), expiresAt: expiresAt.toISOString(), databaseTime: now.toISOString(), leaseUntil: new Date(now.getTime() + 15000).toISOString(), replayWindowSeconds, replayNotAfter: replayWindowSeconds === null ? null : new Date(now.getTime() + replayWindowSeconds * 1000).toISOString() }
  const results: PlunkResult[] = []
  const store: Pick<MailStore, 'claimDelivery' | 'finalizeDelivery'> = { async claimDelivery() { return claim }, async finalizeDelivery(_id, _fence, result) { results.push(result); return true } }
  return { claim, codec, store, results }
}
test('handler rejects malformed job inputs before SQL or network and tracks duplicate owned work', async () => {
  const f = fixture(); let sends = 0, release!: () => void
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { sends++; await new Promise<void>(resolve => { release = resolve }); return { state: 'effect_unknown' } } })
  for (const input of [{}, { outboxId: id, recipient: 'one@example.test' }, { outboxId: 'bad' }]) expect(await handler.handle(input, new AbortController().signal)).toEqual({ state: 'inert' })
  const pending = handler.handle({ outboxId: id }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'deferred', reason: 'outbox_in_flight' })
  expect(sends).toBe(1); release(); await pending; await handler.stop()
})
test('shutdown aborts but joins actual handler completion even if a native stop would already resolve', async () => {
  const f = fixture(); let aborted = false, release!: () => void, finished = false
  const handler = createAuthMailHandler(f.store, f.codec, { async send(_payload, signal) { signal.addEventListener('abort', () => { aborted = true }); await new Promise<void>(resolve => { release = resolve }); return { state: 'effect_unknown' } } })
  const pending = handler.handle({ outboxId: id }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 10))
  const stopping = handler.stop().then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 10)); expect(aborted).toBe(true); expect(finished).toBe(false)
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'deferred', reason: 'worker_stopping' })
  release(); await pending; await stopping; expect(f.results).toEqual([{ state: 'effect_unknown' }])
})
test.each(['hash', 'tag', 'key', 'expiry'])('invalid %s holds without provider calls or error-content disclosure', async change => {
  const f = fixture(); let sends = 0
  if (change === 'hash') Object.assign(f.claim, { hash: '0'.repeat(64) })
  if (change === 'tag') Object.assign(f.claim, { tag: '0'.repeat(32) })
  if (change === 'key') Object.assign(f.claim, { keyId: 'missing' })
  if (change === 'expiry') Object.assign(f.claim, { expiresAt: '2000-01-01T00:00:00.000Z' })
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { sends++; return { state: 'effect_unknown' } } })
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'held' })
  expect(sends).toBe(0); expect(f.results).toEqual([{ state: 'held' }]); await handler.stop()
})
test('a transport exception after invocation remains effect_unknown', async () => {
  const f = fixture()
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { throw new Error('sensitive transport failure') } })
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'effect_unknown' })
  expect(f.results).toEqual([{ state: 'effect_unknown' }]); await handler.stop()
})
test('a retry without its persisted replay deadline is held before transport', async () => {
  const f = fixture(2)
  Object.assign(f.claim, { fence: 2, replayNotAfter: null })
  let calls = 0
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { calls++; return { state: 'effect_unknown' } } })
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'held' })
  expect(calls).toBe(0)
  await handler.stop()
})
test('the retry deadline subtracts elapsed claim and decryption time before transport', async () => {
  const f = fixture(2)
  Object.assign(f.claim, { fence: 2, replayNotAfter: new Date(new Date(f.claim.databaseTime).getTime() + 120).toISOString() })
  const originalClaim = f.store.claimDelivery
  f.store.claimDelivery = async (...args) => { await new Promise(resolve => setTimeout(resolve, 35)); return originalClaim(...args) }
  let remaining: number | undefined
  const handler = createAuthMailHandler(f.store, f.codec, { async send(_snapshot, _signal, deadlineAt) { remaining = deadlineAt - performance.now(); return { state: 'effect_unknown' } } })
  await handler.handle({ outboxId: id }, new AbortController().signal)
  expect(remaining !== undefined && remaining > 0 && remaining < 90).toBe(true)
  await handler.stop()
})
test('PostgreSQL submillisecond clock precision cannot extend a retry deadline when decoded as a JS Date', async () => {
  const f = fixture(2)
  const databaseTime = new Date(f.claim.databaseTime)
  Object.assign(f.claim, { fence: 2, databaseTime: f.claim.databaseTime.replace('Z', '999Z'), replayNotAfter: new Date(databaseTime.getTime() + 40).toISOString() })
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  let deadline: number | undefined
  const handler = createAuthMailHandler(f.store, f.codec, { async send(_snapshot, _signal, deadlineAt) { deadline = deadlineAt; return { state: 'effect_unknown' } } })
  try {
    await handler.handle({ outboxId: id }, new AbortController().signal)
    expect(deadline).toBe(1039)
  } finally { await handler.stop(); clock.mockRestore() }
})
test('retained claim failure defers same and distinct outboxes without replacing or releasing the owned promise', async () => {
  const f = fixture()
  let release!: () => void, entered!: () => void, calls = 0, sends = 0
  const enteredClaim = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  f.store.claimDelivery = async () => {
    calls++
    if (calls === 1) { entered(); await held; throw new Error('private claim error') }
    return f.claim
  }
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { sends++; return { state: 'effect_unknown' } } })
  let originalSettled = false
  const original = handler.handle({ outboxId: id }, new AbortController().signal).then(result => { originalSettled = true; return result })
  try {
    await enteredClaim
    expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'deferred', reason: 'outbox_in_flight' })
    expect(await handler.handle({ outboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, new AbortController().signal)).toEqual({ state: 'deferred', reason: 'capacity_busy' })
    expect({ calls, sends, originalSettled }).toEqual({ calls: 1, sends: 0, originalSettled: false })
    release()
    expect(await original).toEqual({ state: 'deferred', reason: 'claim_unresolved' })
    expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'effect_unknown' })
    expect({ calls, sends }).toEqual({ calls: 2, sends: 1 })
  } finally { release(); await original; await handler.stop() }
})
test('already-aborted parents cancel before claim, while live parents see local stopping as a deferral', async () => {
  const f = fixture()
  let calls = 0
  f.store.claimDelivery = async () => { calls++; return f.claim }
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { throw new Error('Must not send') } })
  const cancelled = new AbortController(); cancelled.abort()
  expect(await handler.handle({ outboxId: id }, cancelled.signal)).toEqual({ state: 'cancelled' })
  await handler.stop()
  expect(await handler.handle({ outboxId: id }, cancelled.signal)).toEqual({ state: 'cancelled' })
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'deferred', reason: 'worker_stopping' })
  expect(calls).toBe(0)
})
test.each(['false', 'throw'] as const)('post-transport finalization %s stays uncertain rather than becoming a claim deferral', async failure => {
  const f = fixture()
  f.store.finalizeDelivery = async () => { if (failure === 'throw') throw new Error('private finalization error'); return false }
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { return { state: 'effect_unknown' } } })
  expect(await handler.handle({ outboxId: id }, new AbortController().signal)).toEqual({ state: 'effect_unknown' })
  await handler.stop()
})
test('cancellation during a retained rejected claim preserves uncertainty and waits for the real receipt', async () => {
  const f = fixture()
  const parent = new AbortController()
  let release!: () => void, entered!: () => void, stopped = false
  const enteredClaim = new Promise<void>(resolve => { entered = resolve })
  f.store.claimDelivery = async () => { entered(); await new Promise<void>(resolve => { release = resolve }); throw new Error('private acquisition failure') }
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { throw new Error('Must not send') } })
  const pending = handler.handle({ outboxId: id }, parent.signal)
  await enteredClaim
  parent.abort()
  const stopping = handler.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  release()
  expect(await pending).toEqual({ state: 'effect_unknown' })
  await stopping; expect(stopped).toBe(true)
})
test.each(['response_200', 'duplicate_409'] as const)('unconfirmed finalization retains only captured %s queued evidence', async evidence => {
  const f = fixture(), parent = new AbortController()
  const emailId = evidence === 'response_200' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : null
  f.store.finalizeDelivery = async () => { throw new Error('private finalize failure') }
  const handler = createAuthMailHandler(f.store, f.codec, { async send() { parent.abort(); return { state: 'plunk_queued', evidence, emailId } } })
  expect(await handler.handle({ outboxId: id }, parent.signal)).toEqual({ state: 'effect_unknown', queuedEvidence: evidence, emailId })
  await handler.stop()
})
