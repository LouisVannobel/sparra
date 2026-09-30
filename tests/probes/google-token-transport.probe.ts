// Opt-in, disposable Gate 1 experiment. Never imported by application code.
// Run after pnpm typecheck: node --test --test-concurrency=1 tests/probes/google-token-transport.probe.ts
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Agent, buildConnector, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

const cleanupMs = 1000
type Cell = { deadlineAtMs: number; signal: AbortSignal; revoked: boolean; attempt: boolean }
const scope = new AsyncLocalStorage<Cell>()

test('Gate 1: native registry, then stop at first failed pre-connect cleanup requirement', async (t) => {
  assert.equal(process.version, 'v24.14.0')
  assert.equal(process.versions.undici, '7.21.0')
  const previous = getGlobalDispatcher()
  const originalFetch = globalThis.fetch
  const clients = new Set<Socket>()
  const peers = new Set<Socket>()
  let clientsCreated = 0
  let received = 0
  let pendingConnectors = 0
  let pendingResolvers = 0
  let delayedLookup = false
  let releaseLookup: (() => void) | undefined
  let connectorCompletedAt: number | undefined
  let clientClosedAt: number | undefined
  let resolverCompletedAt: number | undefined
  let fetchSettledAt: number | undefined
  const startedAt = performance.now()
  const elapsed = () => Number((performance.now() - startedAt).toFixed(3))
  const observeClient = (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('socket' in message)
      || !(message.socket instanceof Socket)) return
    const socket = message.socket
    clientsCreated++
    clients.add(socket)
    socket.once('close', () => { clients.delete(socket); clientClosedAt = elapsed() })
  }
  // Documented Node 24.14 diagnostic event; used only as fixture observation.
  const socketsChannel = channel('net.client.socket')
  socketsChannel.subscribe(observeClient)
  const server = createServer((request, response) => {
    received++
    request.resume()
    response.end('synthetic-response')
  })
  server.on('connection', (socket) => {
    peers.add(socket)
    socket.once('close', () => peers.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  // No DNS call: the ONLY resolver below returns this owned listener's literal loopback.
  const origin = `http://transport-probe.invalid:${address.port}`
  const nativeConnect = buildConnector({
    timeout: 1000,
    allowH2: false,
    autoSelectFamily: false,
    lookup: (hostname, _options, callback) => {
      assert.equal(hostname, 'transport-probe.invalid')
      pendingResolvers++
      const complete = () => {
        pendingResolvers--
        resolverCompletedAt = elapsed()
        callback(null, '127.0.0.1', 4)
      }
      if (delayedLookup) releaseLookup = complete
      else complete()
    },
  })
  const agent = new Agent({
    connections: 4, maxOrigins: 1, pipelining: 0, allowH2: false,
    connectTimeout: 1000, maxResponseSize: 65536,
    connect: (options, callback) => {
      assert.equal(options.hostname, 'transport-probe.invalid')
      assert.equal(options.port, String(address.port))
      assert.equal(options.protocol, 'http:')
      pendingConnectors++
      nativeConnect(options, (...args) => {
        pendingConnectors--
        connectorCompletedAt = elapsed()
        callback(...args)
      })
    },
  })
  let requests = 0
  let intercepted = 0
  let cancellations = 0
  let cancelAt: number | undefined
  let onConnectCount = 0
  let ownedInvocations = 0
  let admissionOpen = true
  const ownedCells = new Set<Cell>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const listenerDisposers = new Set<() => void>()
  class LocalRouter extends Dispatcher {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      if (String(options.origin) !== origin || options.path !== '/token' || options.method !== 'POST') {
        return previous.dispatch(options, handler)
      }
      intercepted++
      const cell = scope.getStore()
      if (!admissionOpen || !cell || cell.revoked || cell.attempt || cell.signal.aborted
        || cell.deadlineAtMs - Date.now() <= cleanupMs || ownedCells.size >= 4) {
        handler.onError?.call(handler, new Error('probe admission refused'))
        return false
      }
      assert.equal(handler.onRequestStart, undefined)
      assert.equal(typeof handler.onConnect, 'function')
      assert.equal(typeof handler.onError, 'function')
      cell.attempt = true
      ownedCells.add(cell)
      requests++
      let abort: ((error?: Error) => void) | undefined
      let cancelled = false
      let terminal = false
      const cancellationError = new Error('probe operation stopped')
      const cancel = () => {
        if (!cancelled) { cancelled = true; cancellations++; cancelAt = elapsed() }
        abort?.(cancellationError)
      }
      const live = () => {
        if (cell.revoked || cell.signal.aborted || Date.now() >= cell.deadlineAtMs - cleanupMs) cancel()
        return !cancelled
      }
      const timer = setTimeout(cancel, cell.deadlineAtMs - cleanupMs - Date.now())
      timers.add(timer)
      cell.signal.addEventListener('abort', cancel, { once: true })
      const dispose = () => cell.signal.removeEventListener('abort', cancel)
      listenerDisposers.add(dispose)
      const finish = () => {
        if (terminal) return
        terminal = true
        requests--
        clearTimeout(timer)
        timers.delete(timer)
        dispose()
        listenerDisposers.delete(dispose)
        // Deliberately retain this admission through connector/resolver/socket tails.
        // Gate 1 owns/reaps cells only after actual fixture settlement.
      }
      const wrapped: Dispatcher.DispatchHandler = {
        onConnect: (nativeAbort) => {
          onConnectCount++
          abort = nativeAbort
          if (!live()) { nativeAbort(cancellationError); return }
          return handler.onConnect?.call(handler, nativeAbort)
        },
        onError: (error) => { finish(); return handler.onError?.call(handler, error) },
        onHeaders: (...args) => live() ? (handler.onHeaders?.call(handler, ...args) ?? true) : false,
        onData: (...args) => live() ? (handler.onData?.call(handler, ...args) ?? true) : false,
        onComplete: (...args) => {
          if (!live()) return
          finish()
          return handler.onComplete?.call(handler, ...args)
        },
        onResponseStarted: () => { if (live()) return handler.onResponseStarted?.call(handler) },
        onBodySent: (...args) => { if (live()) return handler.onBodySent?.call(handler, ...args) },
        onUpgrade: (...args) => { if (live()) return handler.onUpgrade?.call(handler, ...args) },
      }
      try { return agent.dispatch(options, wrapped) }
      catch (error) { finish(); throw error }
    }
  }
  const router = new LocalRouter()
  const snapshot = () => ({
    atMs: elapsed(), requests, ownedInvocations, admissionSlots: ownedCells.size,
    pendingConnectors, pendingResolvers, clientSockets: clients.size, peerSockets: peers.size,
    clientsCreated, intercepted, received, cancellations, onConnectCount,
    cancelAt, fetchSettledAt, connectorCompletedAt, resolverCompletedAt, clientClosedAt,
  })
  const invocation = async (cell: Cell) => {
    ownedInvocations++
    try { return await scope.run(cell, async () => (await fetch(`${origin}/token`, { method: 'POST', body: 'synthetic' })).text()) }
    finally { cell.revoked = true; ownedInvocations-- }
  }
  const settleFixture = async () => {
    const until = performance.now() + 5000
    while ((pendingConnectors || pendingResolvers || clients.size || peers.size || ownedInvocations)
      && performance.now() < until) await delay(10)
    assert.equal(pendingConnectors + pendingResolvers + clients.size + peers.size + ownedInvocations, 0, 'owned fixture teardown did not settle')
  }
  setGlobalDispatcher(router)
  let pendingFetch: Promise<unknown> | undefined
  try {
    const positive: Cell = { deadlineAtMs: Date.now() + 10000, signal: new AbortController().signal, revoked: false, attempt: false }
    assert.equal(await invocation(positive), 'synthetic-response')
    await settleFixture()
    ownedCells.delete(positive)
    assert.equal(globalThis.fetch, originalFetch)
    assert.equal(intercepted, 1)
    assert.equal(received, 1)
    assert.equal(clientsCreated, 1, 'diagnostic socket observation must be operational')
    t.diagnostic(`REGISTRY_PASS ${JSON.stringify(snapshot())}`)

    delayedLookup = true
    const cell: Cell = { deadlineAtMs: Date.now() + 1200, signal: new AbortController().signal, revoked: false, attempt: false }
    const deadlineMonotonic = performance.now() + (cell.deadlineAtMs - Date.now())
    pendingFetch = invocation(cell).then(
      () => { fetchSettledAt = elapsed(); return 'fulfilled' },
      () => { fetchSettledAt = elapsed(); return 'rejected' },
    )
    // Sample at the inherited D, with C=1000 strictly inside D. This wait is
    // observation only; it never releases lookup or supplies transport cancellation.
    while (performance.now() < deadlineMonotonic) await delay(Math.max(1, deadlineMonotonic - performance.now()))
    t.diagnostic(`AT_DEADLINE ${JSON.stringify(snapshot())}`)
    assert.equal(pendingConnectors + pendingResolvers + clients.size + requests, 0,
      'FAILED GATE 1: actual pre-connect work must settle within C=1000ms inside inherited D')
  } finally {
    // Broader owned teardown only AFTER recording acceptance failure. Not normal cancellation.
    admissionOpen = false
    for (const cell of ownedCells) cell.revoked = true
    await agent.destroy()
    t.diagnostic(`AFTER_FIXTURE_AGENT_DESTROY ${JSON.stringify(snapshot())}`)
    releaseLookup?.()
    releaseLookup = undefined
    await pendingFetch
    await settleFixture()
    assert.equal(ownedInvocations, 0)
    assert.equal(getGlobalDispatcher(), router, 'foreign dispatcher replacement: refuse restoration')
    setGlobalDispatcher(previous)
    assert.equal(getGlobalDispatcher(), previous)
    assert.equal(globalThis.fetch, originalFetch)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const dispose of listenerDisposers) dispose()
    listenerDisposers.clear()
    ownedCells.clear()
    socketsChannel.unsubscribe(observeClient)
    scope.disable()
    const closed = once(server, 'close')
    server.close()
    await closed
    t.diagnostic(`OWNED_TEARDOWN_SETTLED ${JSON.stringify({ ...snapshot(), timers: timers.size, signalListeners: listenerDisposers.size, listenerClosed: !server.listening, previousRestored: getGlobalDispatcher() === previous })}`)
  }
})
