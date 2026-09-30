import { AxeBuilder } from '@axe-core/playwright'
import { expect } from 'vitest'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { authRpcPath } from './auth-rpc'

export async function assertCompiledPasskeyLogin(input: {
  origin: string
  page: Page
  context: BrowserContext
  cdp: CDPSession
  authenticatorId: string
  stores: { administrator: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }
  evidence: Record<string, unknown>
  setStage(value: string): void
  newContext(): Promise<BrowserContext>
  scanRuntime(values: string[]): boolean
  accountConsole(active: boolean, path: string): void
  accountConsoleSignals(): number
  selectClient(index: number): void
}) {
  const { origin, page, context, cdp, authenticatorId, stores, evidence, setStage, newContext, scanRuntime, selectClient } = input
  const beginPath = await authRpcPath('beginPasskeySignIn'), finishPath = await authRpcPath('finishPasskeySignIn')
  const getAccountPath = await authRpcPath('getAccount')
  let begins = 0, finishes = 0
  const sensitive = new Set<string>(), captures: Promise<void>[] = []
  let capturedBeginBodies = 0, capturedFinishBodies = 0, capturedCookie = false, captureFailures = 0
  const retainEncoded = (value: string) => { for (const match of value.matchAll(/[A-Za-z0-9_-]{32,}/g)) sensitive.add(match[0]) }
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === beginPath) begins++
    if (path === finishPath) {
      finishes++
      const body = request.postData()
      if (body) { capturedFinishBodies++; retainEncoded(body) } else captureFailures++
    }
  })
  page.on('response', response => {
    if (new URL(response.url()).pathname !== beginPath) return
    captures.push(response.text().then(text => { capturedBeginBodies++; retainEncoded(text) }, () => { captureFailures++ }))
  })
  const initial = (await stores.administrator.query(`SELECT u.id AS user_id,p.id AS key_id,p.counter
    FROM "user" u JOIN passkey p ON p.user_id=u.id`)).rows[0]
  expect(Boolean(initial?.user_id && initial.key_id)).toBe(true)
  async function navigateClient(path: string, heading: string) {
    await page.evaluate(target => {
      history.pushState(null, '', target)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, path)
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
  }
  const drainClient = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

  setStage('compiled passkey logout and anonymous account refusal')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.waitForURL(origin + '/login?lang=en')
  const consoleBefore = input.accountConsoleSignals()
  input.accountConsole(true, getAccountPath)
  const anonymousResponse = page.waitForResponse(response => new URL(response.url()).pathname === getAccountPath && response.status() === 401)
  let anonymousStatus = -1, anonymousResponseObserved = false
  try {
    anonymousStatus = await page.evaluate(async path => (await fetch(path, {
      headers: { 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true' },
    })).status, getAccountPath)
    await anonymousResponse; anonymousResponseObserved = true
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  } finally { input.accountConsole(false, getAccountPath) }
  const expectedConsoleSignals = input.accountConsoleSignals() - consoleBefore
  const anonymousSessionCookie = (await context.cookies()).some(cookie => cookie.name.includes('session_token'))
  evidence.passkeyAnonymousAccount = { status: anonymousStatus, observedResponses: anonymousResponseObserved ? 1 : 0,
    expectedConsoleSignals, sessionCookiePresent: anonymousSessionCookie }
  expect({ status: anonymousStatus, responseObserved: anonymousResponseObserved }).toEqual({ status: 401, responseObserved: true })
  expect(expectedConsoleSignals === 0 || expectedConsoleSignals === 1).toBe(true)
  expect(anonymousSessionCookie).toBe(false)

  setStage('single explicit passkey action and native browser assertion')
  selectClient(220)
  const action = page.getByRole('button', { name: 'Sign in with a passkey', exact: true })
  await expect.poll(() => action.isEnabled()).toBe(true)
  await action.click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  expect({ begins, finishes }).toEqual({ begins: 1, finishes: 1 })
  const admitted = (await stores.administrator.query(`SELECT u.id AS user_id,p.id AS key_id,p.counter,s.auth_state,s.auth_method,s.recovery_generation
    FROM "user" u JOIN passkey p ON p.user_id=u.id JOIN session s ON s.user_id=u.id`)).rows
  const nativeCredentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
  const credentialCount = nativeCredentials.credentials.length
  const nativeCounter = typeof nativeCredentials.credentials[0]?.signCount === 'number' ? nativeCredentials.credentials[0].signCount : -1
  const nativeResident = nativeCredentials.credentials[0]?.isResidentCredential === true
  const initialCounter = typeof initial.counter === 'number' ? initial.counter : -1
  const dbCounter = typeof admitted[0]?.counter === 'number' ? admitted[0].counter : -1
  const admission = { rowCount: admitted.length, sameUser: admitted[0]?.user_id === initial.user_id, sameKey: admitted[0]?.key_id === initial.key_id,
    active: admitted[0]?.auth_state === 'ACTIVE', passkey: admitted[0]?.auth_method === 'passkey', generation: admitted[0]?.recovery_generation === 0,
    credentialCount, initialCounter, dbCounter, deviceCounter: nativeCounter, resident: nativeResident,
    counterMatches: dbCounter === nativeCounter,
    validProgression: nativeCounter === 0 ? initialCounter === 0 && dbCounter === 0 : nativeCounter > initialCounter,
  }
  evidence.passkeyVirtualAuthenticator = admission
  expect({ rowCount: admission.rowCount, sameUser: admission.sameUser, sameKey: admission.sameKey, active: admission.active,
    passkey: admission.passkey, generation: admission.generation, credentialCount: admission.credentialCount, resident: admission.resident,
    counterMatches: admission.counterMatches, validProgression: admission.validProgression }).toEqual({
    rowCount: 1, sameUser: true, sameKey: true, active: true, passkey: true, generation: true,
    credentialCount: 1, resident: true, counterMatches: true, validProgression: true,
  })
  const acceptedCounter = dbCounter
  const sessionCookie = (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
  expect({ secure: sessionCookie?.secure, httpOnly: sessionCookie?.httpOnly, sameSite: sessionCookie?.sameSite }).toEqual({ secure: true, httpOnly: true, sameSite: 'Lax' })
  if (sessionCookie?.value) { capturedCookie = true; sensitive.add(sessionCookie.value); retainEncoded(sessionCookie.value) }
  await page.reload()
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  evidence.passkeyLoginReloadedSameUser = true

  setStage('duplicate suppression and native cancellation')
  selectClient(221)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.waitForURL(origin + '/login?lang=en')
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
  const beforeCancel = { begins, finishes }
  const cancellable = page.getByRole('button', { name: 'Sign in with a passkey', exact: true })
  await expect.poll(() => cancellable.isEnabled()).toBe(true)
  await cancellable.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
  await page.getByRole('button', { name: 'Cancel passkey sign-in', exact: true }).waitFor()
  expect({ begins: begins - beforeCancel.begins, finishes: finishes - beforeCancel.finishes }).toEqual({ begins: 1, finishes: 0 })
  await page.getByRole('button', { name: 'Cancel passkey sign-in', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Passkey sign-in was cancelled.' }).waitFor()
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
  expect((await stores.administrator.query('SELECT counter FROM passkey')).rows).toEqual([{ counter: acceptedCounter }])
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
  evidence.passkeyDuplicateAndCancellationQualified = true

  const asyncCases: unknown[] = []
  evidence.passkeyAsyncLifecycle = asyncCases

  setStage('late real options after panel leave')
  selectClient(222)
  await page.evaluate(path => {
    const nativeFetch = window.fetch
    const nativeGet = navigator.credentials.get
    let release: (() => void) | undefined, paused = false, finished = false, gets = 0, armed = true
    const gate = new Promise<void>(resolve => { release = resolve })
    navigator.credentials.get = options => { gets++; return nativeGet.call(navigator.credentials, options) }
    window.fetch = async (resource, init) => {
      const target = new URL(resource instanceof Request ? resource.url : String(resource), location.href).pathname
      if (!armed || target !== path) return nativeFetch(resource, init)
      armed = false
      const response = await nativeFetch(resource, init ? { ...init, signal: undefined } : init)
      paused = true; await gate; finished = true
      return response
    }
    Reflect.set(window, '__passkeyDeferred', { release: () => release?.(), restore: () => {
      window.fetch = nativeFetch; navigator.credentials.get = nativeGet
    }, state: () => ({ paused, finished, gets }) })
  }, beginPath)
  const optionsBefore = { begins, finishes }
  try {
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click()
    await page.waitForFunction(() => Reflect.get(window, '__passkeyDeferred').state().paused === true)
    await navigateClient('/missing?lang=en', 'Page not found')
    await page.evaluate(() => Reflect.get(window, '__passkeyDeferred').release())
    await page.waitForFunction(() => Reflect.get(window, '__passkeyDeferred').state().finished === true)
    await drainClient()
    const state = await page.evaluate(() => Reflect.get(window, '__passkeyDeferred').state())
    const effects = (await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions
    expect({ path: new URL(page.url()).pathname, begins: begins - optionsBefore.begins, finishes: finishes - optionsBefore.finishes,
      paused: state.paused, finished: state.finished, gets: state.gets, sessions: effects }).toEqual({
      path: '/missing', begins: 1, finishes: 0, paused: true, finished: true, gets: 0, sessions: 0,
    })
    asyncCases.push({ phase: 'options', leave: true, lateCeremonies: state.gets, automaticFinishes: 0, sessions: effects })
  } finally {
    await page.evaluate(() => { const state = Reflect.get(window, '__passkeyDeferred'); state?.release(); state?.restore() }).catch(() => {})
  }
  await navigateClient('/login?lang=en', 'Sign in')
  await expect.poll(() => page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).isEnabled()).toBe(true)

  setStage('late real assertion after panel leave')
  selectClient(223)
  await page.evaluate(() => {
    const nativeGet = navigator.credentials.get
    let release: (() => void) | undefined, paused = false, finished = false, assertions = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    navigator.credentials.get = async options => {
      const response = await nativeGet.call(navigator.credentials, options)
      assertions++; paused = true; await gate; finished = true
      return response
    }
    Reflect.set(window, '__passkeyDeferred', { release: () => release?.(), restore: () => { navigator.credentials.get = nativeGet },
      state: () => ({ paused, finished, assertions }) })
  })
  const assertionBefore = { begins, finishes }
  try {
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click()
    await page.waitForFunction(() => Reflect.get(window, '__passkeyDeferred').state().paused === true)
    await navigateClient('/missing?lang=en', 'Page not found')
    await page.evaluate(() => Reflect.get(window, '__passkeyDeferred').release())
    await page.waitForFunction(() => Reflect.get(window, '__passkeyDeferred').state().finished === true)
    await drainClient()
    const state = await page.evaluate(() => Reflect.get(window, '__passkeyDeferred').state())
    const effects = (await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions
    const counter = (await stores.administrator.query('SELECT counter FROM passkey')).rows[0].counter
    expect({ path: new URL(page.url()).pathname, begins: begins - assertionBefore.begins, finishes: finishes - assertionBefore.finishes,
      paused: state.paused, finished: state.finished, assertions: state.assertions, sessions: effects, counterUnchanged: counter === acceptedCounter }).toEqual({
      path: '/missing', begins: 1, finishes: 0, paused: true, finished: true, assertions: 1, sessions: 0, counterUnchanged: true,
    })
    asyncCases.push({ phase: 'assertion', leave: true, realAssertions: state.assertions, automaticFinishes: 0,
      sessions: effects, counterUnchanged: counter === acceptedCounter })
  } finally {
    await page.evaluate(() => { const state = Reflect.get(window, '__passkeyDeferred'); state?.release(); state?.restore() }).catch(() => {})
  }
  await navigateClient('/login?lang=en', 'Sign in')
  await expect.poll(() => page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).isEnabled()).toBe(true)

  setStage('pagehide cancellation and BFCache restore')
  selectClient(224)
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
  const beforeRestore = { begins, finishes }
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel passkey sign-in', exact: true }).waitFor()
  await page.goto(origin + '/login?lang=fr')
  await page.getByRole('heading', { name: 'Connexion', exact: true }).waitFor()
  await page.evaluate(() => history.back())
  await page.waitForFunction(() => location.pathname === '/login' && new URLSearchParams(location.search).get('lang') === 'en')
  const restoredAction = page.getByRole('button', { name: 'Sign in with a passkey', exact: true })
  await expect.poll(() => restoredAction.isEnabled()).toBe(true)
  const pendingRestore = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & {
      notRestoredReasons?: { children: unknown[]; reasons: { reason: string }[] | null } | null
    }) | undefined
    const reasons = navigation?.notRestoredReasons
    const allowed = new Set(['unload-listener', 'unload-handler', 'response-cache-control-no-store', 'related-active-contents',
      'web-authentication-request', 'masked'])
    return { persisted: Reflect.get(window, '__passkeyBfcacheRestored') === true, navigationType: navigation?.type,
      reasonObjectPresent: reasons != null, childCount: reasons?.children.length ?? 0,
      reasons: reasons?.reasons?.map(value => allowed.has(value.reason) ? value.reason : 'unclassified') ?? [] }
  })
  evidence.passkeyPendingRestore = pendingRestore
  expect({ begins: begins - beforeRestore.begins, finishes: finishes - beforeRestore.finishes }).toEqual({ begins: 1, finishes: 0 })
  expect((await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions).toBe(0)
  expect((await stores.administrator.query('SELECT counter FROM passkey')).rows).toEqual([{ counter: acceptedCounter }])
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
  evidence.passkeyPagehideCancellationQualified = true

  setStage('idle BFCache restore')
  await page.evaluate(() => { Reflect.set(window, '__passkeyBfcacheRestored', false) })
  await page.goto(origin + '/login?lang=fr')
  await page.getByRole('heading', { name: 'Connexion', exact: true }).waitFor()
  await page.evaluate(() => history.back())
  await page.waitForFunction(() => location.pathname === '/login' && new URLSearchParams(location.search).get('lang') === 'en')
  const idleAction = page.getByRole('button', { name: 'Sign in with a passkey', exact: true })
  await expect.poll(() => idleAction.isEnabled()).toBe(true)
  expect(await page.evaluate(() => Reflect.get(window, '__passkeyBfcacheRestored') === true)).toBe(true)
  evidence.passkeyIdleBfcacheQualified = true

  setStage('English and French keyboard and accessibility')
  async function checkAccessibility(actionName: string) {
    const action = page.getByRole('button', { name: actionName, exact: true })
    await expect.poll(() => action.isEnabled()).toBe(true)
    let keyboardReached = false
    for (let index = 0; index < 20 && !keyboardReached; index++) {
      await page.keyboard.press('Tab')
      keyboardReached = await action.evaluate(element => document.activeElement === element)
    }
    expect(keyboardReached).toBe(true)
    const analysis = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(analysis.violations).toEqual([])
    return { keyboardReached, violations: analysis.violations.length }
  }
  const english = await checkAccessibility('Sign in with a passkey')
  await page.goto(origin + '/login?lang=fr')
  const french = await checkAccessibility('Se connecter avec une passkey')
  evidence.passkeyAccessibility = { en: english, fr: french }

  setStage('helper import failure survives navigation restore')
  const publicRoot = resolve('.output/public')
  const files = await readdir(publicRoot, { recursive: true })
  const helperPaths: string[] = []
  for (const entry of files) {
    if (!entry.endsWith('.js')) continue
    const source = await readFile(resolve(publicRoot, entry), 'utf8')
    if (source.includes('startAuthentication() was not called correctly') && source.includes('browserSupportsWebAuthn')
      && source.includes('WebAuthnAbortService')) helperPaths.push('/' + relative(publicRoot, resolve(publicRoot, entry)).replaceAll('\\', '/'))
  }
  expect(helperPaths).toHaveLength(1)
  const failedContext = await newContext()
  let helperUnavailable = true
  try {
    await failedContext.addInitScript(() => {
      Object.defineProperty(window, '__passkeyBfcacheRestored', { value: false, writable: true })
      window.addEventListener('pageshow', event => { if (event.persisted) Reflect.set(window, '__passkeyBfcacheRestored', true) })
      const nativeGet = navigator.credentials.get; let gets = 0
      navigator.credentials.get = options => { gets++; return nativeGet.call(navigator.credentials, options) }
      Reflect.set(window, '__passkeyHelperRetry', () => ({ gets }))
    })
    await failedContext.route(origin + helperPaths[0], route => helperUnavailable ? route.abort() : route.continue())
    const failedPage = await failedContext.newPage()
    let expectedHelperFailures = 0, unexpectedHelperErrors = 0
    failedPage.on('requestfailed', request => {
      if (request.url() === origin + helperPaths[0]) expectedHelperFailures++
      else unexpectedHelperErrors++
    })
    failedPage.on('pageerror', () => { unexpectedHelperErrors++ })
    failedPage.on('console', message => {
      if (message.type() !== 'error') return
      if (message.location().url === origin + helperPaths[0]) expectedHelperFailures++
      else unexpectedHelperErrors++
    })
    failedPage.setDefaultTimeout(7000); failedPage.setDefaultNavigationTimeout(7000)
    await failedPage.goto(origin + '/login?lang=en')
    await failedPage.getByRole('alert').filter({ hasText: 'Passkey sign-in could not be prepared.' }).waitFor()
    await failedPage.goto(origin + '/login?lang=fr')
    await failedPage.getByRole('heading', { name: 'Connexion', exact: true }).waitFor()
    await failedPage.evaluate(() => history.back())
    await failedPage.waitForFunction(() => location.pathname === '/login' && new URLSearchParams(location.search).get('lang') === 'en')
    expect(await failedPage.evaluate(() => Reflect.get(window, '__passkeyBfcacheRestored') === true)).toBe(true)
    const retry = failedPage.getByRole('button', { name: 'Try preparing again', exact: true })
    await retry.waitFor()
    helperUnavailable = false
    await retry.click()
    const recovered = failedPage.getByRole('button', { name: 'Sign in with a passkey', exact: true })
    await expect.poll(() => recovered.isEnabled()).toBe(true)
    expect(await failedPage.evaluate(() => Reflect.get(window, '__passkeyHelperRetry')().gets)).toBe(0)
    expect(expectedHelperFailures > 0 && unexpectedHelperErrors === 0).toBe(true)
    evidence.passkeyHelperFailureSignals = { expected: expectedHelperFailures, unexpected: unexpectedHelperErrors }
    evidence.passkeyHelperFailureRestored = true
    evidence.passkeyHelperRetryQualified = true
  } finally { await failedContext.close() }

  setStage('controlled unsupported presentation')
  const unsupportedContext = await newContext()
  try {
    await unsupportedContext.addInitScript(() => {
      Reflect.set(globalThis, 'PublicKeyCredential', undefined)
      const nativeGet = navigator.credentials.get; let gets = 0
      navigator.credentials.get = options => { gets++; return nativeGet.call(navigator.credentials, options) }
      Reflect.set(window, '__passkeyUnsupported', () => ({ gets }))
    })
    const unsupportedPage = await unsupportedContext.newPage()
    let unsupportedErrors = 0
    unsupportedPage.on('pageerror', () => { unsupportedErrors++ })
    unsupportedPage.on('console', message => { if (message.type() === 'error') unsupportedErrors++ })
    unsupportedPage.setDefaultTimeout(7000); unsupportedPage.setDefaultNavigationTimeout(7000)
    await unsupportedPage.goto(origin + '/login?lang=en')
    await unsupportedPage.getByRole('alert').filter({ hasText: 'This browser cannot use a passkey here.' }).waitFor()
    const unsupportedAction = unsupportedPage.getByRole('button', { name: 'Sign in with a passkey', exact: true })
    expect(await unsupportedAction.isDisabled()).toBe(true)
    expect(await unsupportedPage.evaluate(() => Reflect.get(window, '__passkeyUnsupported')().gets)).toBe(0)
    expect(unsupportedErrors).toBe(0)
    evidence.passkeyUnsupportedControlled = { actionDisabled: true, ceremonyCalls: 0, unexpectedErrors: unsupportedErrors }
  } finally { await unsupportedContext.close() }

  setStage('late real finish after sent-finish cancellation')
  selectClient(225)
  await navigateClient('/login?lang=en', 'Sign in')
  await expect.poll(() => page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).isEnabled()).toBe(true)
  await page.evaluate(path => {
    const nativeFetch = window.fetch
    let release: (() => void) | undefined, paused = false, finished = false, armed = true
    const gate = new Promise<void>(resolve => { release = resolve })
    window.fetch = async (resource, init) => {
      const target = new URL(resource instanceof Request ? resource.url : String(resource), location.href).pathname
      if (!armed || target !== path) return nativeFetch(resource, init)
      armed = false
      const response = await nativeFetch(resource, init ? { ...init, signal: undefined } : init)
      paused = true; await gate; finished = true
      return response
    }
    Reflect.set(window, '__passkeyDeferred', { release: () => release?.(), restore: () => { window.fetch = nativeFetch },
      state: () => ({ paused, finished }) })
  }, finishPath)
  const finishBefore = { begins, finishes }
  try {
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click()
    await page.waitForFunction(() => Reflect.get(window, '__passkeyDeferred').state().paused === true)
    const committedSessions = (await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions
    expect(committedSessions).toBe(1)
    await page.getByRole('button', { name: 'Cancel passkey sign-in', exact: true }).click()
    const uncertain = page.getByRole('alert').filter({ hasText: 'The sign-in request was sent. Check whether your account opened before trying again' })
    await uncertain.waitFor()
    const afterCancel = { begins: begins - finishBefore.begins, finishes: finishes - finishBefore.finishes }
    await page.evaluate(() => Reflect.get(window, '__passkeyDeferred').release())
    await page.waitForFunction(() => Reflect.get(window, '__passkeyDeferred').state().finished === true)
    await drainClient()
    const state = await page.evaluate(() => Reflect.get(window, '__passkeyDeferred').state())
    const afterLate = { begins: begins - finishBefore.begins, finishes: finishes - finishBefore.finishes }
    expect({ path: new URL(page.url()).pathname, afterCancel, afterLate, paused: state.paused, finished: state.finished,
      uncertainVisible: await uncertain.isVisible(), sessions: (await stores.administrator.query('SELECT count(*)::int AS sessions FROM session')).rows[0].sessions }).toEqual({
      path: '/login', afterCancel: { begins: 1, finishes: 1 }, afterLate: { begins: 1, finishes: 1 },
      paused: true, finished: true, uncertainVisible: true, sessions: 1,
    })
    const lateCookie = (await context.cookies()).find(cookie => cookie.name === '__Secure-better-auth.session_token')
    if (lateCookie?.value) { sensitive.add(lateCookie.value); retainEncoded(lateCookie.value) }
    asyncCases.push({ phase: 'finish', cancelledAfterSend: true, lateNavigation: false, automaticResends: 0, committedSessions: 1 })
  } finally {
    await page.evaluate(() => { const state = Reflect.get(window, '__passkeyDeferred'); state?.release(); state?.restore() }).catch(() => {})
  }
  await Promise.all(captures)
  expect({ capturedBeginBodies, capturedFinishBodies, capturedCookie, captureFailures }).toEqual({
    capturedBeginBodies: begins, capturedFinishBodies: finishes, capturedCookie: true, captureFailures: 0,
  })
  const publicSurfaces = page.url() + '\n' + await page.content()
  const passkeyLeak = [...sensitive].some(value => publicSurfaces.includes(value)) || scanRuntime([...sensitive])
  expect(passkeyLeak).toBe(false)
  evidence.passkeySensitiveLeak = false
}
