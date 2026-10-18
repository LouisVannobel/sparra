import { describe, expect, it, vi } from 'vitest'
import { createTransactions } from '../../src/platform/db/transactions.server'

describe('consumer billing import closure', () => {
  it('loads all nineteen consumer billing modules without a provider or external checkout', async () => {
    const modules = [
      import('../../src/modules/billing/billing-agreement.server'),
      import('../../src/modules/billing/billing-hatchet.server'),
      import('../../src/modules/billing/billing-relay.server'),
      import('../../src/modules/billing/billing.functions'),
      import('../../src/modules/billing/billing.server'),
      import('../../src/modules/billing/cancellation.server'),
      import('../../src/modules/billing/checkout.server'),
      import('../../src/modules/billing/events.server'),
      import('../../src/modules/billing/lineage.server'),
      import('../../src/modules/billing/reconcile.server'),
      import('../../src/modules/billing/schema.server'),
      import('../../src/modules/billing/store.server'),
      import('../../src/modules/billing/stripe-config.server'),
      import('../../src/modules/billing/stripe-read.server'),
      import('../../src/modules/billing/stripe-webhook.server'),
      import('../../src/modules/billing/stripe.server'),
      import('../../src/modules/billing/webhook-body.server'),
      import('../../src/modules/billing/webhook.server'),
      import('../../src/modules/billing/worker.server'),
    ]
    const loaded = await Promise.allSettled(modules)
    expect(loaded.filter(result => result.status === 'rejected')).toEqual([])
  })

  it('loads the native service with no Stripe configuration and refuses all effects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider I/O') })
    try {
      const loaded = await import('../../src/modules/billing/billing.server').then(module => ({ module, error: null }), error => ({ module: null, error }))
      expect(loaded.error, 'the native consumer billing module must be importable').toBeNull()
      const owner = createTransactions({ async connect() { throw new Error('Unexpected database checkout') } }, { maxStatementTimeoutMs: 100, maxCleanupTimeoutMs: 100 })
      const billing = loaded.module!.createApplicationBilling(owner, null, null)
      const request = new Request('https://sparra.example/billing')
      await expect(billing.startBillingCheckout(request, { workspaceId: '7caecda8-3e29-4d99-a33e-5d345bba8d07' })).rejects.toMatchObject({ status: 503 })
      await expect(billing.readBilling(request, { workspaceId: '7caecda8-3e29-4d99-a33e-5d345bba8d07' })).rejects.toMatchObject({ status: 503 })
      expect((await billing.receiveBillingWebhook(request)).status).toBe(503)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { fetchSpy.mockRestore() }
  })

  it('treats an absent Stripe configuration as unavailable and rejects partial configuration', async () => {
    const loaded = await import('../../src/modules/billing/stripe-config.server').then(module => ({ module, error: null }), error => ({ module: null, error }))
    expect(loaded.error, 'the native consumer Stripe configuration must be importable').toBeNull()
    expect(loaded.module!.readStripeConfig({})).toBeNull()
    expect(() => loaded.module!.readStripeConfig({ STRIPE_ACCOUNT_ID: 'acct_fixture' })).toThrow()
  })
})
