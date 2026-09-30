import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { requestResources } from './platform/resources.server'

// Catch application failures before Start hands them to H3's logging converter.
const errors = createMiddleware().server(async ({ next, request }) => {
  try {
    return await next()
  } catch (error) {
    if (error instanceof Response) return error
    try {
      // Use the actual owner's closure across Nitro/SSR bundle boundaries.
      const mapped = requestResources(request).limiter.errorResponse(error)
      if (mapped) return mapped
    } catch { /* Missing carrier or unknown failure remains sanitized below. */ }
    return new Response('Internal Server Error', { status: 500 })
  }
})

export const startInstance = createStart(() => ({
  requestMiddleware: [errors, createCsrfMiddleware({ filter: ({ handlerType }) => handlerType === 'serverFn' })],
}))
