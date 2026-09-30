import { expect } from 'vitest'
import { readdir } from 'node:fs/promises'
import type { BrowserContext } from 'playwright'
import type { startDisposableStores } from '../fixtures/db/disposable-stores'
import type { startMailHttpPeer } from '../fixtures/mail-http'

// Late helper completion must not restore A's options; native ceremony abort
// must not publish A's error or proceed to finalization after B arrives.
export async function assertMagicClientReplacement(input: {
  origin: string; stores: Awaited<ReturnType<typeof startDisposableStores>>
  peer: Awaited<ReturnType<typeof startMailHttpPeer>>; context(): Promise<BrowserContext>
  selectClient(index: number): void; setStage(value: string): void
  scan(value: string): void; evidence: Record<string, unknown>
  leaveOnly?: boolean
}) {
  const { origin, peer, stores } = input
  const chunks = (await readdir('.output/public/assets')).filter(name => /^esm-[A-Za-z0-9_-]+\.js$/.test(name))
  expect(chunks.length).toBe(1)
  const requester = await input.context(), request = await requester.newPage()
  request.setDefaultTimeout(8000)
  const cases: unknown[] = []; input.evidence.cases = cases
  let client = 180
  for (const mode of input.leaveOnly ? ['leave'] as const : ['helper', 'ceremony'] as const) {
    input.selectClient(client++)
    input.setStage('client replacement: ' + mode + ' setup')
    const context = await input.context(), email = `client-${mode}@example.test`
    await context.addInitScript(mode => {
      if (location.pathname !== '/auth/magic/confirm') return
      let started = false, ended = false, aborted = false, submittedB = false
      const nativeCreate = navigator.credentials.create.bind(navigator.credentials)
      navigator.credentials.create = options => {
        started = true
        options?.signal?.addEventListener('abort', () => {
          aborted = true
          if (mode === 'leave') sessionStorage.setItem('owned-magic-leave-aborted', 'true')
        }, { once: true })
        return nativeCreate(options).then(value => { ended = true; return value }, error => { ended = true; throw error })
      }
      const nativeFetch = window.fetch
      window.fetch = function (resource, init) {
        if (resource === '/auth/magic/consume' && typeof init?.body === 'string') {
          try { submittedB ||= JSON.parse(init.body).token === 'E'.repeat(43) } catch { /* Boolean only */ }
        }
        return nativeFetch.call(window, resource, init)
      }
      Reflect.set(window, '__clientReplacement', () => ({ started, ended, aborted, submittedB }))
    }, mode)
    const page = await context.newPage(); page.setDefaultTimeout(8000)
    let release: (() => void) | undefined, helperPaused = false, helperDelivered = false, finalPosts = 0, pageErrors = 0
    page.on('pageerror', error => { pageErrors++; input.scan(error.message) })
    page.on('console', message => input.scan(message.text()))
    page.on('request', request => { if (new URL(request.url()).pathname === '/auth/magic/enroll') finalPosts++ })
    if (mode === 'helper') await page.route(origin + '/assets/' + chunks[0], async route => {
      helperPaused = true
      await new Promise<void>(resolve => { release = resolve })
      try { await route.continue(); helperDelivered = true } catch { /* Context cleanup can cancel this owned static request. */ }
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: false } })
    try {
      await request.goto(origin + '/login?lang=en')
      await request.getByRole('textbox', { name: /^Email address/ }).fill(email)
      await request.getByRole('button', { name: 'Send a sign-in link', exact: true }).click()
      await request.getByRole('status').filter({ hasText: 'If this address can be used, a sign-in link has been requested.' }).waitFor()
      await expect.poll(() => peer.hasMailFor(email), { timeout: 35000 }).toBe(true)
      await page.goto(peer.mailboxUrl, { waitUntil: 'domcontentloaded' })
      await page.getByRole('textbox').fill(email)
      expect(await page.evaluate(() => Reflect.get(window, '__magicFirstRouterClean') === true && location.hash === '')).toBe(true)
      await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
      input.setStage('client replacement: ' + mode + ' pending')
      if (mode === 'helper') {
        await expect.poll(() => helperPaused).toBe(true)
        await page.getByRole('status').filter({ hasText: 'Preparing passkey creation…' }).waitFor()
        expect(await page.getByRole('button', { name: 'Create a passkey', exact: true }).count()).toBe(0)
      } else {
        await page.getByRole('button', { name: 'Create a passkey', exact: true }).click()
        await page.getByRole('button', { name: 'Cancel passkey creation', exact: true }).waitFor()
        expect(await page.evaluate(() => Reflect.get(window, '__clientReplacement')().started)).toBe(true)
      }
      if (mode === 'leave') {
        input.setStage('client leave: actual departure while native ceremony pending')
        await page.getByRole('link', { name: 'Request a new link', exact: true }).click()
        await page.getByRole('button', { name: 'Send a sign-in link', exact: true }).waitFor()
        const leave = await page.evaluate(() => ({ login: location.pathname === '/login', clean: location.hash === '',
          nativeAborted: sessionStorage.getItem('owned-magic-leave-aborted') === 'true' }))
        input.evidence.leave = { ...leave, finalPosts }
        expect(leave).toEqual({ login: true, clean: true, nativeAborted: true })
        expect(finalPosts).toBe(0)
        expect((await stores.administrator.query('SELECT (SELECT count(*) FROM "user")::int AS users,(SELECT count(*) FROM passkey)::int AS keys,(SELECT count(*) FROM session)::int AS sessions')).rows[0]).toEqual({ users: 0, keys: 0, sessions: 0 })
        input.setStage('client leave: ordinary back cannot resume the ceremony or proof')
        await page.goBack()
        await page.getByRole('alert').filter({ hasText: 'This link is missing or invalid.' }).waitFor()
        expect(await page.getByRole('textbox').count()).toBe(0)
        expect(await page.evaluate(() => location.hash === '')).toBe(true)
        expect(peer.containsProof(page.url()) || peer.containsProof(await page.content())).toBe(false)
        const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
        input.scan(storage); expect(peer.containsProof(storage)).toBe(false)
        expect(finalPosts).toBe(0); expect(pageErrors).toBe(0)
        cases.push({ mode, nativeAbortOnLeave: true, ordinaryBackMissing: true, finalPosts, identities: 0 })
        continue
      }
      input.setStage('client replacement: ' + mode + ' B arrival')
      await page.evaluate(() => {
        const anchor = document.createElement('a'); anchor.href = '/auth/magic/confirm?lang=en#token=' + 'E'.repeat(43)
        document.body.append(anchor); anchor.click(); anchor.remove()
      })
      input.setStage('client replacement: ' + mode + ' B form')
      await page.getByRole('textbox').waitFor()
      expect(await page.getByRole('textbox').inputValue()).toBe('')
      await page.getByRole('textbox').fill('new-intent@example.test')
      if (mode === 'helper') {
        input.setStage('client replacement: helper release')
        release!()
        await expect.poll(() => helperDelivered).toBe(true)
        // The fulfilled static resource must actually evaluate before checking
        // A's import continuation. A separate dynamic import reuses that module.
        input.setStage('client replacement: helper module evaluation')
        // A literal browser expression avoids Vitest's proven SSR rewrite of
        // import() inside serialized callbacks. This path is public and bounded
        // by the singleton filename predicate above, never a mail URL/proof.
        await page.evaluate(`(async () => { await import(${JSON.stringify('/assets/' + chunks[0])}) })()`)
      } else await page.waitForFunction(() => Reflect.get(window, '__clientReplacement')().ended)
      input.setStage('client replacement: ' + mode + ' B preserved')
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const observed = await page.evaluate(() => ({ clean: location.hash === '', sameRoute: location.pathname === '/auth/magic/confirm',
        intendedEmail: document.querySelector('input')?.value === 'new-intent@example.test', noOldAlert: document.querySelector('main [role="alert"]') === null,
        ...Reflect.get(window, '__clientReplacement')() }))
      input.evidence.activeCase = { mode, observed, finalPosts }
      expect(observed).toEqual({ clean: true, sameRoute: true, intendedEmail: true, noOldAlert: true,
        started: mode === 'ceremony', ended: mode === 'ceremony', aborted: mode === 'ceremony', submittedB: false })
      expect(await page.getByRole('button', { name: 'Create a passkey', exact: true }).count()).toBe(0)
      expect(finalPosts).toBe(0)
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [email])).rows[0].n).toBe(0)
      input.setStage('client replacement: ' + mode + ' explicit B proof')
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/magic/consume')
      await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click()
      expect((await response).status()).toBe(401)
      expect(await page.evaluate(() => Reflect.get(window, '__clientReplacement')().submittedB)).toBe(true)
      expect(peer.containsProof(page.url()) || peer.containsProof(await page.content())).toBe(false)
      expect(pageErrors).toBe(0)
      cases.push({ mode, preservedB: true, nativeAbort: mode === 'ceremony', finalPosts, explicitBConsumes: 1 })
    } finally { release?.(); await context.close() }
  }
  await requester.close()
}
