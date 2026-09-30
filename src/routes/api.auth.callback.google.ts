import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'

export const Route = createFileRoute('/api/auth/callback/google')({ server: { handlers: { GET: ({ request }) => {
  const auth = requestResources(request).auth
  return auth ? auth.callback(request) : new Response('Service Unavailable', { status: 503 })
} } } })
