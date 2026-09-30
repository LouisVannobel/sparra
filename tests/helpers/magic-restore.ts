import { expect } from 'vitest'
import { mkdir } from 'node:fs/promises'
import type { BrowserContext } from 'playwright'
import type { startMailHttpPeer } from '../fixtures/mail-http'

// This consumer requires a browser launched without Playwright's one default
// --disable-back-forward-cache switch. A plain back/reload cannot satisfy it.
export async function assertMagicRestore(input: {
  origin: string; runId: string; peer: Awaited<ReturnType<typeof startMailHttpPeer>>
  context(): Promise<BrowserContext>; setStage(value: string): void; evidence: Record<string, unknown>
}) {
  const context = await input.context()
  try {
    await context.addInitScript(() => {
      if (location.pathname !== '/auth/magic/confirm') return
      Reflect.set(window, '__ownedPersistedRestore', false)
      window.addEventListener('pageshow', event => { if (event.persisted) Reflect.set(window, '__ownedPersistedRestore', true) })
    })
    const page = await context.newPage(); page.setDefaultTimeout(8000)
    const diagnostic = await context.newCDPSession(page)
    const cacheReasons: { type: string; reason: string }[] = []
    input.evidence.cacheReasons = cacheReasons
    // Diagnostic identifiers from the installed public CDP Page reason enum;
    // omit frame/loader IDs, URLs, context text and explanation trees entirely.
    const allowedReasons = new Set(['BackForwardCacheDisabled', 'BackForwardCacheDisabledByCommandLine',
      'BackForwardCacheDisabledForDelegate', 'BackForwardCacheDisabledByLowMemory', 'DisableForRenderFrameHostCalled',
      'CacheControlNoStore', 'CacheControlNoStoreCookieModified', 'CacheControlNoStoreHTTPOnlyCookieModified',
      'MainResourceHasCacheControlNoStore', 'SubresourceHasCacheControlNoStore', 'JsNetworkRequestReceivedCacheControlNoStoreResource',
      'JavaScriptExecution', 'BrowsingInstanceNotSwapped', 'RelatedActiveContentsExist', 'InjectedJavascript', 'InjectedStyleSheet',
      'ContentWebAuthenticationAPI', 'OutstandingNetworkRequestFetch', 'OutstandingNetworkRequestXHR', 'Unknown', 'ErrorDocument',
      'HTTPStatusNotOK', 'SchemeNotHTTPOrHTTPS', 'Loading', 'CacheLimit', 'RendererProcessKilled', 'RendererProcessCrashed', 'CacheFlushed'])
    diagnostic.on('Page.backForwardCacheNotUsed', event => {
      for (const value of event.notRestoredExplanations) cacheReasons.push({
        type: ['SupportPending', 'PageSupportNeeded', 'Circumstantial'].includes(value.type) ? value.type : 'unclassified',
        reason: allowedReasons.has(value.reason) ? value.reason : 'unclassified',
      })
    })
    await diagnostic.send('Page.enable')
    let posts = 0, pageErrors = 0
    page.on('request', request => { if (request.method() === 'POST') posts++ })
    page.on('pageerror', () => { pageErrors++ })
    input.setStage('restore: synthetic confirmation and CSS zoom')
    await page.goto(input.origin + '/auth/magic/confirm?lang=en#token=' + 'A'.repeat(43))
    await page.getByRole('textbox').waitFor()
    expect(await page.evaluate(() => Reflect.get(window, '__magicFirstRouterClean') === true && location.hash === '')).toBe(true)
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    const zoom = await page.evaluate(() => ({ factor: getComputedStyle(document.documentElement).zoom === '2',
      fits: [...document.querySelectorAll('main h1,main input,main button,main a')].every(element => {
        const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + .5
      }),
      purpose: document.querySelector('input')?.type === 'email' && document.querySelector('input')?.autocomplete === 'email',
    }))
    input.evidence.cssZoom200At640 = zoom
    expect(zoom).toEqual({ factor: true, fits: true, purpose: true })
    expect(await page.evaluate(() => location.hash === '')).toBe(true)
    expect(input.peer.containsProof(page.url()) || input.peer.containsProof(await page.content())).toBe(false)
    expect(page.url().includes('A'.repeat(43)) || (await page.content()).includes('A'.repeat(43))).toBe(false)
    await mkdir('.superpowers/sdd/2026-09-10-functional-auth/task-8c-evidence', { recursive: true })
    await page.screenshot({ path: `.superpowers/sdd/2026-09-10-functional-auth/task-8c-evidence/${input.runId}-confirm-css-zoom200.png`, fullPage: true })
    await page.evaluate(() => { document.documentElement.style.zoom = '' })
    await page.getByRole('textbox').fill('discarded-intent@example.test')
    input.setStage('restore: actual document departure')
    await page.getByRole('link', { name: 'Request a new link', exact: true }).click()
    await page.getByRole('button', { name: 'Send a sign-in link', exact: true }).waitFor()
    input.setStage('restore: back navigation')
    // Playwright explicitly does not support BFCache goBack/goForward waits.
    // Trigger the browser's native traversal and qualify actual page state,
    // not a synthetic network-navigation completion for a restored document.
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => location.pathname === '/auth/magic/confirm')
    const backObserved = await page.evaluate(() => ({ persisted: Reflect.get(window, '__ownedPersistedRestore') === true,
      canonicalPath: location.pathname === '/auth/magic/confirm', loginPath: location.pathname === '/login',
      readyState: document.readyState, noInput: document.querySelector('input') === null, hashClean: location.hash === '',
      missingAlert: [...document.querySelectorAll('main [role="alert"]')].some(node => node.textContent?.includes('This link is missing or invalid.')),
    }))
    input.evidence.backObserved = { navigationDriver: 'browser-history-back', ...backObserved, posts, pageErrors }
    input.setStage('restore: restored missing alert')
    await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor()
    input.evidence.restoreDiagnostic = await page.evaluate(() => {
      // This optional Chrome API is not declared by the project's lib.dom.
      const navigation = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & {
        notRestoredReasons?: { children: unknown[]; reasons: { reason: string }[] | null } | null
      }) | undefined
      const reasons = navigation?.notRestoredReasons
      // Public Chrome reason identifiers only; never serialize the associated
      // URL/id/name/src or recurse through the frame tree. Unknowns stay opaque.
      const allowed = new Set(['unload-listener', 'unload-handler', 'response-cache-control-no-store', 'related-active-contents', 'masked'])
      return { historyNavigation: navigation?.type === 'back_forward', reasonObjectPresent: reasons != null,
        childCount: reasons?.children.length ?? 0,
        reasons: reasons?.reasons?.map(value => allowed.has(value.reason) ? value.reason : 'unclassified') ?? [] }
    })
    const restored = await page.evaluate(() => ({ persisted: Reflect.get(window, '__ownedPersistedRestore') === true,
      clean: location.hash === '', noInput: document.querySelector('input') === null,
      noOldIntent: !document.body.textContent?.includes('discarded-intent@example.test'),
    }))
    input.evidence.restored = { ...restored, posts, pageErrors }
    expect(restored).toEqual({ persisted: true, clean: true, noInput: true, noOldIntent: true })
    expect(posts).toBe(0); expect(pageErrors).toBe(0)
  } finally { await context.close() }
}
