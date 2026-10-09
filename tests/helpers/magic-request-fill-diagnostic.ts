// Test-only closed projections; never retain browser error details or URLs.
export type BootstrapResponse = { sameOrigin: boolean; status: 'success' | 'redirect' | 'client-error' | 'server-error' | 'other' }
type BootstrapCsp = { script: number; style: number; connect: number; other: number }
export type RequestFillFailure = { exception: ReturnType<typeof fillExceptionCategory>; pageClosed: boolean; contextClosed: boolean; snapshotUnavailable: boolean;
  bootstrap: { pageErrors: number; consoleErrors: number; scriptResponses: BootstrapResponse[]; scriptFailures: ReturnType<typeof bootstrapFailureCategory>[]; truncated: boolean } }
export type RequestFillState = { fieldCount: number; visible: boolean | null; enabled: boolean | null; nativeDisabled: boolean | null; readOnly: boolean | null;
  formBusy: boolean | null; sameLoginRoute: boolean; emptyFragment: boolean; firstRouterClean: boolean; routerPresent: boolean;
  csp: { script: number | null; style: number | null; connect: number | null; other: number | null } }
export function requestFillReportLine(failure: RequestFillFailure, state?: RequestFillState): string {
  const count = (value: number | null) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(255, value) : null
  const boolean = (value: boolean | null) => typeof value === 'boolean' ? value : null
  // Reconstruct every field. Never stringify the original diagnostic or a
  // nested object: unexpected keys and toJSON getters may contain private data.
  return 'MAGIC_REQUEST_FILL_DIAGNOSTIC ' + JSON.stringify({
    exception: fillExceptionCategory({ name: failure.exception }), pageClosed: failure.pageClosed === true,
    contextClosed: failure.contextClosed === true, snapshotUnavailable: failure.snapshotUnavailable === true,
    bootstrap: {
      pageErrors: count(failure.bootstrap.pageErrors), consoleErrors: count(failure.bootstrap.consoleErrors),
      scriptResponses: failure.bootstrap.scriptResponses.slice(0, 16).map(response => ({ sameOrigin: response.sameOrigin === true,
        status: response.status === 'success' || response.status === 'redirect' || response.status === 'client-error' || response.status === 'server-error' ? response.status : 'other' })),
      scriptFailures: failure.bootstrap.scriptFailures.slice(0, 16).map(category => category === 'aborted' || category === 'connection' || category === 'certificate' || category === 'blocked' ? category : 'other'),
      truncated: failure.bootstrap.truncated === true || failure.bootstrap.scriptResponses.length > 16 || failure.bootstrap.scriptFailures.length > 16,
    },
    state: state ? { fieldCount: count(state.fieldCount), visible: boolean(state.visible), enabled: boolean(state.enabled),
      nativeDisabled: boolean(state.nativeDisabled), readOnly: boolean(state.readOnly), formBusy: boolean(state.formBusy),
      sameLoginRoute: state.sameLoginRoute === true, emptyFragment: state.emptyFragment === true,
      firstRouterClean: state.firstRouterClean === true, routerPresent: state.routerPresent === true,
      csp: { script: count(state.csp.script), style: count(state.csp.style), connect: count(state.csp.connect), other: count(state.csp.other) } } : null,
  })
}
declare global {
  interface Window { __magicBootstrapCsp?: BootstrapCsp; __magicFirstRouterClean?: boolean }
}
export function fillExceptionCategory(error: unknown): 'TimeoutError' | 'TargetClosedError' | 'Error' | 'other' {
  if (typeof error !== 'object' || error === null) return 'other'
  try {
    let object: object | null = error
    for (let depth = 0; object && depth < 4; depth++, object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, 'name')
      if (descriptor) {
        switch (descriptor.value) {
          case 'TimeoutError': return 'TimeoutError'
          case 'TargetClosedError': return 'TargetClosedError'
          case 'Error': return 'Error'
          default: return 'other'
        }
      }
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
