// Test-only closed projections; never retain browser error details or URLs.
export type BootstrapResponse = { sameOrigin: boolean; status: 'success' | 'redirect' | 'client-error' | 'server-error' | 'other' }
export type BootstrapCsp = { script: number; style: number; connect: number; other: number }
declare global {
  interface Window { __magicBootstrapCsp?: BootstrapCsp; __magicFirstRouterClean?: boolean }
}
export function fillExceptionCategory(error: unknown): 'TimeoutError' | 'TargetClosedError' | 'Error' | 'other' {
  if (typeof error !== 'object' || error === null) return 'other'
  try {
    let object: object | null = error
    for (let depth = 0; object && depth < 4; depth++, object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, 'name')
      if (descriptor) return descriptor.value === 'TimeoutError' ? 'TimeoutError' : descriptor.value === 'TargetClosedError' ? 'TargetClosedError' : descriptor.value === 'Error' ? 'Error' : 'other'
    }
  } catch { /* A hostile diagnostic must never replace the primary failure. */ }
  return 'other'
}
export function bootstrapResponseCategory(url: string, origin: string, status: number): BootstrapResponse {
  let sameOrigin = false
  try { sameOrigin = new URL(url).origin === new URL(origin).origin } catch { /* closed unknown */ }
  return { sameOrigin, status: Number.isInteger(status) && status >= 200 && status < 300 ? 'success'
    : Number.isInteger(status) && status >= 300 && status < 400 ? 'redirect'
    : Number.isInteger(status) && status >= 400 && status < 500 ? 'client-error'
    : Number.isInteger(status) && status >= 500 && status < 600 ? 'server-error' : 'other' }
}
export function bootstrapFailureCategory(errorText: string | null): 'aborted' | 'connection' | 'certificate' | 'blocked' | 'other' {
  if (errorText === 'net::ERR_ABORTED') return 'aborted'
  if (errorText === 'net::ERR_CONNECTION_REFUSED' || errorText === 'net::ERR_CONNECTION_RESET' || errorText === 'net::ERR_CONNECTION_CLOSED' || errorText === 'net::ERR_NAME_NOT_RESOLVED') return 'connection'
  if (errorText === 'net::ERR_CERT_AUTHORITY_INVALID' || errorText === 'net::ERR_CERT_COMMON_NAME_INVALID' || errorText === 'net::ERR_CERT_DATE_INVALID') return 'certificate'
  if (errorText === 'net::ERR_BLOCKED_BY_CLIENT' || errorText === 'net::ERR_BLOCKED_BY_RESPONSE') return 'blocked'
  return 'other'
}
export function cspCategory(directive: string): 'script' | 'style' | 'connect' | 'other' {
  if (directive === 'script-src' || directive === 'script-src-elem' || directive === 'script-src-attr') return 'script'
  if (directive === 'style-src' || directive === 'style-src-elem' || directive === 'style-src-attr') return 'style'
  return directive === 'connect-src' ? 'connect' : 'other'
}
