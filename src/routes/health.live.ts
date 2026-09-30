import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/health/live')({
  server: { handlers: {
    GET: () => new Response('ok'),
    HEAD: () => new Response(null),
    ANY: () => new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }),
  } },
})
