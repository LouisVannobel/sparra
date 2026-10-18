import Stripe from 'stripe'
import tls, { type TLSSocket } from 'node:tls'
import { Redacted } from 'effect'
import { Agent, type buildConnector } from 'undici'
import type { StripeConfig } from './stripe-config.server'
import { createStripeReadMethods, StripeInputError, StripeProviderError } from './stripe.server'

// Own complete SDK calls, including FetchHttpClient.toJSON, rather than only
// the fetch promise that resolves as soon as response headers arrive.
export function createStripeReadClient(config: StripeConfig, signal: AbortSignal, deadlineAtMs: number) {
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
      if (url.origin !== 'https://api.stripe.com' || url.username || url.password
        || init?.method !== 'GET' || init.body != null) throw new StripeProviderError()
      const requestSignal = AbortSignal.any([stop.signal, signal, ...(init.signal ? [init.signal] : [])])
      // Headers do not complete the SDK body. Keep this bridge owned until
      // client stop, even when fetch has already returned its Response.
      requestSignals.add(requestSignal)
      requestSignal.addEventListener('abort', cancel, { once: true })
      if (requestSignal.aborted) { cancel(); throw new StripeProviderError() }
      const options: RequestInit & { dispatcher: Agent } = { ...init, signal: requestSignal, redirect: 'error', dispatcher }
      return await fetch(url, options)
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
  const reads = createStripeReadMethods(config, stripe)

  function owned<T>(work: () => Promise<T>): Promise<T> {
    if (stopped || signal.aborted || Date.now() >= deadline) {
      return close().then(() => { throw new StripeProviderError() })
    }
    const task = (async () => {
      let original: Promise<T> | undefined
      try {
        original = work()
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
  return Object.freeze({
    retrieveInvoice: (id: string) => owned(() => reads.retrieveInvoice(id)),
    retrieveSubscription: (id: string) => owned(() => reads.retrieveSubscription(id)),
    retrievePaymentIntent: (id: string) => owned(() => reads.retrievePaymentIntent(id)),
    retrieveCharge: (id: string) => owned(() => reads.retrieveCharge(id)),
    listInvoicePayments: (id: string, cursor?: string) => owned(() => reads.listInvoicePayments(id, cursor)),
    listCustomerBalanceTransactions: (id: string, cursor?: string) => owned(() => reads.listCustomerBalanceTransactions(id, cursor)),
    retrieveCheckoutSession: (id: string) => owned(() => reads.retrieveCheckoutSession(id)),
    listCheckoutSessions: (subscriptionId: string, customerId: string, cursor?: string) => owned(() => reads.listCheckoutSessions(subscriptionId, customerId, cursor)),
    listCheckoutLineItems: (id: string, cursor?: string) => owned(() => reads.listCheckoutLineItems(id, cursor)),
    listInvoicePaymentsForPaymentIntent: (id: string, cursor?: string) => owned(() => reads.listInvoicePaymentsForPaymentIntent(id, cursor)),
    retrieveDispute: (id: string) => owned(() => reads.retrieveDispute(id)),
    listDisputes: (id: string, cursor?: string) => owned(() => reads.listDisputes(id, cursor)),
    retrieveEarlyFraudWarning: (id: string) => owned(() => reads.retrieveEarlyFraudWarning(id)),
    listEarlyFraudWarnings: (id: string, cursor?: string) => owned(() => reads.listEarlyFraudWarnings(id, cursor)),
    close,
  })
}

export type StripeReadClient = ReturnType<typeof createStripeReadClient>
