import { afterAll, beforeAll, expect, test } from 'vitest'
import { build, preview, type PreviewServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { ListRequestsPage, RequestDetailDto } from '../../src/modules/sparra/sparra.functions'
import type {} from '../helpers/inbox-panel-fixture'

const row: ListRequestsPage['requests'][number] = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null,
  status: 'pending', configurationRevision: null, treatedAt:null,followUp:{publicationRevision:1,decisionToken:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reviewedRevision:0,declarationActive:false,collectionClosed:true,firstDeclaredAt:null}, resultAvailability: 'unavailable',
  resultQuality: null, category: null, conversationExcerpt:null,summary: 'Initial summary', contact: null, nextAction: null,
}
const closed = {
  ...row, status: 'closed', summary: 'Updated same-ID summary', treatedAt: '2026-10-01T11:00:00.000Z',followUp:{...row.followUp,publicationRevision:2,reviewedRevision:2,declarationActive:true,firstDeclaredAt:'2026-10-01T11:00:00.000Z'},
  resultAvailability: 'available', resultQuality: 'complete', category: 'callback',
  contact: { name: null, callback_e164: '+33234567890', preference: null, callback_source: 'caller', callback_confirmed: false },
} satisfies ListRequestsPage['requests'][number]
const latest: ListRequestsPage = { requests: [closed], nextCursor: null }
const older: ListRequestsPage = { requests: [{ ...row, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', summary: 'Older call' }], nextCursor: null }
let server: PreviewServer, browser: Browser, origin: string
beforeAll(async () => {
  const config={configFile:false as const,envDir:false as const,envPrefix:'INBOX_FIXTURE_PUBLIC_',plugins:[react()],build:{outDir:'.superpowers/sdd/2026-10-26-inbox-reliable/task3-fixture-dist',emptyOutDir:true,rollupOptions:{input:'tests/helpers/inbox-panel-fixture.html'}}}
  await build(config)
  server=await preview({...config,preview:{host:'127.0.0.1',port:0}})
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Owned Inbox listener unavailable')
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 30000)
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => browser?.close(), () => server?new Promise<void>((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve())):Promise.resolve()]) { try { await close() } catch (error) { failures.push(error) } }
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
    expect(await page.locator('.sparra-inbox-status').textContent()).toBe('Closed')
    expect(await page.locator('.sparra-inbox-operator').textContent()).toBe('Treated')
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
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[1].data).toEqual({view:'pending'})
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
    expect(await page.getByRole('button', { name: 'Refresh calls', exact: true }).isDisabled()).toBe(false)
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

const actionRow = { ...closed, treatedAt:null,followUp:{publicationRevision:1,decisionToken:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reviewedRevision:0,declarationActive:false,collectionClosed:true,firstDeclaredAt:null}, nextAction: 'Confirm the callback request', resultQuality: 'partial' } satisfies ListRequestsPage['requests'][number]
const otherRow = { ...row, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', summary: null }
const actionable: ListRequestsPage = { requests: [actionRow, otherRow], nextCursor: { id: otherRow.id, admittedAt: otherRow.admittedAt } }
const stamp = '2026-10-03T16:42:11.000Z'
function callRow(page: Page, id = actionRow.id) { return page.locator('.sparra-inbox > li').filter({ has: page.locator(`a[href="/app/demandes/${id}?lang=en&view=pending"]`) }) }
async function actionsMounted(page: Page, locale: 'fr' | 'en' = 'en') {
  await page.evaluate(({ data, locale }) => window.inboxFixture.publish(data, locale), { data: actionable, locale })
  await page.getByRole('link', { name: actionRow.summary, exact: true }).waitFor()
}
async function treatmentCount(page: Page, count: number) { await expect.poll(() => page.evaluate(() => window.inboxFixture.snapshot().treatments.length)).toBe(count) }
async function treated(page: Page, receipt: { requestId: string; treatedAt: string } | number, index = 0) {
  await page.evaluate(({ index, receipt }) => window.inboxFixture.treatResolve(index, receipt), { index, receipt })
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test.each(['fr', 'en'] as const)('mounted %s rows show only supplied next actions, honest results and keyboard treatment linked to the call', async locale => {
  const { context, page } = await mounted()
  try {
    await actionsMounted(page, locale)
    const rows = page.locator('.sparra-inbox > li'), button = rows.first().getByRole('button', { name: locale === 'fr' ? 'Marquer comme traité' : 'Mark as treated', exact: true })
    expect(await rows.first().textContent()).toContain(locale === 'fr' ? 'À faire' : 'Next action')
    expect(await rows.first().textContent()).toContain('Confirm the callback request')
    expect(await rows.first().textContent()).toContain(locale === 'fr' ? 'Résumé partiel' : 'Partial summary')
    expect(await rows.first().textContent()).toContain(locale === 'fr' ? 'Demande et numéro non confirmés.' : 'Request and number are unconfirmed.')
    expect(await rows.nth(1).textContent()).toContain(locale === 'fr' ? 'Résumé indisponible' : 'Summary unavailable')
    expect(await rows.nth(1).textContent()).not.toContain(locale === 'fr' ? 'À faire' : 'Next action')
    expect(await rows.first().locator('.sparra-inbox-operator').textContent()).toBe(locale === 'fr' ? 'À traiter' : 'To treat')
    const description = await button.getAttribute('aria-describedby')
    expect(description).toBeTruthy()
    expect(await page.locator(`[id="${description}"]`).textContent()).toContain(actionRow.summary)
    await button.focus(); await page.keyboard.press('Enter'); await treatmentCount(page, 1)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).treatments[0]).toEqual({ requestId: actionRow.id,input:{requestId:actionRow.id,expectedPublicationRevision:actionRow.followUp.publicationRevision,expectedDecisionToken:actionRow.followUp.decisionToken,treated:true}, aborted: false })
  } finally { await cleanup(context) }
})

test('mounted treatment retires reads, locks controls and applies only the actual matching receipt while preserving the cursor', async () => {
  const { context, page } = await mounted()
  try {
    await actionsMounted(page)
    await page.getByRole('button', { name: 'Show more calls', exact: true }).click(); await readCount(page, 1)
    await callRow(page).getByRole('button', { name: 'Mark as treated', exact: true }).click(); await treatmentCount(page, 1)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[0].aborted).toBe(true)
    for (const label of ['Refresh calls', 'Show more calls', 'Mark as treated']) {
      for (const button of await page.getByRole('button', { name: label, exact: true }).all()) expect(await button.isDisabled()).toBe(true)
    }
    await resolved(page, 0, 401)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(0)
    await treated(page, { requestId: actionRow.id, treatedAt: stamp })
    expect(await callRow(page).locator('.sparra-inbox-operator').textContent()).toBe('Treated')
    expect(await callRow(page, otherRow.id).locator('.sparra-inbox-operator').textContent()).toBe('To treat')
    expect(await callRow(page).getByRole('button', { name: 'Mark as treated', exact: true }).count()).toBe(0)
    expect(await callRow(page).getByText('Closed', { exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Show more calls', exact: true }).click(); await readCount(page, 2)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).reads[1].data).toEqual({ cursor: actionable.nextCursor,view:'pending' })
    await resolved(page, 1, older)
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 3)
  } finally { await cleanup(context) }
})

test.each(['rejection', '503', 'wrong receipt'] as const)('mounted unknown treatment (%s) keeps prior state and directs a real refresh to verify it', async failure => {
  const { context, page } = await mounted()
  try {
    await actionsMounted(page)
    await callRow(page).getByRole('button', { name: 'Mark as treated', exact: true }).click(); await treatmentCount(page, 1)
    if (failure === 'rejection') await page.evaluate(() => window.inboxFixture.treatReject(0))
    else await treated(page, failure === '503' ? 503 : { requestId: otherRow.id, treatedAt: stamp })
    await page.getByRole('alert').waitFor()
    expect(await page.getByRole('alert').textContent()).toContain('Refresh to read the current state')
    expect(await page.locator('.sparra-inbox-operator time').count()).toBe(0)
    expect(await page.locator('.sparra-inbox > li').count()).toBe(2)
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 1)
    await resolved(page, 0, { requests: [{ ...actionRow, treatedAt: stamp,followUp:{...actionRow.followUp,reviewedRevision:actionRow.followUp.publicationRevision,declarationActive:true,firstDeclaredAt:stamp} }, otherRow], nextCursor: actionable.nextCursor })
    expect(await callRow(page).locator('.sparra-inbox-operator').textContent()).toBe('Treated')
    expect(await page.getByRole('alert').count()).toBe(0)
  } finally { await cleanup(context) }
})

test('mounted current treatment 401 uses refusal and hides private rows', async () => {
  const { context, page } = await mounted()
  try {
    await actionsMounted(page); await callRow(page).getByRole('button', { name: 'Mark as treated', exact: true }).click(); await treatmentCount(page, 1)
    await treated(page, 401); await page.getByRole('link', { name: 'Go to sign in', exact: true }).waitFor()
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(1)
    expect(await page.locator('.sparra-inbox > li').count()).toBe(0)
  } finally { await cleanup(context) }
})

test.each(['receipt', '401', 'rejection'] as const)('mounted loader replacement retires treatment (%s) without restoring absent rows or navigating', async reply => {
  const { context, page } = await mounted()
  try {
    await actionsMounted(page); await callRow(page).getByRole('button', { name: 'Mark as treated', exact: true }).click(); await treatmentCount(page, 1)
    await page.evaluate(() => window.inboxFixture.publish({ requests: [], nextCursor: null }))
    await page.getByText('No calls yet.', { exact: true }).waitFor()
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).treatments[0].aborted).toBe(true)
    if (reply === 'rejection') await page.evaluate(() => window.inboxFixture.treatReject(0))
    else await treated(page, reply === '401' ? 401 : { requestId: actionRow.id, treatedAt: stamp })
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(0)
    expect(await page.locator('.sparra-inbox > li').count()).toBe(0)
    expect(await page.getByRole('alert').count()).toBe(0)
    await page.getByRole('button', { name: 'Refresh calls', exact: true }).click(); await readCount(page, 1)
  } finally { await cleanup(context) }
})

test('mounted unmount aborts treatment and ignores late refusal', async () => {
  const { context, page } = await mounted()
  try {
    await actionsMounted(page); await callRow(page).getByRole('button', { name: 'Mark as treated', exact: true }).click(); await treatmentCount(page, 1)
    await page.evaluate(() => window.inboxFixture.unmount())
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).treatments[0].aborted).toBe(true)
    await treated(page, 401)
    expect((await page.evaluate(() => window.inboxFixture.snapshot())).refusals).toBe(0)
    expect(await page.locator('#root').textContent()).toBe('')
  } finally { await cleanup(context) }
})


test('compiled current publication, provisional revocation and old response preserve the displayed snapshot at 320px',async()=>{
 const {context,page}=await mounted()
 try{
  await page.setViewportSize({width:320,height:760})
  const next={...actionRow,summary:'Published second version',followUp:{...actionRow.followUp,publicationRevision:2,decisionToken:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}}
  await page.evaluate(data=>window.inboxFixture.publish({requests:[data],nextCursor:null},'fr','all'),next)
  await page.getByRole('link',{name:next.summary,exact:true}).waitFor()
  expect(await page.getByRole('link',{name:'Tous les appels',exact:true}).getAttribute('aria-current')).toBe('page')
  expect(await page.getByRole('link',{name:next.summary,exact:true}).getAttribute('href')).toContain('view=all')
  const button=page.getByRole('button',{name:'Marquer comme traité',exact:true})
  await button.focus();await page.keyboard.press('Enter');await treatmentCount(page,1)
  expect((await page.evaluate(()=>window.inboxFixture.snapshot())).treatments[0].input).toEqual({requestId:next.id,expectedPublicationRevision:2,expectedDecisionToken:next.followUp.decisionToken,treated:true})
  await page.evaluate(()=>window.inboxFixture.treatConflict(0,'publication-conflict'))
  await page.getByRole('alert').filter({hasText:'La fiche a changé'}).waitFor()
  await page.getByRole('button',{name:'Actualiser les appels',exact:true}).click();await readCount(page,1)
  expect((await page.evaluate(()=>window.inboxFixture.snapshot())).reads[0].data).toEqual({view:'all'})
  await resolved(page,0,{requests:[next],nextCursor:null})
  expect(await page.getByRole('button',{name:'Actualiser les appels',exact:true}).evaluate(node=>node===document.activeElement)).toBe(true)
  const detail:RequestDetailDto={...next,followUp:{...next.followUp,reviewedRevision:1,declarationActive:true,collectionClosed:false,firstDeclaredAt:stamp},summary:null,configuration:null,transcript:[{id:'source-turn',role:'user',ordinal:1,text:'Demande réelle',interrupted:false,startedAt:next.admittedAt}],transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null,evidence:[{turnId:'source-turn',role:'user'},{turnId:'missing-turn',role:'user'}],callerPhone:'+33123456789',collectionGaps:['audio_partial'],audioCoverage:'unknown',bookings:[{state:'confirmed',serviceName:'Vidange',start:'2026-10-26T08:00:00.000Z',end:'2026-10-26T08:30:00.000Z',timezone:'Europe/Paris',providerReference:'native-receipt',observedState:'confirmed'}]}
  await page.evaluate(detail=>window.inboxFixture.detailPublish({detail,receipt:null}),detail)
  await page.getByRole('button',{name:'Remettre à traiter',exact:true}).waitFor()
  expect(await page.getByRole('button',{name:'Marquer comme traité',exact:true}).isDisabled()).toBe(true)
  await page.getByText('Première déclaration',{exact:false}).waitFor()
  await page.getByText('Rendez-vous confirmé',{exact:true}).waitFor()
  await page.screenshot({path:'.superpowers/sdd/2026-10-26-inbox-reliable/task3-detail-320.png',fullPage:true})
  const source=page.getByRole('link',{name:'Appelant · 1',exact:true})
  expect(await source.getAttribute('href')).toBe('#turn-source-turn')
  expect(await page.locator('a[href="#turn-missing-turn"]').count()).toBe(0)
  expect(await page.locator('#turn-source-turn').count()).toBe(1)
  const order=await page.evaluate(()=>{const action=document.querySelector('.sparra-request-actions')!,summary=document.querySelector('.sparra-request-summary')!,transcript=document.querySelector('.sparra-request-conversation')!;return !!(action.compareDocumentPosition(transcript)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(summary.compareDocumentPosition(transcript)&Node.DOCUMENT_POSITION_FOLLOWING)})
  expect(order).toBe(true)
  await source.focus();await page.keyboard.press('Enter')
  expect(await page.evaluate(()=>location.hash)).toBe('#turn-source-turn')
  await page.getByRole('button',{name:'Remettre à traiter',exact:true}).focus();await page.keyboard.press('Enter');await treatmentCount(page,2)
  const revoked={...detail,followUp:{...detail.followUp,declarationActive:false,decisionToken:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}}
  await page.evaluate(({id,followUp})=>window.inboxFixture.treatResolve(1,{requestId:id,followUp}),{id:detail.id,followUp:revoked.followUp})
  await expect.poll(()=>page.getByRole('button',{name:'Remettre à traiter',exact:true}).count()).toBe(0)
  expect((await page.evaluate(()=>window.inboxFixture.snapshot())).treatments[1].input).toEqual({requestId:detail.id,expectedPublicationRevision:2,expectedDecisionToken:detail.followUp.decisionToken,treated:false})
  expect(await page.getByText('Première déclaration',{exact:false}).textContent()).toContain('3 oct. 2026')
  const summary=await page.locator('.sparra-request-summary').elementHandle()
  await page.getByRole('button',{name:'Actualiser les appels',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.inboxFixture.detailSnapshot().length)).toBe(1)
  await page.evaluate(detail=>window.inboxFixture.detailResolve(0,{detail,receipt:null}),detail)
  await page.getByRole('button',{name:'Remettre à traiter',exact:true}).waitFor()
  expect(await summary!.evaluate(node=>node.isConnected)).toBe(true)
  await page.getByRole('button',{name:'Remettre à traiter',exact:true}).click();await treatmentCount(page,3)
  await page.evaluate(detail=>window.inboxFixture.detailPublish({detail,receipt:null}),revoked)
  await expect.poll(()=>page.getByRole('button',{name:'Remettre à traiter',exact:true}).count()).toBe(0)
  await page.evaluate(({id,followUp})=>window.inboxFixture.treatResolve(2,{requestId:id,followUp}),{id:detail.id,followUp:{...detail.followUp,collectionClosed:true}})
  expect(await page.getByRole('button',{name:'Remettre à traiter',exact:true}).count()).toBe(0)
  expect(await page.getByRole('button',{name:'Marquer comme traité',exact:true}).isDisabled()).toBe(true)
  expect(await page.getByRole('alert').count()).toBe(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=320)).toBe(true)
 }finally{await cleanup(context)}
})


function audioRecoveryDetail():RequestDetailDto{
 return {...row,status:'closed',summary:'Audio recovery fixture',configuration:null,transcript:[],transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null,evidence:[],callerPhone:null,collectionGaps:['audio_partial'],audioCoverage:'unknown',audio:{state:'partial',durationSeconds:2,expiresAt:'2026-11-01T10:00:00.000Z',partialReason:'interrupted',available:true}}
}

test('compiled audio error recovers only after successful same-ID reread without retiring playback on treatment',async()=>{
 const {context,page}=await mounted()
 try{
  const calls=await page.evaluateHandle(()=>{
   const counts={pause:0,load:0},originalPause=HTMLMediaElement.prototype.pause,originalLoad=HTMLMediaElement.prototype.load
   HTMLMediaElement.prototype.pause=function(){counts.pause++;return originalPause.call(this)}
   HTMLMediaElement.prototype.load=function(){counts.load++;return originalLoad.call(this)}
   return counts
  })
  const detail=audioRecoveryDetail()
  await page.evaluate(detail=>window.inboxFixture.detailPublish({detail,receipt:null}),detail)
  await page.locator('audio').waitFor()
  const audio=await page.locator('audio').elementHandle(),summary=await page.locator('.sparra-request-summary').elementHandle()
  await page.getByRole('button',{name:'Marquer comme traité',exact:true}).click();await treatmentCount(page,1)
  await treated(page,{requestId:detail.id,treatedAt:stamp})
  expect(await audio!.evaluate(node=>node.isConnected)).toBe(true)
  expect(await calls.jsonValue()).toEqual({pause:0,load:0})
  await page.locator('audio').dispatchEvent('error')
  await expect.poll(()=>page.locator('audio').count()).toBe(0)
  await expect.poll(()=>audio!.getAttribute('src')).toBeNull()
  expect(await calls.jsonValue()).toEqual({pause:1,load:1})
  await page.getByRole('button',{name:'Actualiser les appels',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.inboxFixture.detailSnapshot().length)).toBe(1)
  await page.evaluate(()=>window.inboxFixture.detailResolve(0,503))
  await page.getByRole('alert').waitFor()
  expect(await page.locator('audio').count()).toBe(0)
  await page.getByRole('button',{name:'Actualiser les appels',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.inboxFixture.detailSnapshot().length)).toBe(2)
  const next={...detail,followUp:{...detail.followUp,publicationRevision:2,decisionToken:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',reviewedRevision:1,declarationActive:true,firstDeclaredAt:stamp},audio:{...detail.audio!,durationSeconds:3}}
  await page.evaluate(detail=>window.inboxFixture.detailResolve(1,{detail,receipt:null}),next)
  await expect.poll(()=>page.locator('audio').count()).toBe(1)
  expect(await page.locator('audio').getAttribute('src')).toBe('/api/sparra/audio/'+detail.id)
  expect(await page.locator('audio').getAttribute('preload')).toBe('none')
  expect(await page.locator('audio').evaluate(node=>node instanceof HTMLAudioElement&&node.paused)).toBe(true)
  expect(await summary!.evaluate(node=>node.isConnected)).toBe(true)
  expect(await page.getByRole('alert').count()).toBe(0)
  const recovered=await page.locator('audio').elementHandle()
  await page.evaluate(()=>window.inboxFixture.unmount())
  expect(await page.locator('audio').count()).toBe(0)
  await expect.poll(()=>recovered!.getAttribute('src')).toBeNull()
  expect(await calls.jsonValue()).toEqual({pause:2,load:2})
 }finally{await cleanup(context)}
})

test('compiled queued erasure reread failure announces its error while retaining the receipt and private 401 path',async()=>{
 const {context,page}=await mounted()
 try{
  await page.evaluate(requestId=>window.inboxFixture.detailPublish({detail:null,receipt:{requestId,state:'queued'}}),row.id)
  await page.getByText('Effacement en attente. Les autres copies restent à supprimer.',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Actualiser les appels',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.inboxFixture.detailSnapshot().length)).toBe(1)
  await page.evaluate(()=>window.inboxFixture.detailResolve(0,503))
  await page.getByRole('alert').waitFor()
  expect(await page.getByRole('alert').textContent()).toBe('Données indisponibles. Rechargez la page ou reconnectez-vous.')
  expect(await page.getByText('Effacement en attente. Les autres copies restent à supprimer.',{exact:true}).count()).toBe(1)
  await page.getByRole('button',{name:'Actualiser les appels',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.inboxFixture.detailSnapshot().length)).toBe(2)
  await page.evaluate(()=>window.inboxFixture.detailResolve(1,401))
  await page.getByRole('link',{name:'Aller à la connexion',exact:true}).waitFor()
  expect((await page.evaluate(()=>window.inboxFixture.snapshot())).refusals).toBe(1)
  expect(await page.getByText('Effacement en attente. Les autres copies restent à supprimer.',{exact:true}).count()).toBe(0)
 }finally{await cleanup(context)}
})
