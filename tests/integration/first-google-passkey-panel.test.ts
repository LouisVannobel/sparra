import { createServer } from 'node:http'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { bounded } from '../helpers/web-process'

// Real mounted production component; DTO callbacks are UI-only doubles, not auth evidence.
let server: ReturnType<typeof createServer>, browser: Browser, origin = '', serverFailures = 0
const requests = new Set<Promise<void>>(), observations: Record<string, unknown>[] = []
beforeAll(async () => {
  const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9c-panel-fixture-dist')
  const files = new Map<string, string>()
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = resolve(entry.parentPath, entry.name)
    if (!file.startsWith(directory + sep)) throw new Error('Owned panel file rejected')
    files.set('/' + file.slice(directory.length + 1).split(sep).join('/'), file)
  }
  server = createServer((request, response) => {
    const pending = (async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const file = files.get(path === '/' ? '/first-google-panel-fixture.html' : path)
        if (!file) { response.writeHead(404); response.end(); return }
        const type = extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html'
        const data = await readFile(file)
        response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(data)
      } catch { serverFailures++; response.destroy() }
    })()
    requests.add(pending); void pending.then(() => { requests.delete(pending) })
  })
  await new Promise<void>((done, reject) => { server.once('error', () => reject(new Error('Owned panel server failed'))); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned panel server unavailable')
  origin = 'http://localhost:' + address.port
  browser = await chromium.launch({ headless: true, channel: 'chromium' })
})
afterAll(async () => {
  const cleanupFailures: string[] = []
  try { await browser?.close() } catch { cleanupFailures.push('browser') }
  try { await bounded(Promise.all([...requests]), 5000) } catch { cleanupFailures.push('requests') }
  try { if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) } } catch { cleanupFailures.push('server') }
  const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9c-evidence')
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'panel-refresh-' + randomUUID() + '.json'), JSON.stringify({ scope: 'mounted panel with UI DTO doubles; no native/session/provider authority claim', observations, serverFailures, cleanupFailures }, null, 2) + '\n', { flag: 'wx' })
  expect({ serverFailures, cleanupFailures }).toEqual({ serverFailures: 0, cleanupFailures: [] })
})
test.each(['read', 'finish', 'cancel'] as const)('mounted confirmed added survives rejecting refresh after %s', async mode => {
  const context = await browser.newContext(), page = await context.newPage()
  let externalRequests = 0, pageErrors = 0
  page.on('pageerror', () => pageErrors++)
  await context.route('**/*', async route => {
    try { if (new URL(route.request().url()).origin === origin) await route.continue(); else { externalRequests++; await route.abort() } }
    catch { serverFailures++; try { await route.abort() } catch {} }
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  try {
    await page.goto(origin + '/?mode=' + mode)
    if (mode !== 'read') {
      const action = page.getByRole('button', { name: mode === 'finish' ? 'Create my first passkey' : 'Cancel this request', exact: true })
      await action.focus(); await page.keyboard.press('Enter')
    }
    await page.waitForFunction(() => Reflect.get(window, '__firstPanelFixture')?.().refresh === 1)
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const calls = await page.evaluate(() => Reflect.get(window, '__firstPanelFixture')())
    const addedVisible = await page.getByRole('status').filter({ hasText: 'Your first passkey was added.' }).count() === 1
    const refreshAlert = await page.getByRole('alert').filter({ hasText: 'The account view could not refresh. Your passkey was added.' }).count() === 1
    const createControls = await page.getByRole('button', { name: 'Create my first passkey', exact: true }).count()
    observations.push({ mode, addedVisible, refreshAlert, createControls, calls, externalRequests, pageErrors })
    expect(addedVisible).toBe(true)
    expect(refreshAlert).toBe(true)
    expect(createControls).toBe(0)
    expect(calls).toEqual({ read: 1, prepare: mode === 'finish' ? 1 : 0, finish: mode === 'finish' ? 1 : 0, cancel: mode === 'cancel' ? 1 : 0, refresh: 1, added: true, refreshSignalMatches: true, refreshSignalLive: true })
    expect({ externalRequests, pageErrors }).toEqual({ externalRequests: 0, pageErrors: 0 })
  } finally { await cdp.detach(); await context.close() }
})
