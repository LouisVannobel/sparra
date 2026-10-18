import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'

export const Route = createFileRoute('/webhooks/stripe')({ server: { handlers: { POST: ({ request }) => {
  const billing = requestResources(request).billing
  return billing ? billing.receiveBillingWebhook(request) : new Response('Billing unavailable', { status: 503 })
} } } })
