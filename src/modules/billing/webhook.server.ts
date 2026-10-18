import type { StripeConfig } from './stripe-config.server'
import type { BillingStore } from './store.server'
import { readStripeWebhook } from './webhook-body.server'

export async function receiveBillingWebhook(config: StripeConfig, store: BillingStore,
  request: Request, deadlineAtMs: number, ownerSignal: AbortSignal = request.signal): Promise<Response> {
  const deadline = Math.min(deadlineAtMs, Date.now() + 10000)
  const cancellation = new AbortController()
  const signal = AbortSignal.any([request.signal, ownerSignal])
  const abort = () => cancellation.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
  try {
    const event = await readStripeWebhook(config, request, deadline, cancellation.signal)
    if (cancellation.signal.aborted || Date.now() >= deadline) throw new Error('Billing ingress unavailable')
    const result = await store.receive(event, cancellation.signal)
    if (cancellation.signal.aborted || Date.now() >= deadline || result === 'unassigned-risk') {
      return new Response('Billing unavailable', { status: 503 })
    }
    return new Response(null, { status: 204 })
  } catch { return new Response('Billing unavailable', { status: 503 }) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}
