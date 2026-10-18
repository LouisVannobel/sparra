import { expect, test, vi } from 'vitest'
import { InternalWorker } from '@hatchet-dev/typescript-sdk/v1/client/worker/worker-internal.js'
import type { CallOptions } from 'nice-grpc'

function barrier() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type CleanupContext = {
  ownedLifecycle: {
    workerId: string | undefined; cleanupDeadlineAt: number; assertCleanup(): void; record(error: unknown): void
    unary(invoke: (options: CallOptions) => Promise<void>, phase: 'cleanup'): Promise<void>
  }
  _requestOwnedStop(): void
  client: {
    workers: { pause(workerId: string): Promise<void> }
    dispatcher: {
      _waitForOwnedCleanupReady(deadline: Date): Promise<void>
      client: { unsubscribe(input: { workerId: string }, options: CallOptions): Promise<void> }
    }
  }
  listener: { unregister(): Promise<void> } | undefined
  healthServer: { stop(): Promise<void> }
}
function fixture() {
  const ready = barrier(), errors: unknown[] = []
  const wait = vi.fn<CleanupContext['client']['dispatcher']['_waitForOwnedCleanupReady']>(() => ready.promise)
  const unregister = vi.fn<() => Promise<void>>(async () => {})
  const unsubscribe = vi.fn<CleanupContext['client']['dispatcher']['client']['unsubscribe']>(async () => {})
  const pause = vi.fn<(workerId: string) => Promise<void>>(async () => {})
  const health = vi.fn<() => Promise<void>>(async () => {})
  const assertCleanup = vi.fn<() => void>()
  const unary = vi.fn<CleanupContext['ownedLifecycle']['unary']>((invoke, _phase) => invoke({}))
  const context: CleanupContext = {
    ownedLifecycle: { workerId: 'worker-fixture', cleanupDeadlineAt: Date.now() + 15000, assertCleanup, record: error => { errors.push(error) }, unary },
    _requestOwnedStop: vi.fn(), client: { workers: { pause }, dispatcher: { _waitForOwnedCleanupReady: wait, client: { unsubscribe } } },
    listener: { unregister }, healthServer: { stop: health },
  }
  return { context, ready, wait, unregister, unsubscribe, pause, health, assertCleanup, unary, errors,
    run: () => InternalWorker.prototype._cleanupOwned.call(context) }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

// Exercise the installed cleanup method, with controlled boundary promises.
// These units do not qualify a native channel/watch, constructor or SQL drain.
test('held readiness blocks unsubscribe while pause and health still progress', async () => {
  const f = fixture(), cleanup = f.run()
  let settled = false; void cleanup.then(() => { settled = true })
  try {
    await turn()
    expect(f.unregister).not.toHaveBeenCalled()
    expect(f.wait).toHaveBeenCalledExactlyOnceWith(new Date(f.context.ownedLifecycle.cleanupDeadlineAt))
    expect(f.pause).toHaveBeenCalledExactlyOnceWith('worker-fixture'); expect(f.health).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    f.ready.resolve(); await cleanup
    expect(f.unregister).toHaveBeenCalledOnce(); expect(f.unsubscribe).not.toHaveBeenCalled(); expect(f.errors).toEqual([])
  } finally { f.ready.resolve(); await cleanup }
})

test('listener-free cleanup uses the same absolute readiness deadline before its one cleanup unary', async () => {
  const f = fixture(); f.context.listener = undefined
  const cleanup = f.run()
  try {
    await turn(); expect(f.unsubscribe).not.toHaveBeenCalled(); expect(f.unary).not.toHaveBeenCalled()
    expect(f.wait.mock.calls[0][0].getTime()).toBe(f.context.ownedLifecycle.cleanupDeadlineAt)
    f.ready.resolve(); await cleanup
    expect(f.unary).toHaveBeenCalledOnce(); expect(f.unary.mock.calls[0][1]).toBe('cleanup')
    expect(f.unsubscribe).toHaveBeenCalledExactlyOnceWith({ workerId: 'worker-fixture' }, {})
    expect(f.errors).toEqual([])
  } finally { f.ready.resolve(); await cleanup }
})

test('readiness rejection is recorded without unsubscribe and does not bypass other cleanup joins', async () => {
  const f = fixture(), pause = barrier(), health = barrier(), failure = new Error('synthetic watcher refusal')
  f.pause.mockReturnValue(pause.promise); f.health.mockReturnValue(health.promise)
  const cleanup = f.run()
  let settled = false; void cleanup.then(() => { settled = true })
  try {
    await turn(); f.ready.reject(failure); await turn()
    expect(settled).toBe(false); expect(f.unregister).not.toHaveBeenCalled(); expect(f.unsubscribe).not.toHaveBeenCalled()
    pause.resolve(); await turn(); expect(settled).toBe(false)
    health.resolve(); await cleanup
    expect(f.errors).toEqual([failure])
  } finally { f.ready.resolve(); pause.resolve(); health.resolve(); await cleanup }
})

test('an owner refusal after readiness prevents a late unsubscribe and remains recorded', async () => {
  const f = fixture(), failure = new Error('synthetic expired cleanup owner')
  const cleanup = f.run()
  try {
    await turn(); expect(f.assertCleanup).toHaveBeenCalledOnce()
    f.assertCleanup.mockImplementation(() => { throw failure })
    f.ready.resolve(); await cleanup
    expect(f.assertCleanup).toHaveBeenCalledTimes(2); expect(f.unregister).not.toHaveBeenCalled(); expect(f.unsubscribe).not.toHaveBeenCalled()
    expect(f.errors).toEqual([failure])
  } finally { f.ready.resolve(); await cleanup }
})

test('an already-refused cleanup owner creates neither readiness work nor unsubscribe', async () => {
  const f = fixture(), failure = new Error('synthetic owner already closed')
  f.assertCleanup.mockImplementation(() => { throw failure })
  await f.run()
  expect(f.wait).not.toHaveBeenCalled(); expect(f.unregister).not.toHaveBeenCalled(); expect(f.unsubscribe).not.toHaveBeenCalled()
  expect(f.pause).toHaveBeenCalledOnce(); expect(f.health).toHaveBeenCalledOnce(); expect(f.errors).toEqual([failure])
})

test('ordinary unsubscribe rejection after readiness is retained instead of becoming cleanup success', async () => {
  const f = fixture(), failure = new Error('synthetic ordinary RPC refusal')
  f.unregister.mockRejectedValue(failure)
  const cleanup = f.run()
  try {
    await turn(); f.ready.resolve(); await cleanup
    expect(f.unregister).toHaveBeenCalledOnce(); expect(f.errors).toEqual([failure])
  } finally { f.ready.resolve(); await cleanup }
})

test('acquisition without a worker identity does not wait or unsubscribe', async () => {
  const f = fixture(); f.context.ownedLifecycle.workerId = undefined
  await f.run()
  expect(f.wait).not.toHaveBeenCalled(); expect(f.unregister).not.toHaveBeenCalled(); expect(f.unsubscribe).not.toHaveBeenCalled()
  expect(f.pause).not.toHaveBeenCalled(); expect(f.health).toHaveBeenCalledOnce(); expect(f.errors).toEqual([])
})
