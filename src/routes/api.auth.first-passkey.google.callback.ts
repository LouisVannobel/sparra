import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'
import { firstGooglePasskeyCallbackResponse } from '../modules/auth/http-boundary.server'

export const Route = createFileRoute('/api/auth/first-passkey/google/callback')({ server: { handlers: { GET: ({ request }) => {
  const resources = requestResources(request)
  return resources.auth ? firstGooglePasskeyCallbackResponse(request, resources.auth, resources.limiter)
    : new Response('Service Unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
} } } })
