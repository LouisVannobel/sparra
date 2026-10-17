import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { createApplicationAuth } from '../auth/auth.server'
import type { StripeConfig } from './stripe-config.server'
import type { createStripeBillingClient } from './stripe.server'
import { assertExactBillingOrigin, parseBillingInput, readBillingState, startCheckout } from './checkout.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import { createBillingStore } from './store.server'
import { receiveBillingWebhook } from './webhook.server'
import { cancelAtPeriodEnd } from './cancellation.server'

export function createApplicationBilling(owner: AuthTransactions, auth: ReturnType<typeof createApplicationAuth> | null,
  config: StripeConfig | null, client: ReturnType<typeof createStripeBillingClient> | null) {
  const store = createBillingStore(owner)
  async function safe<A>(work: () => Promise<A>): Promise<A> {
    try { return await work() }
    catch (error) {
      if (error instanceof Response) throw error
      throw new Response('Billing unavailable', { status: 503 })
    }
  }
  return Object.freeze({
    async receiveBillingWebhook(request: Request): Promise<Response> {
      try {
        const deadline = requestAuthDeadlineAtMs(request)
        if (!config) return new Response('Billing unavailable', { status: 503 })
        return await receiveBillingWebhook(config, store, request, deadline)
      } catch { return new Response('Billing unavailable', { status: 503 }) }
    },
    startBillingCheckout(request: Request, input: unknown): Promise<{ url: string }> {
      return safe(async () => {
        if (!auth) throw new Response('Billing unavailable', { status: 503 })
        const principal = await auth.requirePrincipal(request)
        const { workspaceId } = parseBillingInput(input)
        if (!config || !client) throw new Response('Billing unavailable', { status: 503 })
        assertExactBillingOrigin(request, config)
        return startCheckout(owner, principal, config, client, workspaceId, request.signal)
      })
    },
    cancelBillingAtPeriodEnd(request: Request, input: unknown): Promise<Readonly<{ state: 'confirmed' }>> {
      return safe(async () => {
        if (!auth) throw new Response('Billing unavailable', { status: 503 })
        const principal = await auth.requirePrincipal(request)
        const { workspaceId } = parseBillingInput(input)
        if (!config || !client) throw new Response('Billing unavailable', { status: 503 })
        assertExactBillingOrigin(request, config)
        return cancelAtPeriodEnd(owner, principal, config, client, workspaceId, request.signal)
      })
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
