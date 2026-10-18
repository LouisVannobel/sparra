import Stripe from 'stripe'
import tls, { type TLSSocket } from 'node:tls'
import { Redacted } from 'effect'
import { Agent, fetch as nativeFetch, type buildConnector } from 'undici'
import type { StripeConfig } from './stripe-config.server'
export class StripeInputError extends Error {
  constructor() { super('Stripe billing input rejected'); this.name = 'StripeInputError' }
}
export class StripeProviderError extends Error {
  constructor() { super('Stripe provider outcome unknown'); this.name = 'StripeProviderError' }
}

// Own complete SDK calls, including FetchHttpClient.toJSON, rather than only
// the fetch promise that resolves as soon as response headers arrive.
export function createStripeTransport(config: StripeConfig, signal: AbortSignal, deadlineAtMs: number) {
  if (!Number.isSafeInteger(deadlineAtMs) || !(signal instanceof AbortSignal)) throw new StripeInputError()
  const deadline = Math.min(deadlineAtMs, Date.now() + 30000)
  const stop = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const originals = new Set<Promise<unknown>>()
  const sockets = new Map<TLSSocket, Promise<void>>()
  const requestSignals = new Set<AbortSignal>()
  let stopped = false, cleanupFailed = false
  let destroying: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  // Agent.destroy does not join a connector still awaiting secureConnect.
  // Own the public TLSSocket from its creation, before that callback exists.
  const connect: buildConnector.connector = (options, callback) => {
    const remaining = Math.min(10000, deadline - Date.now())
    if (stopped || signal.aborted || remaining <= 0 || options.hostname !== 'api.stripe.com'
      || options.protocol !== 'https:' || options.port !== '' && options.port !== '443'
      || options.httpSocket !== undefined) {
      callback(new StripeProviderError(), null)
      return
    }
    let socket: TLSSocket
    try {
      socket = tls.connect({ host: 'api.stripe.com', port: 443, servername: 'api.stripe.com', ALPNProtocols: ['http/1.1'] })
    } catch {
      callback(new StripeProviderError(), null)
      return
    }
    let reported = false
    const connectTimer = setTimeout(() => socket.destroy(new StripeProviderError()), remaining)
    const failed = () => {
      clearTimeout(connectTimer)
      if (!reported) { reported = true; callback(new StripeProviderError(), null) }
    }
    sockets.set(socket, new Promise<void>(resolve => {
      socket.once('close', () => {
        failed()
        sockets.delete(socket)
        resolve()
      })
    }))
    socket.setNoDelay(true)
    socket.on('error', failed)
    socket.once('secureConnect', () => {
      clearTimeout(connectTimer)
      if (stopped || signal.aborted || Date.now() >= deadline) {
        socket.destroy(new StripeProviderError())
        failed()
      } else if (!reported) {
        reported = true
        callback(null, socket)
      }
    })
  }
  const dispatcher = new Agent({ connections: 1, pipelining: 1, connect })

  function stopTransport(): Promise<void> {
    if (!destroying) {
      stopped = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      for (const requestSignal of requestSignals) requestSignal.removeEventListener('abort', cancel)
      requestSignals.clear()
      stop.abort(new StripeProviderError())
      const closingSockets = [...sockets]
      for (const [socket] of closingSockets) socket.destroy(new StripeProviderError())
      destroying = Promise.all([
        dispatcher.destroy().catch(() => { cleanupFailed = true }),
        ...closingSockets.map(([, closed]) => closed),
      ]).then(() => {})
    }
    return destroying
  }
  function cancel(): void { if (!stopped) void stopTransport() }
  signal.addEventListener('abort', cancel, { once: true })
  timer = setTimeout(cancel, Math.max(0, deadline - Date.now()))
  if (signal.aborted || deadline <= Date.now()) cancel()

  const ownedFetch: typeof fetch = async (input, init) => {
    try {
      if (stopped || signal.aborted || Date.now() >= deadline
        || typeof input !== 'string' && !(input instanceof URL)) throw new StripeProviderError()
      const url = new URL(input)
      const read = init?.method === 'GET' && init.body == null
      const write = init?.method === 'POST' && (url.pathname === '/v1/customers'
        || url.pathname === '/v1/checkout/sessions' || /^\/v1\/subscriptions\/sub_[A-Za-z0-9]+$/.test(url.pathname))
      const headers = new Headers(init?.headers)
      if (url.origin !== 'https://api.stripe.com' || url.username || url.password
        || !read && !write || init?.body != null && typeof init.body !== 'string'
        || headers.has('stripe-account') || headers.has('stripe-context')) throw new StripeProviderError()
      const requestSignal = AbortSignal.any([stop.signal, signal, ...(init.signal ? [init.signal] : [])])
      // Headers do not complete the SDK body. Keep this bridge owned until
      // client stop, even when fetch has already returned its Response.
      requestSignals.add(requestSignal)
      requestSignal.addEventListener('abort', cancel, { once: true })
      if (requestSignal.aborted) { cancel(); throw new StripeProviderError() }
      const response = await nativeFetch(url, { method: init.method, headers: [...headers], body: init.body,
        signal: requestSignal, redirect: 'error', dispatcher })
      // Stripe23 types require the platform Response. Undici7's header/body
      // types differ, so bridge its stream with backpressure and cancellation;
      // the SDK still owns its native JSON parser and complete body read.
      const reader = response.body?.getReader()
      const body = reader ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) { reader.releaseLock(); controller.close() }
            else controller.enqueue(chunk.value)
          } catch { reader.releaseLock(); throw new StripeProviderError() }
        },
        async cancel() { try { await reader.cancel() } finally { reader.releaseLock() } },
      }, { highWaterMark: 0 }) : null
      return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] })
    } catch {
      // Do not let native ECONNRESET/EPIPE trigger Stripe's special first retry.
      throw new StripeProviderError()
    }
  }
  const stripe = new Stripe(Redacted.value(config.apiKey), {
    apiVersion: '2026-09-30.endive', maxNetworkRetries: 0,
    timeout: 10000, telemetry: false, emitEventBodies: false,
    httpClient: Stripe.createFetchHttpClient(ownedFetch),
  })
  let accountVerified: Promise<void> | undefined
  function verifyOwnAccount(): Promise<void> {
    return accountVerified ??= (async () => {
      const account = await stripe.accounts.retrieveCurrent()
      if (account.object !== 'account' || account.id !== config.accountId) throw new StripeProviderError()
    })()
  }

  function owned<T>(work: () => Promise<T>): Promise<T> {
    if (stopped || signal.aborted || Date.now() >= deadline) {
      return close().then(() => { throw new StripeProviderError() })
    }
    const task = (async () => {
      let original: Promise<T> | undefined
      try {
        original = (async () => {
          await verifyOwnAccount()
          if (stopped || signal.aborted || Date.now() >= deadline) throw new StripeProviderError()
          return work()
        })()
        originals.add(original)
        const result = await original
        if (stopped || signal.aborted || Date.now() >= deadline) throw new StripeProviderError()
        return result
      } catch {
        await stopTransport()
        await Promise.allSettled(originals)
        throw new StripeProviderError()
      } finally { if (original) originals.delete(original) }
    })()
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  function close(): Promise<void> {
    return closing ??= (async () => {
      const destroyed = stopTransport()
      await Promise.allSettled(pending)
      await destroyed
      if (cleanupFailed) throw new StripeProviderError()
    })()
  }
  return Object.freeze({ stripe, owned, close })
}
