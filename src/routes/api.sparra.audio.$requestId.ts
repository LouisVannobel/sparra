import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'
import { audioResponse } from '../modules/sparra/audio-reader.server'

export const Route = createFileRoute('/api/sparra/audio/$requestId')({ server: { handlers: {
  GET: ({ request, params }) => audioResponse(request, params.requestId, requestResources(request)),
  HEAD: ({ request, params }) => audioResponse(request, params.requestId, requestResources(request)),
} } })
