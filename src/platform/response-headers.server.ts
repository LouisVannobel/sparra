export function responseWithSecurityHeaders(request: Request, response: Response, nonce: string): Response {
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
}
