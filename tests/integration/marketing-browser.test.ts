import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(6000)
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  return page
}
async function media(page: Page) {
  return page.locator('#demo audio').evaluate((audio: HTMLAudioElement) => ({ paused: audio.paused, time: audio.currentTime, src: audio.currentSrc || audio.src }))
}

test('no autoplay; real play, pause, restart and arrows keep audio, transcript and receipt paired', async () => {
  const page = await openPage()
  try {
    await page.goto(origin); await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).waitFor()
    expect(await media(page)).toMatchObject({ paused: true, time: 0 })
    expect(await page.locator('#demo audio').getAttribute('autoplay')).toBe(null)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#demo audio')!.currentTime > .2)
    expect(await page.locator('#demo [aria-current="true"]').count()).toBe(1)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    expect((await media(page)).paused).toBe(true)
    expect((await media(page)).time).toBeGreaterThan(.2)
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
  } finally { await page.close() }
}, 30000)

test('a real audio failure is announced and leaves text and receipt available', async () => {
  const page = await openPage()
  try {
    await page.route('**/demos/*.mp3', route => route.fulfill({ status: 404, body: 'Missing audio' }))
    await page.goto(origin)
    await page.getByRole('button', { name: 'Écouter l’exemple', exact: true }).click()
    await page.locator('#demo [role="alert"]').waitFor()
    expect(await page.locator('#demo .sparra-transcript').textContent()).toContain('révision')
    expect(await page.locator('#demo .sparra-receipt').textContent()).toContain('révision')
    expect((await media(page)).paused).toBe(true)
  } finally { await page.close() }
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
  } finally { release(); await page.close() }
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
  } finally { release(); await page.close() }
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
  } finally { release(); await page.close() }
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
    expect(await previous!.evaluate(audio => (audio as HTMLAudioElement).paused)).toBe(true)
    await previous?.dispose()
  } finally { await page.close() }
})
