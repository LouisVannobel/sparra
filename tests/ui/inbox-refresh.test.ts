import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { ListRequestsPage } from '../../src/modules/sparra/sparra.functions'
import type {} from '../helpers/inbox-panel-fixture'

const row: ListRequestsPage['requests'][number] = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null,
  status: 'pending', configurationRevision: null, treatedAt: null, resultAvailability: 'unavailable',
  resultQuality: null, category: null, summary: 'Initial summary', contact: null, nextAction: null,
}
const closed = {
  ...row, status: 'closed', summary: 'Updated same-ID summary', treatedAt: '2026-10-01T11:00:00.000Z',
  resultAvailability: 'available', resultQuality: 'complete', category: 'callback',
  contact: { name: null, callback_e164: '+33234567890', preference: null, callback_source: 'caller', callback_confirmed: false },
} satisfies ListRequestsPage['requests'][number]
const latest: ListRequestsPage = { requests: [closed], nextCursor: null }
const older: ListRequestsPage = { requests: [{ ...row, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', summary: 'Older call' }], nextCursor: null }
let server: ViteDevServer, browser: Browser, origin: string
beforeAll(async () => {
  server = await createServer({ configFile: false, envDir: false, envPrefix: 'INBOX_FIXTURE_PUBLIC_', plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Owned Inbox listener unavailable')
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 30000)
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => browser?.close(), () => server?.close()]) { try { await close() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Owned Inbox panel cleanup failed')
})
async function mounted() {
  const context = await browser.newContext(), page = await context.newPage()
  page.setDefaultTimeout(2500)
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await page.goto(origin + '/tests/helpers/inbox-panel-fixture.html')
  await page.getByRole('link', { name: 'Initial summary', exact: true }).waitFor()
  return { context, page }
}
async function resolved(page: Page, index: number, result: ListRequestsPage | number) {
  await page.evaluate(({ index, result }) => window.inboxFixture.resolve(index, result), { index, result })
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}
async function readCount(page: Page, count: number) { await expect.poll(() => page.evaluate(() => window.inboxFixture.snapshot().reads.length)).toBe(count) }
async function cleanup(context: BrowserContext) { await context.close() }

test('mounted same-ID loader updates status and summary, retires older pagination and clears pending', async () => {
  const { context, page } = await mounted()
  try {
    await page.getByRole('button', { name: 'Show more calls', exact: true }).click(); await readCount(page, 1)
    await page.evaluate(latest => window.inboxFixture.publish(latest), latest)
    await page.getByRole('link', { name: closed.summary, exact: true }).waitFor()
    expect(await page.locator('.sparra-inbox-status').textContent()).toBe('Closed — Treated')
    await page.getByText('+33234567890', { exact: true }).waitFor()
    expect(await page.locator('p[role="status"]').count()).toBe(0)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[0].aborted).toBe(true)
    await resolved(page, 0, older)
    await expect.poll(() => page.locator('.sparra-inbox > li').count()).toBe(1)
    expect(await page.getByRole('link', { name: 'Older call', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Show more calls', exact: true }).count()).toBe(0)
  } finally { await cleanup(context) }
})

test('mounted refresh replaces the loaded page and cursor, updates same IDs and removes absent rows', async () => {
  const { context, page } = await mounted()
  try {
    await page.getByRole('button', { name: 'Show more calls', exact: true }).click(); await readCount(page, 1); await resolved(page, 0, older)
    await page.getByRole('link', { name: 'Older call', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 2)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[1].data).toEqual({})
    await resolved(page, 1, latest)
    await page.getByRole('link', { name: closed.summary, exact: true }).waitFor()
    expect(await page.locator('.sparra-inbox > li').count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Show more calls', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 3)
    await resolved(page, 2, { requests: [], nextCursor: null })
    await page.getByText('No calls yet.', { exact: true }).waitFor()
    expect(await page.locator('.sparra-inbox > li').count()).toBe(0)
  } finally { await cleanup(context) }
})

test.each(['rejection', '503'] as const)('mounted failed refresh (%s) preserves page and cursor, announces failure and allows retry', async failure => {
  const { context, page } = await mounted()
  try {
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 1)
    if (failure === 'rejection') await page.evaluate(() => window.inboxFixture.reject(0))
    else await resolved(page, 0, 503)
    await page.getByRole('alert').waitFor()
    expect(await page.getByRole('link', { name: 'Initial summary', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Show more calls', exact: true }).isDisabled()).toBe(false)
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 2)
    await resolved(page, 1, latest); await page.getByRole('link', { name: closed.summary, exact: true }).waitFor()
    expect(await page.getByRole('alert').count()).toBe(0)
  } finally { await cleanup(context) }
})

test('mounted refresh supersedes an older page without stale success or 401 changing its pending UI', async () => {
  const { context, page } = await mounted()
  try {
    await page.getByRole('button', { name: 'Show more calls', exact: true }).click(); await readCount(page, 1)
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 2)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[0].aborted).toBe(true)
    await resolved(page, 0, 401)
    expect(await page.getByRole('button', { name: 'Refresh calls', exact: true }).isDisabled()).toBe(true)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(0)
    await resolved(page, 1, latest); await page.getByRole('link', { name: closed.summary, exact: true }).waitFor()
    expect(await page.locator('p[role="status"]').count()).toBe(0)
  } finally { await cleanup(context) }
})

test('mounted current refresh 401 invokes existing refusal and hides private rows', async () => {
  const { context, page } = await mounted()
  try {
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 1); await resolved(page, 0, 401)
    await page.getByRole('link', { name: 'Go to sign in', exact: true }).waitFor()
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(1)
    expect(await page.locator('.sparra-inbox > li').count()).toBe(0)
  } finally { await cleanup(context) }
})

test('mounted French refresh stays available on empty pages and unmount aborts its attempt', async () => {
  const { context, page } = await mounted()
  try {
    await page.evaluate(() => window.inboxFixture.publish({ requests: [], nextCursor: null }, 'fr'))
    await page.getByText('Aucun appel pour le moment.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Actualiser les appels', exact: true }).click(); await readCount(page, 1)
    await page.evaluate(() => window.inboxFixture.unmount())
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[0].aborted).toBe(true)
    await resolved(page, 0, 401)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(0)
    expect(await page.locator('#root').textContent()).toBe('')
  } finally { await cleanup(context) }
})
