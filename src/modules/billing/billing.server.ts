import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { createApplicationAuth } from '../auth/auth.server'
import type { StripeConfig } from './stripe-config.server'
import { createStripeBillingClient } from './stripe.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { assertExactBillingOrigin, parseBillingInput, readBillingState, startCheckout } from './checkout.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import { createBillingStore } from './store.server'
import { receiveBillingWebhook } from './webhook.server'
import { cancelAtPeriodEnd } from './cancellation.server'

export function createApplicationBilling(owner: AuthTransactions, auth: Pick<ReturnType<typeof createApplicationAuth>, 'requirePrincipal'> | null,
  config: StripeConfig | null) {
  const store = createBillingStore(owner)
  const active = new Set<{ cancel: AbortController; promise: Promise<unknown> }>()
  let stopping = false, cleanupFailed = false
  let stopped: Promise<void> | undefined
  function track<A>(cancel: AbortController, promise: Promise<A>): Promise<A> {
    const entry = { cancel, promise }
    active.add(entry)
    void promise.then(() => active.delete(entry), () => active.delete(entry))
    return promise
  }
  async function safe<A>(work: () => Promise<A>): Promise<A> {
    try { return await work() }
    catch (error) {
      if (error instanceof Response) throw error
      throw new Response('Billing unavailable', { status: 503 })
    }
  }
  function financial<A>(request: Request, input: unknown, use: (config: StripeConfig, principal: AdmittedPrincipal,
    client: ReturnType<typeof createStripeBillingClient>, workspaceId: string, signal: AbortSignal) => Promise<A>): Promise<A> {
    if (stopping || cleanupFailed) return Promise.reject(new Response('Billing unavailable', { status: 503 }))
    const deadlineAtMs = requestAuthDeadlineAtMs(request), cancel = new AbortController()
    const abort = () => cancel.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, Math.max(0, deadlineAtMs - Date.now()))
    if (request.signal.aborted) abort()
    let client: ReturnType<typeof createStripeBillingClient> | undefined
    const check = () => { if (stopping || cleanupFailed || cancel.signal.aborted || Date.now() >= deadlineAtMs) throw new Response('Billing unavailable', { status: 503 }) }
    const promise = (async () => {
      try {
        check()
        if (!auth || !config) throw new Response('Billing unavailable', { status: 503 })
        const principal = await auth.requirePrincipal(request)
        check()
        const { workspaceId } = parseBillingInput(input)
        assertExactBillingOrigin(request, config)
        client = createStripeBillingClient(config, cancel.signal, deadlineAtMs)
        return await use(config, principal, client, workspaceId, cancel.signal)
      } finally {
        clearTimeout(timer); request.signal.removeEventListener('abort', abort)
        try { await client?.close() }
        catch {
          cleanupFailed = true
          for (const entry of active) entry.cancel.abort()
          throw new Response('Billing unavailable', { status: 503 })
        }
      }
    })()
    return track(cancel, promise)
  }
  function stop(): Promise<void> {
    stopping = true
    for (const entry of active) entry.cancel.abort()
    return stopped ??= (async () => {
      await Promise.allSettled([...active].map(entry => entry.promise))
      if (cleanupFailed) throw new Error('Billing transport cleanup unproven')
    })()
  }
  return Object.freeze({
    stop,
    receiveBillingWebhook(request: Request): Promise<Response> {
      if (stopping) return Promise.resolve(new Response('Billing unavailable', { status: 503 }))
      const cancel = new AbortController(), abort = () => cancel.abort()
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      const promise = (async () => {
        try {
          const deadline = requestAuthDeadlineAtMs(request)
          if (!config) return new Response('Billing unavailable', { status: 503 })
          return await receiveBillingWebhook(config, store, request, deadline, cancel.signal)
        } catch { return new Response('Billing unavailable', { status: 503 }) }
        finally { request.signal.removeEventListener('abort', abort) }
      })()
      return track(cancel, promise)
    },
    startBillingCheckout(request: Request, input: unknown): Promise<{ url: string }> {
      return safe(() => financial(request, input, (selected, principal, client, workspaceId, signal) =>
        startCheckout(owner, principal, selected, client, workspaceId, signal)))
    },
    cancelBillingAtPeriodEnd(request: Request, input: unknown): Promise<Readonly<{ state: 'confirmed' }>> {
      return safe(() => financial(request, input, (selected, principal, client, workspaceId, signal) =>
        cancelAtPeriodEnd(owner, principal, selected, client, workspaceId, signal)))
    },
    readBilling(request: Request, input: unknown) {
      return safe(async () => {
        if (!auth) throw new Response('Billing unavailable', { status: 503 })
        const principal = await auth.requirePrincipal(request)
        const { workspaceId } = parseBillingInput(input)
        return readBillingState(owner, principal, config, workspaceId, request.signal)
      })
    },
  })
}
