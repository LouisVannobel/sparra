import { expect } from 'vitest'
import { AxeBuilder } from '@axe-core/playwright'
import type { BrowserContext, Page } from 'playwright'
import type { startDisposableStores } from '../fixtures/db/disposable-stores'
import type { startMailHttpPeer } from '../fixtures/mail-http'

// Behavior assertions for the one compiled 8C browser-state consumer. Proof
// never leaves the mail peer/browser; this helper returns only safe evidence.
export async function qualifyMagicBrowserStates(input: {
  origin: string; runId: string; requestPath: string
  stores: Awaited<ReturnType<typeof startDisposableStores>>; peer: Awaited<ReturnType<typeof startMailHttpPeer>>
  context(): Promise<BrowserContext>; selectClient(index: number): void
  setStage(value: string): void; scan(value: string): void; evidence: Record<string, unknown>
}) {
  const { origin, stores, peer, requestPath, runId } = input
  const results = input.evidence, violations: { page: string; rule: string; impact: string | null; count: number }[] = []
  results.violations = violations
  let client = 100, pageExceptions = 0
  const requester = await input.context(), requestPage = await requester.newPage()
  const receiver = await input.context(), page = await receiver.newPage()
  function watch(target: Page) {
    target.setDefaultTimeout(8000); target.setDefaultNavigationTimeout(8000)
    target.on('pageerror', error => { pageExceptions++; input.scan(error.message) })
    target.on('console', event => input.scan(event.text()))
  }
  watch(requestPage); watch(page)
  async function a11y(target: Page, label: string) {
    expect(await target.evaluate(() => location.hash === '')).toBe(true)
    expect(await target.evaluate(() => document.title === document.querySelector('h1')?.textContent)).toBe(true)
    const initialHtml = await target.content()
    input.scan(initialHtml); input.scan(target.url())
    expect(peer.containsProof(target.url()) || peer.containsProof(initialHtml)).toBe(false)
    const analysis = await new AxeBuilder({ page: target }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    violations.push(...analysis.violations.map(value => ({ page: label, rule: value.id, impact: value.impact ?? null, count: value.nodes.length })))
    const contrastReview: unknown[] = []
    for (const rule of analysis.incomplete.filter(value => value.id === 'color-contrast')) for (const node of rule.nodes) {
      const selector = node.target[0]
      if (typeof selector !== 'string') throw new Error('Unexpected controlled contrast target')
      const measured = await target.locator(selector).evaluate(element => {
        const style = getComputedStyle(element), canvas = document.createElement('canvas')
        canvas.width = 1; canvas.height = 1
        const context = canvas.getContext('2d')!
        function rgba(color: string) { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data] }
        let backgroundElement: Element | null = element, background = rgba(style.backgroundColor)
        while (background[3] === 0 && backgroundElement?.parentElement) {
          backgroundElement = backgroundElement.parentElement; background = rgba(getComputedStyle(backgroundElement).backgroundColor)
        }
        const foreground = rgba(style.color)
        function luminance(color: number[]) { const [r, g, b] = color.slice(0, 3).map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 }); return .2126 * r + .7152 * g + .0722 * b }
        const fg = luminance(foreground), bg = luminance(background)
        return { tag: element.tagName.toLowerCase(), inputType: element instanceof HTMLInputElement ? element.type : null,
          requiredIndicator: element.tagName === 'SPAN' && element.parentElement?.tagName === 'LABEL' && element.querySelector('[aria-hidden="true"]') !== null,
          decorativeLabelSeparator: element.tagName === 'SPAN' && element.getAttribute('aria-hidden') === 'true' && element.textContent?.trim() === '∙' && element.closest('label') !== null,
          foreground: style.color, background: backgroundElement ? getComputedStyle(backgroundElement).backgroundColor : null,
          opaque: foreground[3] === 255 && background[3] === 255 && style.opacity === '1',
          ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), fontSize: style.fontSize, fontWeight: style.fontWeight }
      })
      contrastReview.push({ ...measured, causes: node.any.map(check => typeof check.data?.messageKey === 'string' ? check.data.messageKey : check.id) })
    }
    const fits = await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    expect(fits).toBe(true)
    expect(await target.evaluate(() => location.hash === '')).toBe(true)
    expect(peer.containsProof(target.url()) || peer.containsProof(await target.content())).toBe(false)
    await target.screenshot({ path: `.superpowers/sdd/2026-09-10-functional-auth/task-8c-evidence/${runId}-${label}.png`, fullPage: true })
    results[label] = { reflow320: fits, automatedRules: analysis.passes.length,
      incomplete: analysis.incomplete.map(value => ({ rule: value.id, impact: value.impact ?? null, count: value.nodes.length })), contrastReview }
  }
  async function requestMail(email: string, locale: 'en' | 'fr' = 'en') {
    input.selectClient(client++)
    await requestPage.goto(`${origin}/login?lang=${locale}`)
    await requestPage.getByRole('textbox', { name: locale === 'fr' ? /^Adresse e-mail/ : /^Email address/ }).fill(email)
    await requestPage.getByRole('button', { name: locale === 'fr' ? 'Demander un lien de connexion' : 'Send a sign-in link', exact: true }).click()
    await requestPage.getByRole('status').filter({ hasText: locale === 'fr'
      ? 'Si cette adresse peut être utilisée, un lien de connexion a été demandé.'
      : 'If this address can be used, a sign-in link has been requested.' }).waitFor()
    await expect.poll(() => peer.hasMailFor(email), { timeout: 35000 }).toBe(true)
  }
  async function openMail(target: Page) {
    const response = await target.goto(peer.mailboxUrl, { waitUntil: 'domcontentloaded' })
    await target.getByRole('textbox').waitFor()
    expect(await target.evaluate(() => Reflect.get(window, '__magicFirstRouterClean') === true && location.hash === '')).toBe(true)
    const headers = await response!.allHeaders()
    expect(headers['cache-control']).toBe('no-store'); expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['x-robots-tag']).toBe('noindex')
    expect(headers['content-security-policy'].includes("default-src 'none'") && headers['content-security-policy'].includes("connect-src 'self'") && headers['content-security-policy'].includes("frame-ancestors 'none'")).toBe(true)
    // Native scroll restoration legitimately uses sessionStorage. Inspect it
    // privately with the same precise digest detector as HTML; only a Boolean
    // can escape into assertions/receipts, never storage keys or values.
    const storage = await target.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    input.scan(storage); expect(peer.containsProof(storage)).toBe(false)
    input.scan(await target.content())
  }
  async function confirm(target: Page, email: string) {
    await target.getByRole('textbox').fill(email)
    await target.getByRole('button', { name: /^(Confirm sign-in|Confirmer la connexion)$/, exact: true }).click()
  }
  async function noIdentity(email: string) {
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [email])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT r.state FROM auth_email_request r WHERE r.email=$1', [email])).rows[0].state).toBe('active')
  }

  input.setStage('browser states: request validation and retry')
  await requestPage.goto(origin + '/login?lang=fr')
  await requestPage.getByRole('button', { name: 'Demander un lien de connexion', exact: true }).click()
  await requestPage.waitForFunction(() => document.querySelector('input')?.getAttribute('aria-invalid') === 'true')
  await requestPage.waitForFunction(() => [...document.querySelectorAll('[aria-live="assertive"]')].some(node => node.textContent?.includes('Saisissez une adresse e-mail valide.')))
  await a11y(requestPage, 'request-fr-error')
  await requestPage.getByRole('textbox').focus()
  expect(await requestPage.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle !== 'none')).toBe(true)
  await requestPage.keyboard.press('Tab')
  expect(await requestPage.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON')
  const boundEmail = 'states-bound@example.test'
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified,recovery_generation) VALUES ($1,$2,$3,true,0)', ['states-bound', 'States fixture', boundEmail])
  await requestPage.getByRole('textbox').fill(boundEmail)
  await requestPage.route('**' + requestPath, route => route.fulfill({ status: 503, headers: { 'x-tss-raw': 'true', 'content-type': 'text/plain' }, body: 'Service Unavailable' }))
  await requestPage.getByRole('button', { name: 'Demander un lien de connexion', exact: true }).click()
  await requestPage.getByRole('alert').filter({ hasText: 'La connexion est temporairement indisponible.' }).waitFor()
  expect(await requestPage.getByRole('button', { name: 'Demander un lien de connexion', exact: true }).isEnabled()).toBe(true)
  await requestPage.unroute('**' + requestPath)
  await requestMail(boundEmail, 'fr')
  results.requestRetry = true

  input.setStage('browser states: locale and intended email mismatch')
  await openMail(page)
  expect(await page.locator('html').getAttribute('lang')).toBe('fr')
  await a11y(page, 'confirm-fr')
  await page.getByRole('link', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).waitFor()
  await confirm(page, 'other@example.test')
  await page.waitForFunction(() => document.querySelector('input')?.getAttribute('aria-invalid') === 'true')
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(0)
  await a11y(page, 'confirm-en-refused')
  await confirm(page, boundEmail)
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  expect(await page.evaluate(() => location.pathname === '/account' && location.search === '?lang=en')).toBe(true)
  results.localeAndMismatchRetry = true

  input.setStage('browser states: ambient account conflict')
  const conflictEmail = 'states-conflict@example.test'
  input.setStage('browser states: conflict request')
  await requestMail(conflictEmail)
  results.conflictMailDelivered = true
  input.setStage('browser states: conflict mailbox open')
  await openMail(page)
  results.conflictMailOpened = true
  const conflictStatuses: number[] = []
  page.on('response', response => { if (new URL(response.url()).pathname === '/auth/magic/consume') conflictStatuses.push(response.status()) })
  input.setStage('browser states: conflict confirmation')
  await confirm(page, conflictEmail)
  try { await page.getByRole('alert').filter({ hasText: 'Sign out of the current account before using this link.' }).waitFor() }
  finally {
    results.conflictStatuses = conflictStatuses
    results.conflictUi = await page.evaluate(() => ({ conflict: document.body.textContent?.includes('Sign out of the current account before using this link.') === true,
      refused: document.body.textContent?.includes('The link or email could not be verified.') === true, sameRoute: location.pathname === '/auth/magic/confirm' }))
  }
  input.setStage('browser states: conflict absence of new identity')
  await noIdentity(conflictEmail)
  input.setStage('browser states: conflict accessibility')
  await a11y(page, 'confirm-conflict')
  input.setStage('browser states: original account preserved')
  await page.getByRole('link', { name: 'Go to the current account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  expect(await page.locator('dd').textContent()).toBe(boundEmail)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Send a sign-in link', exact: true }).waitFor()
  results.ambientConflictPreserved = true

  input.setStage('browser states: reload and actual leave/back')
  const abandonedEmail = 'states-abandoned@example.test'
  input.setStage('browser states: reload request')
  await requestMail(abandonedEmail)
  input.setStage('browser states: reload mailbox open')
  await openMail(page)
  input.setStage('browser states: actual reload')
  await page.reload()
  input.setStage('browser states: reload missing proof')
  try { await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor() }
  finally { results.reloadUi = await page.evaluate(() => ({ missing: document.body.textContent?.includes('This link is missing or invalid.') === true, inputPresent: document.querySelector('input') !== null, cleanUrl: location.hash === '' })) }
  input.setStage('browser states: reload no identity')
  await noIdentity(abandonedEmail)
  results.reloadNoProof = true
  input.setStage('browser states: fresh request after reload')
  await requestMail(abandonedEmail)
  input.setStage('browser states: fresh mailbox after reload')
  await openMail(page)
  input.setStage('browser states: explicit leave')
  await page.getByRole('link', { name: 'Request a new link', exact: true }).click()
  await page.getByRole('button', { name: 'Send a sign-in link', exact: true }).waitFor()
  input.setStage('browser states: actual back')
  await page.goBack()
  input.setStage('browser states: back missing proof')
  try { await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor() }
  finally { results.backUi = await page.evaluate(() => ({ missing: document.body.textContent?.includes('This link is missing or invalid.') === true, inputPresent: document.querySelector('input') !== null, cleanUrl: location.hash === '' })) }
  await noIdentity(abandonedEmail)
  results.backNoProof = true
  input.setStage('browser states: malformed fragment')
  await page.goto(origin + '/auth/magic/confirm?lang=en#token=malformed')
  await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor()
  expect(await page.evaluate(() => location.hash === '')).toBe(true)
  await a11y(page, 'confirm-missing')
  input.setStage('browser states: unrelated anchor')
  await page.goto(origin + '/login?lang=en#unrelated')
  expect(await page.evaluate(() => location.hash === '#unrelated')).toBe(true)
  results.reloadBackMalformed = true

  input.setStage('browser states: unsupported WebAuthn')
  const unsupported = await input.context()
  await unsupported.addInitScript(() => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined }) })
  const unsupportedPage = await unsupported.newPage(); watch(unsupportedPage)
  const unsupportedEmail = 'states-unsupported@example.test'
  await requestMail(unsupportedEmail); await openMail(unsupportedPage); await confirm(unsupportedPage, unsupportedEmail)
  await unsupportedPage.getByRole('alert').filter({ hasText: 'This browser cannot create a passkey here.' }).waitFor()
  await noIdentity(unsupportedEmail)
  await a11y(unsupportedPage, 'enrollment-unsupported')
  await unsupported.close(); results.unsupported = true

  input.setStage('browser states: native ceremony cancel and retry')
  const ceremonyContext = await input.context(), ceremonyPage = await ceremonyContext.newPage(); watch(ceremonyPage)
  const cdp = await ceremonyContext.newCDPSession(ceremonyPage)
  await cdp.send('WebAuthn.enable')
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: false } })
  const ceremonyEmail = 'states-ceremony@example.test'
  await requestMail(ceremonyEmail); await openMail(ceremonyPage); await confirm(ceremonyPage, ceremonyEmail)
  await ceremonyPage.getByRole('button', { name: 'Create a passkey', exact: true }).waitFor()
  await a11y(ceremonyPage, 'enrollment-ready')
  await ceremonyPage.getByRole('button', { name: 'Create a passkey', exact: true }).dblclick()
  await ceremonyPage.getByRole('button', { name: 'Cancel passkey creation', exact: true }).click()
  await ceremonyPage.getByRole('alert').filter({ hasText: 'Passkey creation was cancelled.' }).waitFor()
  await noIdentity(ceremonyEmail)
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: authenticator.authenticatorId, enabled: true })
  await ceremonyPage.getByRole('button', { name: 'Create a passkey', exact: true }).click()
  await ceremonyPage.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  results.nativeCancelRetry = true

  input.setStage('browser states: native crypto finalization refusal')
  const refusedContext = await input.context()
  // Mutate only the ceremony's clientData inside the browser. The original
  // proof remains within the browser POST body, never in driver arguments.
  await refusedContext.addInitScript(() => {
    const original = window.fetch
    window.fetch = function (resource, init) {
      if (resource === '/auth/magic/enroll' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body)
        const data = JSON.parse(atob(body.response.response.clientDataJSON.replace(/-/g, '+').replace(/_/g, '/')))
        data.origin = 'https://wrong.example.test'
        body.response.response.clientDataJSON = btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        return original.call(window, resource, { ...init, body: JSON.stringify(body) })
      }
      return original.call(window, resource, init)
    }
  })
  const refusedPage = await refusedContext.newPage(); watch(refusedPage)
  const refusedCdp = await refusedContext.newCDPSession(refusedPage)
  await refusedCdp.send('WebAuthn.enable')
  await refusedCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  const refusedEmail = 'states-final-refused@example.test'
  await requestMail(refusedEmail); await openMail(refusedPage); await confirm(refusedPage, refusedEmail)
  let finalPosts = 0, finalStatus = 0
  refusedPage.on('request', request => { if (new URL(request.url()).pathname === '/auth/magic/enroll') finalPosts++ })
  refusedPage.on('response', response => { if (new URL(response.url()).pathname === '/auth/magic/enroll') finalStatus = response.status() })
  await refusedPage.getByRole('button', { name: 'Create a passkey', exact: true }).click()
  await refusedPage.getByRole('alert').filter({ hasText: 'Sign-in could not be completed. Request a new link before trying again.' }).waitFor()
  await noIdentity(refusedEmail)
  expect(finalStatus).toBe(500); expect(finalPosts).toBe(1)
  expect(await refusedPage.getByRole('button', { name: 'Create a passkey', exact: true }).count()).toBe(0)
  await a11y(refusedPage, 'enrollment-native-refused')
  results.nativeFinalRefusal = { status: finalStatus, posts: finalPosts }

  input.setStage('browser states: accessibility results')
  expect(pageExceptions).toBe(0)
  results.pageExceptions = pageExceptions; results.violations = violations
  // The only diagnostic returned is rule/impact/count; no node HTML/URL.
  return results
}
