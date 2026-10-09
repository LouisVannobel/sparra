import type { Page, BrowserContext, Request } from 'playwright'
import { bounded } from './web-process'
import { bootstrapResponseCategory, bootstrapFailureCategory, cspCategory, fillExceptionCategory, requestFillReportLine,
  type BootstrapResponse, type RequestFillFailure, type RequestFillState } from './magic-request-fill-diagnostic'

type RequestBootstrapObserver = { bootstrap: RequestFillFailure['bootstrap']; stop(): void; contextClosed(): boolean }
type RequestFillEvidence = { requestFillFailure?: RequestFillFailure; requestFillState?: RequestFillState }

export async function observeMagicRequestBootstrap(page: Page, context: BrowserContext, origin: string): Promise<RequestBootstrapObserver> {
  const scriptResponses: BootstrapResponse[] = [], scriptFailures: ReturnType<typeof bootstrapFailureCategory>[] = []
  const bootstrap = { pageErrors: 0, consoleErrors: 0, scriptResponses, scriptFailures, truncated: false }
  let active = true, contextClosed = false
  context.on('close', () => { contextClosed = true })
  page.on('pageerror', () => { if (active) bootstrap.pageErrors = Math.min(255, bootstrap.pageErrors + 1) })
  page.on('console', message => { if (active && message.type() === 'error') bootstrap.consoleErrors = Math.min(255, bootstrap.consoleErrors + 1) })
  page.on('response', response => {
    if (!active || response.request().resourceType() !== 'script') return
    if (bootstrap.scriptResponses.length < 16) bootstrap.scriptResponses.push(bootstrapResponseCategory(response.url(), origin, response.status()))
    else bootstrap.truncated = true
  })
  page.on('requestfailed', request => {
    if (!active || request.resourceType() !== 'script') return
    if (bootstrap.scriptFailures.length < 16) bootstrap.scriptFailures.push(classifyScriptFailure(request))
    else bootstrap.truncated = true
  })
  await page.addInitScript({ content: `(${installRequestCspObserver.toString()})(${cspCategory.toString()})` })
  return { bootstrap, stop() { active = false }, contextClosed: () => contextClosed }
}

function classifyScriptFailure(request: Request) {
  const failure = request.failure()
  return bootstrapFailureCategory(failure ? failure.errorText : null)
}

function installRequestCspObserver(classify: typeof cspCategory) {
  const counts = { script: 0, style: 0, connect: 0, other: 0 }
  window.__magicBootstrapCsp = counts
  window.addEventListener('securitypolicyviolation', event => {
    const category = classify(event.effectiveDirective)
    counts[category] = Math.min(255, counts[category] + 1)
  })
}

// This callback is serialized by native Playwright; all its browser reads stay
// inside the callback and return only the established closed snapshot fields.
function readRequestFillState(elements: Element[]): RequestFillState {
  // Nested definitions travel with Playwright's serialized callback. They
  // return only these specific closed fields and need no imported runtime.
  function selectedInput() {
    if (elements.length !== 1) return undefined
    if (elements[0] instanceof HTMLInputElement) return elements[0]
    return undefined
  }
  function visible(input: HTMLInputElement) {
    const style = getComputedStyle(input)
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    const rect = input.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  function fieldState(input: HTMLInputElement | undefined) {
    if (!input) return { visible: null, enabled: null, nativeDisabled: null, readOnly: null, formBusy: null }
    return { visible: visible(input), enabled: !input.matches(':disabled') && input.getAttribute('aria-disabled') !== 'true',
      nativeDisabled: input.disabled, readOnly: input.readOnly, formBusy: input.closest('form')?.getAttribute('aria-busy') === 'true' }
  }
  function count(value: number) {
    // Number.isInteger rejects missing/non-number values without coercion.
    if (!Number.isInteger(value)) return null
    if (value < 0 || value > 255) return null
    return value
  }
  function cspState() {
    const csp = window.__magicBootstrapCsp
    if (!csp) return { script: null, style: null, connect: null, other: null }
    return { script: count(csp.script), style: count(csp.style), connect: count(csp.connect), other: count(csp.other) }
  }
  return { fieldCount: Math.min(255, elements.length), ...fieldState(selectedInput()),
    sameLoginRoute: location.pathname === '/login', emptyFragment: location.hash === '',
    firstRouterClean: window.__magicFirstRouterClean === true, routerPresent: !!window.__TSR_ROUTER__,
    csp: cspState() }
}

async function captureRequestFillFailure(page: Page, observer: RequestBootstrapObserver, error: unknown, evidence: RequestFillEvidence) {
  observer.stop()
  const diagnostic = { exception: fillExceptionCategory(error), pageClosed: page.isClosed(), contextClosed: observer.contextClosed(),
    bootstrap: observer.bootstrap, snapshotUnavailable: false }
  evidence.requestFillFailure = diagnostic
  let snapshot: RequestFillState | undefined
  try {
    snapshot = await bounded(page.getByRole('textbox', { name: /^Email address/ }).evaluateAll(readRequestFillState))
    evidence.requestFillState = snapshot
  } catch { diagnostic.snapshotUnavailable = true }
  // Runner-local evidence is not uploaded by CI. Emission must never mask the
  // native failure; the calling case still owns its original stage and cleanup.
  try { console.error(requestFillReportLine(diagnostic, snapshot)) } catch { /* retain primary failure */ }
}

export async function fillMagicRequestEmail(page: Page, email: string, observer: RequestBootstrapObserver, evidence: RequestFillEvidence) {
  try { await page.getByRole('textbox', { name: /^Email address/ }).fill(email) }
  catch (error) { await captureRequestFillFailure(page, observer, error, evidence); throw error }
  finally { observer.stop() }
}
