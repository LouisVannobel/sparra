import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'

export const Route = createFileRoute('/health/ready')({
  server: { handlers: {
    GET: ({ request }) => {
      const ready = requestResources(request).isReady()
      return new Response(ready ? 'ok' : 'Service Unavailable', { status: ready ? 200 : 503 })
    },
    HEAD: ({ request }) => new Response(null, { status: requestResources(request).isReady() ? 200 : 503 }),
    ANY: () => new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }),
  } },
})
