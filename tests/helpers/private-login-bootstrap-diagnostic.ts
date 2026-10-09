import type { Page, Request, Response } from 'playwright'
import { bounded } from './web-process'
import { bootstrapResponseCategory, bootstrapFailureCategory, cspCategory, fillExceptionCategory, type BootstrapResponse } from './magic-request-fill-diagnostic'

type PrivateScriptFailure = ReturnType<typeof bootstrapFailureCategory> | 'network-changed'
type PrivatePageError = 'module-load' | 'hydration' | 'other'
export type PrivateLoginFailure = { exception: ReturnType<typeof fillExceptionCategory>; snapshotUnavailable: boolean;
  bootstrap: { pageErrors: PrivatePageError[]; scriptResponses: BootstrapResponse[]; scriptFailures: PrivateScriptFailure[]; truncated: boolean } }
export type PrivateLoginState = { buttonCount: number; nativeDisabled: boolean | null; matchesDisabled: boolean | null; ariaDisabled: boolean | null;
  documentState: DocumentReadyState | 'other'; startOptionsPresent: boolean; bootstrapPresent: boolean; coreHydrationFinalized: boolean;
  streamEnded: boolean; routerPresent: boolean; routerLoading: boolean; googleUnavailable: boolean;
  csp: { script: number | null; style: number | null; connect: number | null; other: number | null } }

export function privateLoginFailureCategory(errorText: string | null): PrivateScriptFailure {
  return errorText === 'net::ERR_NETWORK_CHANGED' ? 'network-changed' : bootstrapFailureCategory(errorText)
}
export function privateLoginPageErrorCategory(message: string): PrivatePageError {
  if (/failed to fetch dynamically imported module|importing a module script failed/i.test(message)) return 'module-load'
  return /Minified React error #(418|419|420|421|422|423|424|425)\b|hydration failed|hydration mismatch/i.test(message) ? 'hydration' : 'other'
}
function count(value: number | null) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(255, value) : null
}
function boolean(value: boolean | null) { return typeof value === 'boolean' ? value : null }
function closedState(state: PrivateLoginState) {
  return { buttonCount: count(state.buttonCount), nativeDisabled: boolean(state.nativeDisabled), matchesDisabled: boolean(state.matchesDisabled),
    ariaDisabled: boolean(state.ariaDisabled), documentState: ['loading', 'interactive', 'complete'].find(value => value === state.documentState) ?? 'other',
    startOptionsPresent: state.startOptionsPresent === true, bootstrapPresent: state.bootstrapPresent === true,
    coreHydrationFinalized: state.coreHydrationFinalized === true, streamEnded: state.streamEnded === true,
    routerPresent: state.routerPresent === true, routerLoading: state.routerLoading === true, googleUnavailable: state.googleUnavailable === true,
    csp: { script: count(state.csp.script), style: count(state.csp.style), connect: count(state.csp.connect), other: count(state.csp.other) } }
}
export function privateLoginReportLine(failure: PrivateLoginFailure, state?: PrivateLoginState): string {
  // Reconstruct every field: nested private keys and toJSON never reach stderr.
  const bootstrap = failure.bootstrap
  return 'PRIVATE_LOGIN_BOOTSTRAP_DIAGNOSTIC ' + JSON.stringify({ exception: fillExceptionCategory({ name: failure.exception }),
    snapshotUnavailable: failure.snapshotUnavailable === true, bootstrap: {
      pageErrors: bootstrap.pageErrors.slice(0, 16).map(category => ['module-load', 'hydration'].find(value => value === category) ?? 'other'),
      scriptResponses: bootstrap.scriptResponses.slice(0, 16).map(response => ({ sameOrigin: response.sameOrigin === true,
        status: ['success', 'redirect', 'client-error', 'server-error'].find(value => value === response.status) ?? 'other' })),
      scriptFailures: bootstrap.scriptFailures.slice(0, 16).map(category => ['aborted', 'connection', 'certificate', 'blocked', 'network-changed'].find(value => value === category) ?? 'other'),
      truncated: [bootstrap.truncated === true, bootstrap.pageErrors.length > 16, bootstrap.scriptResponses.length > 16, bootstrap.scriptFailures.length > 16].some(value => value),
    }, state: state ? closedState(state) : null })
}

declare global {
  interface Window { __privateLoginCsp?: PrivateLoginState['csp'] }
}

function scriptFailure(request: Request) {
  const failure = request.failure()
  return privateLoginFailureCategory(failure ? failure.errorText : null)
}
function installPrivateLoginCsp(classify: typeof cspCategory) {
  const counts = { script: 0, style: 0, connect: 0, other: 0 }
  window.__privateLoginCsp = counts
  window.addEventListener('securitypolicyviolation', event => {
    const category = classify(event.effectiveDirective)
    counts[category] = Math.min(255, counts[category] + 1)
  })
}
export async function observePrivateLoginBootstrap(page: Page, origin: string) {
  const bootstrap: PrivateLoginFailure['bootstrap'] = { pageErrors: [], scriptResponses: [], scriptFailures: [], truncated: false }
  const pageError = (error: Error) => {
    if (bootstrap.pageErrors.length < 16) bootstrap.pageErrors.push(privateLoginPageErrorCategory(error.message))
    else bootstrap.truncated = true
  }
  const response = (response: Response) => {
    if (response.request().resourceType() !== 'script') return
    if (bootstrap.scriptResponses.length < 16) bootstrap.scriptResponses.push(bootstrapResponseCategory(response.url(), origin, response.status()))
    else bootstrap.truncated = true
  }
  const failed = (request: Request) => {
    if (request.resourceType() !== 'script') return
    if (bootstrap.scriptFailures.length < 16) bootstrap.scriptFailures.push(scriptFailure(request))
    else bootstrap.truncated = true
  }
  page.on('pageerror', pageError); page.on('response', response); page.on('requestfailed', failed)
  // Both functions travel in the script; no imported closure runs in Chromium.
  try { await page.addInitScript({ content: `(${installPrivateLoginCsp.toString()})(${cspCategory.toString()})` }) }
  catch { /* Failed observation must not replace the original navigation/click. */ }
  return { bootstrap, stop() {
    try { page.off('pageerror', pageError); page.off('response', response); page.off('requestfailed', failed) }
    catch { /* Observer cleanup cannot mask the native failure. */ }
  } }
}

// Playwright serializes this callback. Its browser reads and nested helpers are
// self-contained and return only booleans, closed document state and counts.
function readPrivateLoginState(elements: Element[]): PrivateLoginState {
  function buttonState() {
    if (elements.length !== 1) return { nativeDisabled: null, matchesDisabled: null, ariaDisabled: null }
    const button = elements[0]
    if (!(button instanceof HTMLButtonElement)) return { nativeDisabled: null, matchesDisabled: null, ariaDisabled: null }
    return { nativeDisabled: button.disabled, matchesDisabled: button.matches(':disabled'), ariaDisabled: button.getAttribute('aria-disabled') === 'true' }
  }
  function cspState() {
    const csp = window.__privateLoginCsp
    if (!csp) return { script: null, style: null, connect: null, other: null }
    function closedCount(value: number | null) {
      if (typeof value !== 'number') return null
      if (!Number.isInteger(value)) return null
      return Math.min(255, Math.max(0, value))
    }
    return { script: closedCount(csp.script), style: closedCount(csp.style), connect: closedCount(csp.connect), other: closedCount(csp.other) }
  }
  return { buttonCount: Math.min(255, elements.length), ...buttonState(), documentState: document.readyState,
    startOptionsPresent: '__TSS_START_OPTIONS__' in window, bootstrapPresent: !!window.$_TSR,
    // Start's finalized flag alone does not prove a successful React commit.
    coreHydrationFinalized: window.$_TSR?.hydrated === true, streamEnded: window.$_TSR?.streamEnded === true,
    routerPresent: !!window.__TSR_ROUTER__, routerLoading: window.__TSR_ROUTER__?.state.isLoading === true,
    googleUnavailable: [...document.querySelectorAll('.auth-login [role="status"]')].some(element => element.textContent === 'Google sign-in is currently unavailable.'),
    csp: cspState() }
}
export async function capturePrivateLoginBootstrapFailure(page: Page, observer: Awaited<ReturnType<typeof observePrivateLoginBootstrap>>, error: unknown) {
  try {
    const failure: PrivateLoginFailure = { exception: fillExceptionCategory(error), bootstrap: observer.bootstrap, snapshotUnavailable: false }
    let state: PrivateLoginState | undefined
    try { state = await bounded(page.getByRole('button', { name: 'Continue with Google' }).evaluateAll(readPrivateLoginState), 1000) }
    catch { failure.snapshotUnavailable = true }
    console.error(privateLoginReportLine(failure, state))
  }
  catch { /* Diagnostic emission must not replace the primary failure. */ }
}
