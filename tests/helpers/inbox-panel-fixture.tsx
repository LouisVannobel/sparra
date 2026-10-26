// Controlled operations mount the production panel; they do not prove auth or provider behavior.
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { InboxPanel } from '../../src/ui/sparra/inbox-panel'
import type { ListRequestsInput, ListRequestsPage } from '../../src/modules/sparra/sparra.functions'
import type { UpdateRequestFollowUpInput, RequestFollowUpReceipt } from '../../src/modules/sparra/follow-up'
import type { Locale } from '../../src/ui/auth/messages'
import '../../src/ui/sparra/sparra.css'

export const row: ListRequestsPage['requests'][number] = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null,
  status: 'pending', configurationRevision: null, treatedAt:null,followUp:{publicationRevision:1,decisionToken:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reviewedRevision:0,declarationActive:false,collectionClosed:true,firstDeclaredAt:null}, resultAvailability: 'unavailable',
  resultQuality: null, category: null, conversationExcerpt:null,summary: 'Initial summary', contact: null, nextAction: null,
}
const initial: ListRequestsPage = { requests: [row], nextCursor: { id: row.id, admittedAt: row.admittedAt } }
const reads: { data: ListRequestsInput; signal: AbortSignal; resolve(value: ListRequestsPage | Response): void; reject(error: Error): void }[] = []
const treatments: { input: UpdateRequestFollowUpInput; requestId: string; signal: AbortSignal; resolve(value: RequestFollowUpReceipt | Response): void; reject(error: Error): void }[] = []
let refusals = 0
const node = document.getElementById('root')
if (!node) throw new Error('Owned Inbox root missing')
const root = createRoot(node)
function render(page: ListRequestsPage, locale: Locale = 'en') {
  root.render(<Theme theme={neutralTheme} mode="light"><InboxPanel locale={locale} state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={page}
    onMore={(data, signal) => new Promise((resolve, reject) => { reads.push({ data, signal, resolve, reject }) })}
    onTreat={(input, signal) => new Promise((resolve, reject) => { treatments.push({ input, requestId:input.requestId, signal, resolve, reject }) })}
    onRefused={async () => { refusals++ }}
  /></Theme>)
}
const fixture = {
  publish: render,
  resolve(index: number, page: ListRequestsPage | number) { reads[index].resolve(typeof page === 'number' ? new Response(null, { status: page }) : page) },
  reject(index: number) { reads[index].reject(new Error('Owned read failure')) },
  treatResolve(index: number, receipt: { requestId: string; treatedAt: string } | number) { treatments[index].resolve(typeof receipt === 'number' ? new Response(null, { status: receipt }) : {requestId:receipt.requestId,followUp:{publicationRevision:treatments[index].input.expectedPublicationRevision,decisionToken:'ffffffff-ffff-4fff-8fff-ffffffffffff',reviewedRevision:treatments[index].input.expectedPublicationRevision,declarationActive:true,collectionClosed:true,firstDeclaredAt:receipt.treatedAt}}) },
  treatReject(index: number) { treatments[index].reject(new Error('Owned treatment failure')) },
  unmount() { root.unmount() },
  snapshot() { return { reads: reads.map(read => ({ data: read.data, aborted: read.signal.aborted })), treatments: treatments.map(action => ({ requestId: action.requestId, aborted: action.signal.aborted })), refusals } },
}
declare global { interface Window { inboxFixture: typeof fixture } }
window.inboxFixture = fixture
render(initial)
