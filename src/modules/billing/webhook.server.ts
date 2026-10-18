import type { StripeConfig } from './stripe-config.server'
import type { BillingStore } from './store.server'
import { readStripeWebhook } from './webhook-body.server'

export async function receiveBillingWebhook(config: StripeConfig, store: BillingStore,
  request: Request, deadlineAtMs: number): Promise<Response> {
  const deadline = Math.min(deadlineAtMs, Date.now() + 10000)
  const cancellation = new AbortController()
  const abort = () => cancellation.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
  try {
    const event = await readStripeWebhook(config, request, deadline)
    if (cancellation.signal.aborted || Date.now() >= deadline) throw new Error('Billing ingress unavailable')
    const result = await store.receive(event, cancellation.signal)
    if (cancellation.signal.aborted || Date.now() >= deadline || result === 'unassigned-risk') {
      return new Response('Billing unavailable', { status: 503 })
    }
    return new Response(null, { status: 204 })
  } catch { return new Response('Billing unavailable', { status: 503 }) }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort) }
}
