import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'
import { googleAccountCallbackResponse } from '../modules/auth/http-boundary.server'

export const Route = createFileRoute('/api/auth/account/google/callback')({ server: { handlers: { GET: ({ request }) => {
  const resources = requestResources(request)
  return resources.auth ? googleAccountCallbackResponse(request, resources.auth, resources.limiter)
    : new Response('Service Unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
} } } })
