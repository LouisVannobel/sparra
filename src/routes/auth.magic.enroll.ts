import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'
import { magicEnrollmentResponse } from '../modules/auth/http-boundary.server'

export const Route = createFileRoute('/auth/magic/enroll')({ server: { handlers: { POST: async ({ request }) => {
  const { auth, limiter } = requestResources(request)
  if (!auth) return new Response('Service Unavailable', { status: 503 })
  // Invalid JSON still enters the named limiter exactly once; semantic parsing
  // is owned by the charged application entry.
  let input: unknown
  try { input = await request.json() } catch { input = undefined }
  return magicEnrollmentResponse(request, input, auth, limiter)
} } } })
