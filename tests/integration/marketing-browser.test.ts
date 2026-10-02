import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { magicMessages, messages } from '../../src/ui/auth/messages'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, app: ReturnType<typeof startWeb>, browser: Browser
let proxy: ReturnType<typeof createServer>, origin: string
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  const port = await unusedLoopbackPort(); origin = `http://localhost:${port}`
  app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: stores.runtimeUrl, REDIS_URL: stores.redisUrl,
    RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'marketing-browser', TRUSTED_PROXY_IPS: '127.0.0.2',
    AUTH_SECRET: randomBytes(48).toString('hex'), REQUEST_TIMEOUT_MS: '10000' })
  const upstream = (await bounded(app.ready)).port
  proxy = createServer((incoming, outgoing) => {
    const call = httpRequest({ hostname: '127.0.0.1', port: upstream, method: incoming.method, path: incoming.url,
      localAddress: '127.0.0.2', headers: { ...incoming.headers, 'x-real-ip': incoming.socket.remoteAddress } }, response => {
      outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing)
    })
    call.on('error', () => { outgoing.writeHead(502); outgoing.end() }); incoming.pipe(call)
  })
  await new Promise<void>(done => proxy.listen(port, '127.0.0.1', done))
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => browser?.close(), () => proxy && new Promise(done => proxy.close(done)), () => app?.cleanup(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Marketing browser cleanup failed')
})
async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  return page
}
async function media(page: Page) {
  return page.locator('#demo audio').evaluate((audio: HTMLAudioElement) => ({ paused: audio.paused, time: audio.currentTime, src: audio.currentSrc || audio.src }))
}

type MediaState = {
  ms: number; paused: boolean; time: number | null; duration: number | null
  readyState: number; networkState: number; errorCode: number | null
  src: string; currentSrc: string; connected: boolean; active: boolean; activated: boolean
}
type MediaPlay = {
  outcome: 'pending' | 'resolved' | 'rejected' | 'threw'
  errorName: 'AbortError' | 'NotAllowedError' | 'NotSupportedError' | 'InvalidStateError' | 'SecurityError' | 'other' | null
}
type MediaRequest = {
  path: string; range: string | null; status: number | null; completion: 'pending' | 'finished' | 'failed'
  contentType?: string | null; contentLength?: string | null; contentRange?: string | null
  acceptRanges?: string | null; contentEncoding?: string | null; failure?: string | null
}
declare global {
  interface Window {
    __sparraDemoMedia?: {
      events: (MediaState & { event: string })[]; plays: MediaPlay[]; droppedEvents: number; droppedPlays: number
      snapshot: () => MediaState | null
    }
  }
}

// Observe the original first playback attempt without prefetching or changing its promise.
async function observeDemoMedia(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const paths = new Set(['/demos/garage-revision.mp3', '/demos/controle-technique.mp3'])
    const path = (value: string) => {
      if (!value) return ''
      try { const url = new URL(value, location.href); return url.origin === location.origin && paths.has(url.pathname) && !url.search && !url.hash ? url.pathname : 'other' }
      catch { return 'other' }
    }
    const started = performance.now()
    const finite = (value: number) => Number.isFinite(value) ? value : null
    const state = (audio: HTMLMediaElement) => ({
      ms: Math.round(performance.now() - started), paused: audio.paused, time: finite(audio.currentTime), duration: finite(audio.duration),
      readyState: audio.readyState, networkState: audio.networkState, errorCode: audio.error?.code ?? null,
      src: path(audio.getAttribute('src') ?? ''), currentSrc: path(audio.currentSrc), connected: audio.isConnected,
      active: navigator.userActivation.isActive, activated: navigator.userActivation.hasBeenActive,
    })
    const evidence: NonNullable<Window['__sparraDemoMedia']> = {
      events: [], plays: [], droppedEvents: 0, droppedPlays: 0,
      snapshot: () => { const audio = document.querySelector<HTMLAudioElement>('#demo audio'); return audio ? state(audio) : null },
    }
    window.__sparraDemoMedia = evidence
    const record = (event: string, audio: HTMLMediaElement) => {
      if (evidence.events.length < 64) evidence.events.push({ event, ...state(audio) })
      else evidence.droppedEvents++
    }
    for (const event of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'pause', 'abort', 'emptied', 'error', 'ended']) {
      document.addEventListener(event, event => {
        if (event.target instanceof HTMLMediaElement && event.target.matches('#demo audio')) record(event.type, event.target)
      }, true)
    }
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element) || !event.target.closest('#demo .sparra-player-actions button')) return
      const audio = document.querySelector<HTMLAudioElement>('#demo audio')
      if (audio) record(event.isTrusted ? 'trusted-control-click' : 'control-click', audio)
    }, true)
    const errorName = (error: unknown) => {
      const name = error instanceof Error || error instanceof DOMException ? error.name : ''
      return (['AbortError', 'NotAllowedError', 'NotSupportedError', 'InvalidStateError', 'SecurityError'] as const).find(value => value === name) ?? 'other'
    }
    const nativePlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!this.matches('#demo audio')) return nativePlay.call(this)
      record('play-called', this)
      const attempt: MediaPlay = { outcome: 'pending', errorName: null }
      if (evidence.plays.length < 16) evidence.plays.push(attempt)
      else evidence.droppedPlays++
      try {
        const promise = nativePlay.call(this)
        void promise.then(() => { attempt.outcome = 'resolved' }, error => { attempt.outcome = 'rejected'; attempt.errorName = errorName(error) })
        return promise
      } catch (error) {
        attempt.outcome = 'threw'; attempt.errorName = errorName(error)
        throw error
      }
    }
  })
  const requests = new Map<import('playwright').Request, MediaRequest>()
  let droppedRequests = 0
  const safe = (value: string | undefined, pattern: RegExp) => value === undefined ? null : value.length <= 96 && pattern.test(value) ? value : 'other'
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !['/demos/garage-revision.mp3', '/demos/controle-technique.mp3'].includes(url.pathname) || url.search || url.hash) return
    if (requests.size >= 16) { droppedRequests++; return }
    requests.set(request, { path: url.pathname, range: safe(request.headers().range, /^bytes=\d*-\d*$/), status: null, completion: 'pending' })
  })
  page.on('response', response => {
    const row = requests.get(response.request())
    if (!row) return
    const headers = response.headers()
    Object.assign(row, {
      status: response.status(), contentType: safe(headers['content-type'], /^(?:audio\/(?:mpeg|mp3)|application\/octet-stream)$/i),
      contentLength: safe(headers['content-length'], /^\d+$/), contentRange: safe(headers['content-range'], /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/),
      acceptRanges: safe(headers['accept-ranges'], /^(?:bytes|none)$/), contentEncoding: safe(headers['content-encoding'], /^(?:identity|gzip|br|deflate)$/),
    })
  })
  page.on('requestfinished', request => { const row = requests.get(request); if (row) row.completion = 'finished' })
  page.on('requestfailed', request => {
    const row = requests.get(request)
    if (!row) return
    row.completion = 'failed'
    row.failure = safe(request.failure()?.errorText, /^net::ERR_(?:ABORTED|FAILED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|CONTENT_LENGTH_MISMATCH|EMPTY_RESPONSE|TIMED_OUT)$/)
  })
  return async () => {
    const media = await page.evaluate(() => {
      const evidence = window.__sparraDemoMedia
      return evidence ? { events: evidence.events, plays: evidence.plays, droppedEvents: evidence.droppedEvents, droppedPlays: evidence.droppedPlays,
        final: evidence.snapshot(), alert: document.querySelector('#demo [role="alert"]') !== null } : null
    })
    const diagnostic = JSON.stringify({ media, requests: [...requests.values()], droppedRequests })
    console.error('MARKETING_MEDIA_DIAGNOSTIC ' + (diagnostic.length <= 32768 ? diagnostic : '{"diagnostic":"size-bound-exceeded"}'))
  }
}

test.each(['fr', 'en'] as const)('missing email proof and unknown route have translated recovery, titles and accessible layout in %s', async locale => {
  const page = await openPage()
  try {
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${origin}/auth/magic/confirm?lang=${locale}`)
      await page.getByRole('heading', { name: magicMessages[locale].confirm, exact: true }).waitFor()
      await page.getByRole('alert').filter({ hasText: magicMessages[locale].missing }).waitFor()
      expect(await page.getByRole('link', { name: 'sparra', exact: true }).getAttribute('href')).toBe('/')
      expect(await page.getByRole('link', { name: magicMessages[locale].newLink, exact: true }).getAttribute('href')).toBe(`/login?lang=${locale}`)
      expect(await page.title()).toBe(magicMessages[locale].confirm)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
      const response = await page.goto(`${origin}/missing-screen?lang=${locale}`)
      expect(response?.status()).toBe(404)
      await page.getByRole('heading', { name: messages[locale].notFound, exact: true }).waitFor()
      expect(await page.getByRole('link', { name: 'sparra', exact: true }).getAttribute('href')).toBe('/')
      expect(await page.title()).not.toBe('')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
    }
  } finally { await page.context().close() }
}, 30000)

test('no autoplay; real play, pause, restart and arrows keep audio, transcript and receipt paired', async () => {
  const page = await openPage()
  let reportMedia: (() => Promise<void>) | undefined
  try {
    reportMedia = await observeDemoMedia(page)
    await page.goto(origin); await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).waitFor()
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect(await page.locator('#demo audio').getAttribute('autoplay')).toBe(null)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.currentTime > .2)
    expect(await page.locator('#demo [aria-current="true"]').count()).toBe(1)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    expect((await media(page)).paused).toBe(true)
    expect((await media(page)).time).toBeGreaterThan(.2)
    await page.locator('#demo audio').evaluate((audio: HTMLAudioElement) => { audio.currentTime = 4 })
    const pausedTime = (await media(page)).time
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    expect((await media(page)).time).toBeGreaterThanOrEqual(pausedTime)
    await page.waitForFunction(time => document.querySelector<HTMLAudioElement>('#demo audio')!.currentTime > time, pausedTime)
    expect((await media(page)).time).toBeGreaterThan(pausedTime)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Recommencer', exact: true }).click()
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    await page.getByRole('radio', { name: 'Garage', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    expect(await page.getByRole('radio', { name: 'Contrôle technique', exact: true }).getAttribute('aria-checked')).toBe('true')
    expect((await media(page)).src).toContain('/demos/controle-technique.mp3')
    expect(await page.locator('#demo .sparra-transcript').textContent()).toContain('visite de contrôle technique')
    expect(await page.locator('#demo .sparra-receipt').textContent()).toContain('visite de contrôle technique')
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect(await page.getByRole('radio', { name: 'Contrôle technique', exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    await mkdir('.output/test-evidence/marketing', { recursive: true })
    await page.screenshot({ path: '.output/test-evidence/marketing/demo-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 320, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: '.output/test-evidence/marketing/demo-mobile.png', fullPage: true })
  } catch (error) {
    try { await reportMedia?.() } catch { console.error('MARKETING_MEDIA_DIAGNOSTIC {"diagnostic":"unavailable"}') }
    throw error
  } finally { await page.context().close() }
}, 30000)

test('a real audio failure is announced and leaves text and receipt available', async () => {
  const page = await openPage()
  try {
    await page.route('**/demos/*.mp3', route => route.fulfill({ status: 404, body: 'Missing audio' }))
    await page.goto(origin)
    const play = page.getByRole('button', { name: 'Écouter l’exemple', exact: true })
    await play.focus(); await page.keyboard.press('Enter')
    await page.locator('#demo [role="alert"]').waitFor()
    expect(await play.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.locator('#demo .sparra-transcript').textContent()).toContain('révision')
    expect(await page.locator('#demo .sparra-receipt').textContent()).toContain('révision')
    expect((await media(page)).paused).toBe(true)
  } finally { await page.context().close() }
})

test('advertised retry refetches a failed resource and plays it when it becomes available', async () => {
  const page = await openPage()
  let available = false, requests = 0
  try {
    await page.route('**/demos/garage-revision.mp3', route => {
      requests++
      return available ? route.continue() : route.fulfill({ status: 404, body: 'Missing audio' })
    })
    await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.locator('#demo [role="alert"]').waitFor()
    const failedRequests = requests
    expect(failedRequests).toBeGreaterThan(0)
    available = true
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await expect.poll(() => requests, { timeout: 6000 }).toBeGreaterThan(failedRequests)
    await page.waitForFunction(() => {
      const audio = document.querySelector<HTMLAudioElement>('#demo audio')!
      return !audio.paused && audio.currentTime > .2 && audio.error === null
    }, undefined, { timeout: 6000 })
    expect(requests).toBeGreaterThan(failedRequests)
    expect(await page.locator('#demo [role="alert"]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Pause', exact: true }).count()).toBe(1)
    expect(await page.locator('#demo .sparra-transcript').textContent()).toContain('révision')
    expect(await page.locator('#demo .sparra-receipt').textContent()).toContain('révision')
  } finally { await page.context().close() }
})

test('late canceled play cannot affect the next sector', async () => {
  const page = await openPage()
  let release = () => {}
  const held = new Promise<void>(done => { release = done })
  try {
    await page.route('**/demos/garage-revision.mp3', async route => { await held; await route.continue().catch(() => {}) })
    await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.getByRole('radio', { name: 'Contrôle technique', exact: true }).click()
    release()
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.readyState >= 1)
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect((await media(page)).src).toContain('controle-technique.mp3')
    expect(await page.locator('#demo [role="alert"]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).count()).toBe(1)
  } finally { release(); await page.context().close() }
})

test.each(['Pause', 'Recommencer'])('canceling pending playback with %s stays paused without a false error', async action => {
  const page = await openPage()
  let release = () => {}
  const held = new Promise<void>(done => { release = done })
  try {
    await page.route('**/demos/garage-revision.mp3', async route => { await held; await route.continue().catch(() => {}) })
    await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.getByRole('button', { name: action, exact: true }).click()
    release()
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.readyState >= 1)
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect(await page.locator('#demo [role="alert"]').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).count()).toBe(1)
  } finally { release(); await page.context().close() }
})

test('an uncanceled native AbortError from the current media is announced', async () => {
  const page = await openPage()
  let release = () => {}
  const held = new Promise<void>(done => { release = done })
  try {
    await page.route('**/demos/garage-revision.mp3', async route => { await held; await route.continue().catch(() => {}) })
    await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    // An interruption outside the player's cancellation actions rejects the real play promise.
    await page.locator('#demo audio').evaluate((audio: HTMLAudioElement) => audio.pause())
    await page.locator('#demo [role="alert"]').waitFor()
    expect(await page.locator('#demo .sparra-transcript').textContent()).toContain('révision')
    expect((await media(page)).paused).toBe(true)
  } finally { release(); await page.context().close() }
})

test('leaving the demo stops its media', async () => {
  const page = await openPage()
  try {
    await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.currentTime > .2)
    const previous = await page.locator('#demo audio').elementHandle()
    // A same-document history transition keeps the old node inspectable.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/login')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForURL(origin + '/login')
    await page.getByRole('heading', { name: 'Connexion', exact: true }).waitFor()
    expect(await page.locator('#demo audio').count()).toBe(0)
    expect(await previous!.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
    await previous?.dispose()
  } finally { await page.context().close() }
})

test('compiled page keeps styles, CSP nonce, keyboard focus, accessible names and zero external requests', async () => {
  const page = await openPage()
  const external: string[] = [], errors: string[] = [], cspViolations: string[] = []
  page.on('request', request => { if (new URL(request.url()).origin !== origin) external.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.text().startsWith('CSP_VIOLATION')) cspViolations.push(message.text()) })
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => console.log('CSP_VIOLATION', event.violatedDirective)))
  try {
    const response = await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).waitFor()
    const csp = response!.headers()['content-security-policy']!
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]
    expect(csp).toContain("media-src 'self'")
    expect(await page.locator('script').evaluateAll(scripts => scripts.every(script => script.nonce !== '' && script.nonce === scripts[0]?.nonce))).toBe(true)
    expect(await page.locator('script').first().evaluate(script => script.nonce)).toBe(nonce)
    expect(await page.locator('link[rel="stylesheet"]').count()).toBeGreaterThan(0)
    expect(await page.locator('.sparra').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Sparra UI')
    expect(await page.getByRole('radiogroup', { name: 'Métier de l’exemple' }).count()).toBe(1)
    const garage = page.getByRole('radio', { name: 'Garage', exact: true })
    await garage.focus(); await page.keyboard.press('ArrowRight')
    const selected = page.getByRole('radio', { name: 'Contrôle technique', exact: true })
    expect(await selected.getAttribute('aria-checked')).toBe('true')
    expect(await selected.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await selected.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
    await page.keyboard.press('Tab')
    const play = page.getByRole('button', { name: 'Écouter l’exemple', exact: true })
    expect(await play.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.currentTime > .2)
    expect(await page.getByRole('button', { name: 'Pause', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    const progress = page.getByRole('progressbar', { name: 'Progression de l’exemple' })
    expect(Number(await progress.getAttribute('value'))).toBeGreaterThan(0)
    expect(Number(await progress.getAttribute('max'))).toBeGreaterThan(0)
    // Astryx buttons have empty loading-status regions; neither changing content is live.
    expect(await page.locator('#demo .sparra-transcript, #demo .sparra-progress').evaluateAll(elements => elements.every(element => element.closest('[aria-live]') === null && element.querySelector('[aria-live]') === null))).toBe(true)
    expect(await page.locator('#demo [aria-live]').evaluateAll(elements => elements.every(element => element.textContent === ''))).toBe(true)
    await page.keyboard.press('Enter')
    expect((await media(page)).paused).toBe(true)
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect(await page.getByRole('list', { name: 'Transcription — Contrôle technique' }).count()).toBe(1)
    expect(await page.getByRole('complementary', { name: 'Ce que vous recevez' }).count()).toBe(1)
    expect(external).toEqual([]); expect(errors).toEqual([]); expect(cspViolations).toEqual([])
  } finally { await page.context().close() }
})

test.each([1280, 640, 320])('axe and reflow on the compiled page at %ipx (viewport approximation, not manual zoom)', async width => {
  const page = await openPage()
  try {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(origin); await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
    await mkdir('.output/test-evidence/marketing', { recursive: true })
    await page.screenshot({ path: `.output/test-evidence/marketing/compiled-${width}.png`, fullPage: true })
  } finally { await page.context().close() }
}, 30000)

test('changing source during real playback pauses the old media and resets the selected pair', async () => {
  const page = await openPage()
  try {
    await page.goto(origin); await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.currentTime > .2)
    const previous = await page.locator('#demo audio').elementHandle()
    await page.getByRole('radio', { name: 'Contrôle technique', exact: true }).click()
    expect(await previous!.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect((await media(page)).src).toContain('/demos/controle-technique.mp3')
    expect(await page.locator('#demo .sparra-transcript').textContent()).toContain('visite de contrôle technique')
    expect(await page.locator('#demo .sparra-receipt').textContent()).toContain('visite de contrôle technique')
    await previous?.dispose()
  } finally { await page.context().close() }
})
