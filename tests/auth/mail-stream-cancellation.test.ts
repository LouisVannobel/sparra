import { expect, test, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createChannel, createClientFactory, createServer, ServerError, Status, type CallContext, type ClientMiddleware } from 'nice-grpc'
import { DispatcherDefinition } from '@hatchet-dev/typescript-sdk/protoc/dispatcher/dispatcher.js'
import { addTokenMiddleware } from '@hatchet-dev/typescript-sdk/util/grpc-helpers.js'
import { ownAuthMailListeners } from '../../src/modules/auth/mail-hatchet.server'

const definition = { ...DispatcherDefinition, methods: { listen: DispatcherDefinition.methods.listen, listenV2: DispatcherDefinition.methods.listenV2 } }
const request = { workerId: 'owned' }
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }

async function fixture(serve: (context: CallContext) => AsyncGenerator<{}, void, unknown>, middleware?: ClientMiddleware) {
  const server = createServer()
  server.add(definition, { listen: (_, context) => serve(context), listenV2: (_, context) => serve(context) })
  const port = await server.listen('127.0.0.1:0')
  const channel = createChannel(`127.0.0.1:${port}`)
  let factory = createClientFactory().use(addTokenMiddleware('synthetic'))
  if (middleware) factory = factory.use(middleware)
  const client = factory.create(definition, channel)
  return { channel, client, cleanup: async () => { channel.close(); await server.shutdown() } }
}

test('test transport resolves the exact package consumed by the SDK', () => {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@hatchet-dev/typescript-sdk'))
  expect(require.resolve('nice-grpc')).toBe(sdkRequire.resolve('nice-grpc'))
})

test('already aborted transport opens no RPC after actual token middleware', async () => {
  const f = await fixture(async function* () { yield {} })
  const calls = vi.spyOn(f.channel, 'createCall')
  const owner = new AbortController(); owner.abort()
  try {
    await expect(f.client.listen(request, { signal: owner.signal })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

test('abort during real call setup cancels the already-created call before abort escapes', async () => {
  const f = await fixture(async function* () { yield {} })
  const owner = new AbortController(), original = f.channel.createCall.bind(f.channel)
  let cancels = 0
  vi.spyOn(f.channel, 'createCall').mockImplementation((...args) => {
    const call = original(...args), cancel = call.cancelWithStatus.bind(call)
    vi.spyOn(call, 'cancelWithStatus').mockImplementation((...cancelArgs) => { cancels++; return cancel(...cancelArgs) })
    owner.abort()
    return call
  })
  try {
    const iterator = f.client.listen(request, { signal: owner.signal })[Symbol.asyncIterator]()
    const result = await iterator.next().then(() => 'message', e => e.name)
    await iterator.return?.().catch(() => {})
    expect({ result, cancelled: cancels > 0 }).toEqual({ result: 'AbortError', cancelled: true })
  } finally { await f.cleanup() }
})

test('abort while real middleware delegation is held prevents RPC setup', async () => {
  const entered = barrier(), release = barrier()
  const middleware: ClientMiddleware = async function* (call, options) { entered.release(); await release.promise; return yield* call.next(call.request, options) }
  const f = await fixture(async function* () { yield {} }, middleware)
  const calls = vi.spyOn(f.channel, 'createCall'), owner = new AbortController()
  ownAuthMailListeners(f.client, owner.signal)
  try {
    const next = f.client.listen(request, { signal: owner.signal })[Symbol.asyncIterator]().next()
    await entered.promise; owner.abort(); release.release()
    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).not.toHaveBeenCalled()
  } finally { release.release(); await f.cleanup() }
})

test.each(['listen', 'listenV2'] as const)('owned %s joins active SDK and owner cancellations independently with original authentication and callbacks', async method => {
  for (const cancellation of ['sdk', 'owner'] as const) {
    const closed = barrier(), entered = barrier(), owner = new AbortController(), sdk = new AbortController()
    let authorized = false, requestPreserved = false
    const f = await fixture(async function* (context) {
      authorized = context.metadata.get('authorization') === 'bearer synthetic'
      try {
        yield {}; entered.release()
        await new Promise<void>(r => {
          context.signal.addEventListener('abort', () => r(), { once: true })
          if (context.signal.aborted) r()
        })
      } finally { closed.release() }
    }, async function* (call, options) {
      requestPreserved = !call.requestStream && call.request === request
      return yield* call.next(call.request, options)
    })
    ownAuthMailListeners(f.client, owner.signal)
    const headers = vi.fn()
    const iterator = f.client[method](request, { signal: sdk.signal, onHeader: headers })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).done).toBe(false)
      await entered.promise
      const next = iterator.next()
      const outcome = next.then(() => 'unexpected', e => e.name)
      ;(cancellation === 'sdk' ? sdk : owner).abort()
      expect(await outcome).toBe('AbortError')
      await closed.promise
      expect({ authorized, requestPreserved, headers: headers.mock.calls.length }).toEqual({ authorized: true, requestPreserved: true, headers: 1 })
      expect((await iterator.next()).done).toBe(true)
    } finally { owner.abort(); sdk.abort(); await iterator.return?.().catch(() => {}); await f.cleanup() }
  }
})

test('ordinary stream errors keep their status and iterator return joins server cleanup', async () => {
  const f = await fixture(async function* () { throw new ServerError(Status.FAILED_PRECONDITION, 'synthetic'); yield {} })
  ownAuthMailListeners(f.client, new AbortController().signal)
  try { await expect(f.client.listen(request)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Status.FAILED_PRECONDITION }) }
  finally { await f.cleanup() }
  const closed = barrier()
  const g = await fixture(async function* (context) {
    try { yield {}; await new Promise<void>(r => context.signal.addEventListener('abort', () => r(), { once: true })) }
    finally { closed.release() }
  })
  ownAuthMailListeners(g.client, new AbortController().signal)
  try {
    const iterator = g.client.listen(request)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.(); await closed.promise
  } finally { await g.cleanup() }
})
