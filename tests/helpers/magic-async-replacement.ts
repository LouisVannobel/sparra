import { expect } from 'vitest'
import type { BrowserContext } from 'playwright'
import type { startDisposableStores } from '../fixtures/db/disposable-stores'
import type { startMailHttpPeer } from '../fixtures/mail-http'

// Removing a post-await revision guard lets A replace B's form/options/proof
// or navigate away. Only delivery timing/one unsuccessful JSON DTO is doubled;
// actual compiled worker, native consume, CTAP2 and final commit stay real.
export async function assertMagicAsyncReplacement(input: {
  origin: string
  stores: Awaited<ReturnType<typeof startDisposableStores>>
  peer: Awaited<ReturnType<typeof startMailHttpPeer>>
  context(): Promise<BrowserContext>; selectClient(index: number): void
  setStage(value: string): void; scan(value: string): void; evidence: Record<string, unknown>
}) {
  const { origin, stores, peer } = input
  const requester = await input.context(), requestPage = await requester.newPage()
  requestPage.setDefaultTimeout(8000)
  const outcomes: unknown[] = []; input.evidence.cases = outcomes
  let client = 160
  for (const mode of ['consume', 'final-json-success', 'final-json-false'] as const) {
    input.selectClient(client++)
    input.setStage('async replacement: ' + mode + ' setup')
    const email = `${mode}@example.test`, context = await input.context()
    await context.addInitScript(mode => {
      let release: (() => void) | undefined, paused = false, finished = false, armed = true
      let submittedB = false, consume = 0, enroll = 0
      const nativeFetch = window.fetch
      const gate = () => new Promise<void>(resolve => { paused = true; release = resolve })
      Reflect.set(window, '__asyncReplacement', {
        release: () => release?.(),
        state: () => ({ paused, finished, submittedB, consume, enroll }),
      })
      window.fetch = async function (resource, init) {
        if (resource === '/auth/magic/consume') {
          consume++
          if (typeof init?.body === 'string') {
            try { submittedB ||= JSON.parse(init.body).token === 'E'.repeat(43) } catch { /* Boolean only */ }
          }
        }
        if (resource === '/auth/magic/enroll') enroll++
        const target = armed && resource === (mode === 'consume' ? '/auth/magic/consume' : '/auth/magic/enroll')
        if (!target) return nativeFetch.call(window, resource, init)
        armed = false
        // Controlled transport ignores cancellation: prove the revision guard,
        // not that AbortController alone happened to suppress a completion.
        const response = await nativeFetch.call(window, resource, { ...init, signal: undefined })
        if (mode === 'consume') {
          await gate(); finished = true; return response
        }
        const nativeJson = response.json.bind(response)
        response.json = async () => {
          const result = await nativeJson()
          await gate(); finished = true
          // Native enrollment already committed; this models an unsuccessful
          // result DTO, not a failed/rolled-back server enrollment.
          return mode === 'final-json-false' ? { authenticated: false } : result
        }
        return response
      }
    }, mode)
    const page = await context.newPage(); page.setDefaultTimeout(8000)
    let pageErrors = 0
    page.on('pageerror', error => { pageErrors++; input.scan(error.message) })
    page.on('console', message => input.scan(message.text()))
    const cdp = await context.newCDPSession(page)
    if (mode !== 'consume') {
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
    }
    await requestPage.goto(origin + '/login?lang=en')
    await requestPage.getByRole('textbox', { name: /^Email address/ }).fill(email)
    await requestPage.getByRole('button', { name: 'Send a sign-in link', exact: true }).click()
    await requestPage.getByRole('status').filter({ hasText: 'If this address can be used, a sign-in link has been requested.' }).waitFor()
    await expect.poll(() => peer.hasMailFor(email), { timeout: 35000 }).toBe(true)
    await page.goto(peer.mailboxUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('textbox', { name: /^Email address/ }).waitFor()
    expect(await page.evaluate(() => Reflect.get(window, '__magicFirstRouterClean') === true && location.hash === '')).toBe(true)
    expect(peer.containsProof(await page.content())).toBe(false)
    input.setStage('async replacement: ' + mode + ' pause')
    await page.getByRole('textbox').fill(email)
    await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
    if (mode !== 'consume') await page.getByRole('button', { name: 'Create a passkey', exact: true }).click()
    await page.waitForFunction(() => Reflect.get(window, '__asyncReplacement').state().paused === true)
    const identities = (await stores.administrator.query('SELECT (SELECT count(*) FROM "user" WHERE email=$1)::int AS users,(SELECT count(*) FROM session s JOIN "user" u ON s.user_id=u.id WHERE u.email=$1)::int AS sessions', [email])).rows[0]
    expect(identities).toEqual(mode === 'consume' ? { users: 0, sessions: 0 } : { users: 1, sessions: 1 })
    input.setStage('async replacement: ' + mode + ' arrival B')
    await page.evaluate(() => {
      const anchor = document.createElement('a')
      anchor.href = '/auth/magic/confirm?lang=en#token=' + 'E'.repeat(43)
      document.body.append(anchor); anchor.click(); anchor.remove()
    })
    await page.getByRole('textbox').waitFor()
    expect(await page.getByRole('textbox').inputValue()).toBe('')
    await page.getByRole('textbox').fill('new-intent@example.test')
    const before = await page.evaluate(() => Reflect.get(window, '__asyncReplacement').state())
    input.evidence.activeCase = { mode, identities, before }
    input.setStage('async replacement: ' + mode + ' late A completion')
    await page.evaluate(() => Reflect.get(window, '__asyncReplacement').release())
    await page.waitForFunction(() => Reflect.get(window, '__asyncReplacement').state().finished === true)
    // Drain the promise continuation and ensuing React update before sampling.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const preserved = await page.evaluate(() => ({
      clean: location.hash === '', sameRoute: location.pathname === '/auth/magic/confirm',
      intendedEmail: document.querySelector('input')?.value === 'new-intent@example.test',
      noOldAlert: document.querySelector('main [role="alert"]') === null,
      ...Reflect.get(window, '__asyncReplacement').state(),
    }))
    input.evidence.activeCase = { mode, identities, before, preserved }
    expect(preserved).toEqual({ clean: true, sameRoute: true, intendedEmail: true, noOldAlert: true,
      paused: true, finished: true, submittedB: false, consume: 1, enroll: mode === 'consume' ? 0 : 1 })
    expect(await page.getByRole('button', { name: 'Create a passkey', exact: true }).count()).toBe(0)
    input.setStage('async replacement: ' + mode + ' explicit B proof')
    const bResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/magic/consume')
    await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
    const bStatus = (await bResponse).status()
    expect(bStatus).toBe(401)
    expect(await page.evaluate(() => Reflect.get(window, '__asyncReplacement').state().submittedB === true)).toBe(true)
    expect(peer.containsProof(page.url()) || peer.containsProof(await page.content())).toBe(false)
    input.scan(await page.content())
    expect(pageErrors).toBe(0)
    outcomes.push({ mode, identities, lateCompletionPreservedB: true, automaticConsumes: 0, explicitBConsumes: 1, bStatus })
    await context.close()
  }
  await requester.close()
}
