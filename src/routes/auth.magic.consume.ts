import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'
import { magicConsumeResponse } from '../modules/auth/http-boundary.server'

export const Route = createFileRoute('/auth/magic/consume')({ server: { handlers: { POST: async ({ request }) => {
  const { auth, limiter } = requestResources(request)
  if (!auth) return new Response('Service Unavailable', { status: 503 })
  let input: unknown
  try { input = await request.json() } catch { input = undefined }
  return magicConsumeResponse(request, input, auth, limiter)
} } } })
