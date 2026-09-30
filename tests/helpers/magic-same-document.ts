import { expect } from 'vitest'
import type { BrowserContext } from 'playwright'

// Witnesses only: no URL clear, event suppression or proof replacement.
export async function assertCompiledMagicArrival(origin: string, context: () => Promise<BrowserContext>, evidence: Record<string, unknown>, scenario: 'anchor' | 'matrix' | 'uninteracted' | 'scroll' = 'anchor') {
  const browser = await context()
  try {
    await browser.addInitScript(() => {
      const observations = { popstate: 0, hashchange: 0, router: 0, navigationRegistrations: 0, unsafeEvent: false, unsafeRouter: false, unsafeStorage: false, unsafeUnload: false }
      Object.defineProperty(window, '__magicArrivalWitness', { value: observations })
      const navigation = Reflect.get(window, 'navigation')
      if (navigation && typeof navigation.addEventListener === 'function') {
        const add = navigation.addEventListener.bind(navigation)
        navigation.addEventListener = (...args: Parameters<typeof add>) => {
          observations.navigationRegistrations++
          return add(...args)
        }
      }
      function sensitive(value: string) {
        try { const url = new URL(value); return url.origin === location.origin && url.pathname === '/auth/magic/confirm' && url.hash !== '' } catch { return false }
      }
      let nativeRouter: typeof window.__TSR_ROUTER__
      Object.defineProperty(window, '__TSR_ROUTER__', { configurable: true, get: () => nativeRouter,
        set(value: typeof window.__TSR_ROUTER__) {
          nativeRouter = value
          observations.unsafeRouter ||= sensitive(location.href)
          // Installed when the REAL router is published: after the app's
          // earlier guard should exist. These witnesses never fix the URL.
          window.addEventListener('popstate', () => { observations.popstate++; observations.unsafeEvent ||= sensitive(location.href) }, { capture: true })
          window.addEventListener('hashchange', event => { observations.hashchange++; observations.unsafeEvent ||= sensitive(location.href) || sensitive(event.oldURL) || sensitive(event.newURL) }, { capture: true })
          window.addEventListener('beforeunload', () => { observations.unsafeUnload ||= sensitive(location.href) })
          window.addEventListener('pagehide', () => { observations.unsafeUnload ||= sensitive(location.href) })
          value?.subscribe('onBeforeNavigate', event => {
            observations.router++; observations.unsafeRouter ||= sensitive(location.href) || (event.toLocation.pathname === '/auth/magic/confirm' && event.toLocation.hash !== '')
          })
        },
      })
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        observations.unsafeStorage ||= ['A'.repeat(43), 'E'.repeat(43)].some(marker => String(key).includes(marker) || String(value).includes(marker))
        return setItem.call(this, key, value)
      }
      // Stimulus for the hashchange-first fallback: changes native location
      // without invoking the Router wrapper, then delivers only hashchange.
      // It does not clean, suppress, notify the panel, or implement its guard.
      const replace = history.replaceState.bind(history)
      Object.defineProperty(window, '__ownedNativeArrival', { value: (withPopstate = false) => {
        const oldURL = location.href
        const newURL = location.origin + location.pathname + location.search + '#token=' + 'E'.repeat(43)
        replace({ ...history.state, ownedOpaqueMarker: 'retained' }, '', newURL)
        if (withPopstate) window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
        window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }))
      } })
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000)
    let documents = 0, posts = 0
    page.on('request', request => { if (request.isNavigationRequest()) documents++; if (request.method() === 'POST') posts++ })
    await page.goto(origin + '/auth/magic/confirm?lang=en')
    if (scenario === 'uninteracted') {
      evidence.uninteractedStage = 'initial passive observation'
      // Playwright evaluate/locator helpers use Runtime.callFunctionOn with
      // userGesture:true. Do not use them to establish a non-interacted page.
      const cdp = await browser.newCDPSession(page)
      await expect.poll(async () => (await cdp.send('Runtime.evaluate', { userGesture: false, returnByValue: true,
        expression: `Boolean(window.__TSR_ROUTER__ && document.querySelector('main [role="alert"]'))` })).result.value).toBe(true)
      const before = (await cdp.send('Runtime.evaluate', { userGesture: false, returnByValue: true,
        expression: `(() => { window.__ownedOriginalDocument = true; return { hasBeenActive: navigator.userActivation.hasBeenActive, clean: location.hash === '' }; })()` })).result.value
      evidence.uninteractedBefore = before
      expect(before).toEqual({ hasBeenActive: false, clean: true })
      // Actual browser address/fragment navigation: no click, fill, key,
      // dispatched event, replaceState stimulus or production guard double.
      evidence.uninteractedStage = 'native address arrival'
      await page.goto(origin + '/auth/magic/confirm?lang=en#token=' + 'A'.repeat(43))
      evidence.uninteractedStage = 'passive form observation'
      await expect.poll(async () => (await cdp.send('Runtime.evaluate', { userGesture: false, returnByValue: true,
        expression: `Boolean(location.hash === '' && document.querySelector('input[type="email"]')?.value === '')` })).result.value).toBe(true)
      const after = (await cdp.send('Runtime.evaluate', { userGesture: false, returnByValue: true,
        expression: `(() => ({ hasBeenActive: navigator.userActivation.hasBeenActive, sameDocument: window.__ownedOriginalDocument === true,
          currentClean: location.hash === '', routerClean: window.__TSR_ROUTER__?.state.location.hash === '',
          formEmpty: document.querySelector('input[type="email"]')?.value === '', witness: window.__magicArrivalWitness }))()` })).result.value
      evidence.uninteractedArrival = { ...after, documents, posts }
      expect({ hasBeenActive: after.hasBeenActive, sameDocument: after.sameDocument, currentClean: after.currentClean,
        routerClean: after.routerClean, formEmpty: after.formEmpty, documents, posts }).toEqual({ hasBeenActive: false,
        sameDocument: true, currentClean: true, routerClean: true, formEmpty: true, documents: 1, posts: 0 })
      expect(after.witness.unsafeEvent || after.witness.unsafeRouter || after.witness.unsafeStorage || after.witness.unsafeUnload).toBe(false)
      return
    }
    await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor()
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.id = 'owned-arrival-control'; link.textContent = 'Receive a synthetic link'
      link.href = '/auth/magic/confirm?lang=en#token=' + 'A'.repeat(43)
      document.body.append(link)
    })
    await page.getByRole('link', { name: 'Receive a synthetic link', exact: true }).click()
    // Wait for the original Router event, not for a corrective witness.
    await page.waitForFunction(() => Reflect.get(window, '__magicArrivalWitness').popstate > 0)
    // Missing UI is the expected RED; retain safe observations rather than
    // returning a raw Playwright timeout that might include a navigation URL.
    await page.getByRole('textbox').waitFor().catch(() => {})
    const result = await page.evaluate(() => ({
      currentClean: location.hash === '', routerClean: window.__TSR_ROUTER__?.state.location.hash === '',
      formAvailable: document.querySelector('input[type="email"]') !== null,
      intendedEmailEmpty: document.querySelector<HTMLInputElement>('input[type="email"]')?.value === '',
      witness: Reflect.get(window, '__magicArrivalWitness'),
    }))
    evidence.arrival = { ...result, documents, posts }
    expect({ currentClean: result.currentClean, routerClean: result.routerClean, formAvailable: result.formAvailable,
      intendedEmailEmpty: result.intendedEmailEmpty, documents, posts }).toEqual({ currentClean: true, routerClean: true, formAvailable: true, intendedEmailEmpty: true, documents: 1, posts: 0 })
    expect(result.witness.unsafeEvent || result.witness.unsafeRouter || result.witness.unsafeStorage || result.witness.unsafeUnload).toBe(false)
    if (scenario === 'scroll') {
      const scrollEvidence: Record<string, unknown> = {}; evidence.scroll = scrollEvidence
      evidence.scrollStage = 'first position'
      await page.getByRole('textbox').fill('current-intent@example.test')
      await page.evaluate(() => {
        // Layout stimulus only: provide enough document height for meaningful
        // window scrolling. It never restores a position or changes Router.
        document.body.style.minHeight = '3000px'
        history.replaceState({ ...history.state, ownedScrollMarker: 'first' }, '', location.href)
      })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      async function setActualScroll(y: number) {
        const reached = await page.evaluate(top => new Promise<number>(resolve => {
          document.addEventListener('scroll', () => requestAnimationFrame(() => resolve(scrollY)), { once: true, capture: true })
          scrollTo(0, top)
        }), y)
        scrollEvidence.lastScroll = { requested: y, reached }; expect(reached).toBe(y)
      }
      await setActualScroll(640)
      // HTMLElement.click activates the existing public Link without a
      // Playwright scroll-into-view changing the departure position first.
      const navigationY = await page.evaluate(() => {
        const y = scrollY; document.querySelector<HTMLAnchorElement>('nav a[lang="fr"]')!.click(); return y
      })
      scrollEvidence.navigationY = navigationY
      expect(navigationY).toBe(640)
      evidence.scrollStage = 'new locale resets top'
      await page.getByRole('button', { name: 'Confirmer la connexion', exact: true }).waitFor()
      await expect.poll(async () => { const y = await page.evaluate(() => scrollY); scrollEvidence.newEntryY = y; return y }).toBe(0)
      await page.evaluate(() => { history.replaceState({ ...history.state, ownedScrollMarker: 'second' }, '', location.href) })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await setActualScroll(1180)
      const backDepartureY = await page.evaluate(() => { const y = scrollY; history.back(); return y })
      scrollEvidence.backDepartureY = backDepartureY
      expect(backDepartureY).toBe(1180)
      evidence.scrollStage = 'restore first position'
      await page.waitForFunction(() => document.documentElement.lang === 'en')
      await expect.poll(async () => { const y = await page.evaluate(() => scrollY); scrollEvidence.backY = y; return y }).toBe(640)
      const back = await page.evaluate(() => ({ y: scrollY, opaque: history.state.ownedScrollMarker === 'first',
        intent: document.querySelector<HTMLInputElement>('input')?.value === 'current-intent@example.test' }))
      expect(back).toEqual({ y: 640, opaque: true, intent: true })
      const forwardDepartureY = await page.evaluate(() => { const y = scrollY; history.forward(); return y })
      scrollEvidence.forwardDepartureY = forwardDepartureY
      expect(forwardDepartureY).toBe(640)
      evidence.scrollStage = 'restore second position'
      await page.waitForFunction(() => document.documentElement.lang === 'fr')
      await expect.poll(async () => { const y = await page.evaluate(() => scrollY); scrollEvidence.forwardY = y; return y }).toBe(1180)
      const forward = await page.evaluate(() => ({ y: scrollY, opaque: history.state.ownedScrollMarker === 'second',
        intent: document.querySelector<HTMLInputElement>('input')?.value === 'current-intent@example.test' }))
      expect(forward).toEqual({ y: 1180, opaque: true, intent: true })
      evidence.scroll = { navigationY, backDepartureY, forwardDepartureY, back, forward }
      // A new malformed arrival discards authority. Traversing to the previous
      // clean entry must not resurrect its formerly usable document proof.
      evidence.scrollStage = 'clean history cannot resurrect discarded proof'
      await page.goto(origin + '/auth/magic/confirm?lang=fr#token=malformed')
      await page.getByRole('alert').filter({ hasText: 'Ce lien est absent ou invalide.' }).waitFor()
      const priorPopstate = await page.evaluate(() => Reflect.get(window, '__magicArrivalWitness').popstate)
      await page.evaluate(() => history.back())
      await page.waitForFunction(prior => Reflect.get(window, '__magicArrivalWitness').popstate > prior, priorPopstate)
      expect(await page.getByRole('textbox').count()).toBe(0)
      const final = await page.evaluate(() => ({ clean: location.hash === '', witness: Reflect.get(window, '__magicArrivalWitness') }))
      expect(final.clean).toBe(true)
      expect(final.witness.unsafeEvent || final.witness.unsafeRouter || final.witness.unsafeStorage || final.witness.unsafeUnload).toBe(false)
      expect(documents).toBe(1); expect(posts).toBe(0)
      evidence.scrollProofNotResurrected = { clean: true, noInput: true, documents, posts }
      return
    }
    if (scenario !== 'matrix') return
    const cases: { name: string; clean: boolean; available: boolean; empty: boolean }[] = []
    evidence.forms = cases
    async function arrive(kind: string) {
      evidence.matrixStage = 'arrival-' + kind
      const before = await page.evaluate(() => history.length)
      await page.evaluate(name => {
        const fragments: Record<string, string> = { a: '#token=' + 'A'.repeat(43), b: '#token=' + 'E'.repeat(43),
          short: '#token=short', long: '#token=' + 'A'.repeat(44), bits: '#token=' + 'A'.repeat(42) + 'B',
          encoded: '#token=%41' + 'A'.repeat(42), padded: '#token=' + 'A'.repeat(43) + '=',
          excess: '#token=' + 'A'.repeat(43) + '&extra=1', section: '#section' }
        document.querySelector('#owned-arrival-control')?.remove()
        const link = document.createElement('a'); link.id = 'owned-arrival-control'; link.textContent = 'Receive a synthetic link'
        link.href = location.pathname + location.search + fragments[name]; document.body.append(link)
      }, kind)
      await page.getByRole('link', { name: 'Receive a synthetic link', exact: true }).click()
      await page.waitForFunction(() => location.hash === '')
      const after = await page.evaluate(() => history.length)
      evidence.historyObservation = { before, after }
      expect(after).toBe(before + 1)
    }
    await page.getByRole('textbox').fill('previous@example.test')
    await page.evaluate(() => {
      const form = document.querySelector('form')!, check = form.checkValidity.bind(form)
      const observation = { validBefore: check(), handlerEntered: false, validations: 0, submittedB: false }
      Object.defineProperty(window, '__ownedStaleControl', { value: observation })
      form.checkValidity = () => { observation.validations++; return check() }
      const prevent = Event.prototype.preventDefault
      Event.prototype.preventDefault = function () {
        prevent.call(this)
        if (this.type === 'submit' && this.target === form && !observation.handlerEntered) {
          // One public-API interleaving inside A's real handler; restore first.
          Event.prototype.preventDefault = prevent
          observation.handlerEntered = true
          Reflect.get(window, '__ownedNativeArrival')(true)
        }
      }
      const fetchOriginal = window.fetch
      window.fetch = function (resource, init) {
        if (resource === '/auth/magic/consume' && typeof init?.body === 'string') observation.submittedB = JSON.parse(init.body).token === 'E'.repeat(43)
        return fetchOriginal.call(window, resource, init)
      }
    })
    await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input')?.value === '')
    evidence.matrixStage = 'stale-render'
    const stale = await page.evaluate(() => Reflect.get(window, '__ownedStaleControl'))
    evidence.staleRenderObservation = { ...stale, posts }
    expect(stale.validBefore && stale.handlerEntered && stale.validations === 0).toBe(true)
    expect(posts).toBe(0)
    evidence.staleRenderRefused = true
    // A later EXPLICIT B submission proves that A did not merely hide or
    // discard B. The synthetic proof is refused by the real server as expected.
    await page.getByRole('textbox').fill('current@example.test')
    await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('input')?.getAttribute('aria-invalid') === 'true')
    expect(await page.evaluate(() => Reflect.get(window, '__ownedStaleControl').submittedB)).toBe(true)
    expect(posts).toBe(1)
    evidence.explicitBPreserved = true
    await arrive('b')
    await page.getByRole('textbox').fill('retained@example.test')
    await page.evaluate(() => {
      const clean = location.origin + '/auth/magic/confirm?lang=en', a = clean + '#token=' + 'A'.repeat(43)
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: clean, newURL: a }))
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: a, newURL: clean }))
    })
    expect(await page.getByRole('textbox').inputValue()).toBe('retained@example.test')
    evidence.delayedEventsDoNotResetB = true
    for (const kind of ['short', 'long', 'bits', 'encoded', 'padded', 'excess', 'section', 'a', 'a', 'b']) {
      await arrive(kind)
      const available = kind === 'a' || kind === 'b'
      if (available) await page.getByRole('textbox').waitFor()
      else await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor()
      const observed = await page.evaluate(() => ({ clean: location.hash === '', available: document.querySelector('input') !== null,
        empty: !document.querySelector('input') || document.querySelector<HTMLInputElement>('input')!.value === '' }))
      expect(observed).toEqual({ clean: true, available, empty: true })
      cases.push({ name: kind, ...observed })
      if (available) await page.getByRole('textbox').fill('old-intent@example.test')
    }
    evidence.forms = cases
    const beforeFallback = await page.evaluate(() => ({ history: history.length, router: Reflect.get(window, '__magicArrivalWitness').router }))
    evidence.matrixStage = 'hashchange-fallback'
    await page.evaluate(() => Reflect.get(window, '__ownedNativeArrival')())
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input')?.value === '')
    const fallback = await page.evaluate(() => ({ clean: location.hash === '', routerClean: window.__TSR_ROUTER__?.state.location.hash === '',
      opaquePreserved: history.state.ownedOpaqueMarker === 'retained', history: history.length, router: Reflect.get(window, '__magicArrivalWitness').router }))
    evidence.fallback = fallback
    expect(fallback.clean && fallback.routerClean && fallback.opaquePreserved && fallback.history === beforeFallback.history && fallback.router > beforeFallback.router).toBe(true)
    evidence.hashchangeFallback = true
    await page.getByRole('link', { name: 'Français', exact: true }).click()
    evidence.matrixStage = 'locale-reset'
    await page.getByRole('button', { name: 'Confirmer la connexion', exact: true }).waitFor()
    await arrive('a')
    await page.getByRole('status').filter({ hasText: 'Le lien de connexion a changé.' }).waitFor()
    expect(await page.getByRole('textbox').inputValue()).toBe('')
    expect(await page.title()).toBe('Confirmer la connexion')
    const final = await page.evaluate(() => Reflect.get(window, '__magicArrivalWitness'))
    expect(final.unsafeEvent || final.unsafeRouter || final.unsafeStorage || final.unsafeUnload).toBe(false)
    expect(posts).toBe(1); expect(documents).toBe(1)
    evidence.matrix = { ...final, documents, posts, localeReset: true }
  } finally { await browser.close() }
}

export async function assertCompiledMagicClearFailure(origin: string, context: () => Promise<BrowserContext>, evidence: Record<string, unknown>) {
  for (const mode of ['throw', 'noop'] as const) {
    const browser = await context()
    try {
      await browser.addInitScript(failure => {
        if (location.pathname === '/auth/magic/confirm') history.replaceState = () => { if (failure === 'throw') throw new Error('Controlled clear failure') }
      }, mode)
      const page = await browser.newPage(); page.setDefaultTimeout(8000)
      let posts = 0; page.on('request', request => { if (request.method() === 'POST') posts++ })
      await page.goto(origin + '/auth/magic/confirm?lang=en#token=' + 'A'.repeat(43))
      await page.getByRole('alert').filter({ hasText: 'This browser could not safely open this link.' }).waitFor()
      const result = await page.evaluate(() => ({ stillDirty: location.hash !== '', routerAbsent: window.__TSR_ROUTER__ === undefined, inputAbsent: document.querySelector('input') === null }))
      expect(result).toEqual({ stillDirty: true, routerAbsent: true, inputAbsent: true }); expect(posts).toBe(0)
      evidence[mode] = { ...result, posts }
    } finally { await browser.close() }
  }
}
