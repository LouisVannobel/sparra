import { createServerEntry } from '@tanstack/react-start/server-entry'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { readWebConfig } from './platform/config.server'
import { randomBytes } from 'node:crypto'
import { googleAccountCallbackResponse, isGoogleAccountCallbackRequest } from './modules/auth/http-boundary.server'
import { requestResources } from './platform/resources.server'
import { normalizeDirectServeIngress, readDirectServeConfig } from './platform/direct-serve-ingress.server'

// Nitro validates before listen. Its SSR service is a separate bundle: consume
// the same pure validator here without importing the startup side effects twice.
const webConfig = readWebConfig(process.env)
const ingressConfig = readDirectServeConfig(process.env, webConfig)
const handle = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  async fetch(request, options) {
    const refusal = normalizeDirectServeIngress(request, ingressConfig)
    if (refusal) return refusal
    const ingressNow = Date.now()
    Object.defineProperty(request, 'appAuthDeadlineAtMs', {
      value: ingressNow + Math.min(webConfig.requestTimeoutMs, 10_000),
    })
    const nonce = randomBytes(24).toString('base64')
    Object.defineProperty(request, 'appCspNonce', { value: nonce })
    const httpTimeoutSignal = AbortSignal.timeout(webConfig.requestTimeoutMs)
    const clientSignal = request.signal
    let response: Response
    if (clientSignal.aborted) {
      response = new Response('Request Cancelled', { status: 499 })
    } else {
      const cancellation = AbortSignal.any([clientSignal, httpTimeoutSignal])
      const downstream = new AbortController()
      // H3 may log a thrown abort reason before resolving its error response.
      // Preserve cancellation, but never forward a private client error reason.
      cancellation.addEventListener('abort', () => downstream.abort(), { once: true })
      try {
        // Keep srvx's lazy NodeRequest intact; do not access its body getter.
        Object.defineProperty(request, 'signal', { value: downstream.signal, configurable: true })
        // Consumers must cooperate with this signal; no work is raced/detached.
        if (isGoogleAccountCallbackRequest(request, webConfig.origin)) {
          const resources = requestResources(request)
          response = resources.auth ? await googleAccountCallbackResponse(request, resources.auth, resources.limiter)
            : new Response('Service Unavailable', { status: 503 })
        } else response = await handle(request, options)
      } catch {
        response = new Response('Internal Server Error', { status: 500 })
      }
      // Real Start/H3 fulfills error responses, including aborted requests.
      if (clientSignal.aborted || httpTimeoutSignal.aborted) {
        await response.body?.cancel().catch(() => {})
        response = clientSignal.aborted
          ? new Response('Request Cancelled', { status: 499 })
          : new Response('Gateway Timeout', { status: 504 })
      }
    }
    const headers = new Headers(response.headers)
    const publicDocument = new URL(request.url).pathname === '/'
      && (request.method === 'GET' || request.method === 'HEAD')
      && response.status >= 200 && response.status < 300
      && /^text\/html(?:\s*;|$)/i.test(headers.get('content-type') ?? '')
    headers.set('cache-control', 'no-store')
    if (publicDocument) headers.delete('x-robots-tag')
    else headers.set('x-robots-tag', 'noindex')
    headers.set('referrer-policy', 'no-referrer')
    headers.set('x-content-type-options', 'nosniff')
    headers.set('content-security-policy', `default-src 'none'; object-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${publicDocument ? "; media-src 'self'" : ''}`)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
})
