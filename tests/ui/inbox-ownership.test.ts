import { expect, test } from 'vitest'
import type { ListRequestsInput, ListRequestsPage } from '../../src/modules/sparra/sparra.functions'
import { loadInboxPage, treatInboxRequest } from '../../src/ui/sparra/inbox-panel'

const oldRow: ListRequestsPage['requests'][number] = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null,
  status: 'pending', configurationRevision: null, treatedAt: null, resultAvailability: 'unavailable',
  resultQuality: null, category: null, summary: null, contact: null, nextAction: null,
}
const cursor = { admittedAt: oldRow.admittedAt, id: oldRow.id }
const current: ListRequestsPage = { requests: [oldRow], nextCursor: cursor }
const newRow = { ...oldRow, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
const next: ListRequestsPage = { requests: [newRow], nextCursor: null }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function observeInbox(page: ListRequestsPage) {
  const events: string[] = [], state = { page, pending: false, failed: true, refused: false }
  const setters = {
    setCurrent(value: ListRequestsPage) { state.page = value; events.push('page') },
    setPending(value: boolean) { state.pending = value; events.push(`pending:${value}`) },
    setFailed(value: boolean) { state.failed = value; events.push(`failed:${value}`) },
    setRefused(value: boolean) { state.refused = value; events.push(`refused:${value}`) },
  }
  return { events, state, setters }
}

test('inbox with no cursor neither begins an attempt nor changes state', async () => {
  const page: ListRequestsPage = { requests: [oldRow], nextCursor: null }, observed = observeInbox(page)
  let attempts = 0, requests = 0
  await loadInboxPage(page, () => { attempts++; return { signal: new AbortController().signal, live: () => true } }, async () => { requests++; return next }, { ...observed.setters, onRefused: async () => { throw new Error('Unexpected refusal') } })
  expect(attempts).toBe(0); expect(requests).toBe(0)
  expect(observed.events).toEqual([])
  expect(observed.state).toEqual({ page, pending: false, failed: true, refused: false })
})

test('current inbox attempt sends the exact cursor and signal, then merges before clearing pending', async () => {
  const observed = observeInbox(current), result = deferred<ListRequestsPage | Response>(), signal = new AbortController().signal
  let received: { data: ListRequestsInput; signal: AbortSignal } | undefined
  const operation = loadInboxPage(current, () => { observed.events.push('begin'); return { signal, live: () => true } }, (data, actualSignal) => { received = { data, signal: actualSignal }; observed.events.push('more'); return result.promise }, { ...observed.setters, onRefused: async () => { throw new Error('Unexpected refusal') } })
  expect(received?.data).toEqual({ cursor }); expect(received?.data.cursor).toBe(cursor); expect(received?.signal).toBe(signal)
  expect(observed.events).toEqual(['begin', 'pending:true', 'failed:false', 'more'])
  expect(observed.state.page).toBe(current); expect(observed.state.pending).toBe(true)
  result.resolve(next); await operation
  expect(observed.state).toEqual({ page: { requests: [oldRow, newRow], nextCursor: null }, pending: false, failed: false, refused: false })
  expect(observed.events).toEqual(['begin', 'pending:true', 'failed:false', 'more', 'page', 'pending:false'])
})

test('a fulfilled non-401 Response is decoded as a current inbox failure', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal
  await loadInboxPage(current, () => ({ signal, live: () => true }), async () => new Response(null, { status: 503 }), { ...observed.setters, onRefused: async () => { throw new Error('Unexpected refusal') } })
  expect(observed.state).toEqual({ page: current, pending: false, failed: true, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'failed:true', 'pending:false'])
})

test('an ordinary rejected inbox operation marks only the current failure', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal
  await loadInboxPage(current, () => ({ signal, live: () => true }), async () => { throw new Error('Local request failure') }, { ...observed.setters, onRefused: async () => { throw new Error('Unexpected refusal') } })
  expect(observed.state).toEqual({ page: current, pending: false, failed: true, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'failed:true', 'pending:false'])
})

test('a current 401 marks refusal before awaiting it and keeps pending until refusal settles', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal, entered = deferred<void>(), refusal = deferred<void>()
  const operation = loadInboxPage(current, () => ({ signal, live: () => true }), async () => new Response(null, { status: 401 }), { ...observed.setters, onRefused: () => { observed.events.push('onRefused'); entered.resolve(); return refusal.promise } })
  await entered.promise
  expect(observed.state).toEqual({ page: current, pending: true, failed: false, refused: true })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'onRefused'])
  refusal.resolve(); await operation
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'onRefused', 'pending:false'])
})

test('a rejected refusal propagates only after the current pending state is cleared', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal, entered = deferred<void>(), refusal = deferred<void>(), error = new Error('Local refusal failure')
  const operation = loadInboxPage(current, () => ({ signal, live: () => true }), async () => { throw new Response(null, { status: 401 }) }, { ...observed.setters, onRefused: () => { entered.resolve(); return refusal.promise } })
  await entered.promise
  expect(observed.state.pending).toBe(true); expect(observed.state.refused).toBe(true)
  refusal.reject(error)
  await expect(operation).rejects.toBe(error)
  expect(observed.state.pending).toBe(false)
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'pending:false'])
})

test('a stale inbox success cannot merge its page or clear the newer owner pending state', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal, result = deferred<ListRequestsPage | Response>()
  let owned = true
  const operation = loadInboxPage(current, () => ({ signal, live: () => owned }), () => result.promise, { ...observed.setters, onRefused: async () => { throw new Error('Unexpected refusal') } })
  owned = false; result.resolve(next); await operation
  expect(observed.state).toEqual({ page: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('a stale inbox failure cannot set failure or clear the newer owner pending state', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal, result = deferred<ListRequestsPage | Response>()
  let owned = true
  const operation = loadInboxPage(current, () => ({ signal, live: () => owned }), () => result.promise, { ...observed.setters, onRefused: async () => { throw new Error('Unexpected refusal') } })
  owned = false; result.reject(new Error('Local stale failure')); await operation
  expect(observed.state).toEqual({ page: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('a stale 401 cannot mark refusal, invoke refusal or clear pending', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal, result = deferred<ListRequestsPage | Response>()
  let owned = true, refusals = 0
  const operation = loadInboxPage(current, () => ({ signal, live: () => owned }), () => result.promise, { ...observed.setters, onRefused: async () => { refusals++ } })
  owned = false; result.resolve(new Response(null, { status: 401 })); await operation
  expect(refusals).toBe(0)
  expect(observed.state).toEqual({ page: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('inbox rechecks ownership after an awaited refusal before clearing pending', async () => {
  const observed = observeInbox(current), signal = new AbortController().signal, entered = deferred<void>(), refusal = deferred<void>()
  let owned = true
  const operation = loadInboxPage(current, () => ({ signal, live: () => owned }), async () => new Response(null, { status: 401 }), { ...observed.setters, onRefused: () => { entered.resolve(); return refusal.promise } })
  await entered.promise
  expect(observed.state.refused).toBe(true); expect(observed.state.pending).toBe(true)
  owned = false; refusal.resolve(); await operation
  expect(observed.state).toEqual({ page: current, pending: true, failed: false, refused: true })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true'])
})

const treatedAt='2026-10-03T16:42:11.000Z'
type TreatmentState={page:ListRequestsPage;pending:boolean;readFailed:boolean;treating:string|null;failed:boolean;refused:boolean;refusals:number}
function observeTreatment(page=current) {
  const events:string[]=[],lock={current:false}
  const state:TreatmentState={page,pending:true,readFailed:true,treating:null,failed:true,refused:false,refusals:0}
  const effects={
    setCurrent(update:(page:ListRequestsPage)=>ListRequestsPage){state.page=update(state.page);events.push('page')},
    setPending(value:boolean){state.pending=value;events.push(`pending:${value}`)},
    setReadFailed(value:boolean){state.readFailed=value;events.push(`readFailed:${value}`)},
    setTreating(value:string|null){state.treating=value;events.push(`treating:${value}`)},
    setFailed(value:boolean){state.failed=value;events.push(`failed:${value}`)},
    setRefused(value:boolean){state.refused=value;events.push(`refused:${value}`)},
    async onRefused(){state.refusals++;events.push('onRefused')},
  }
  return {state,events,lock,effects}
}
test.each(['locked','missing','treated'] as const)('treatment %s admission neither begins nor mutates',async kind=>{
  const observed=observeTreatment(kind==='treated'?{...current,requests:[{...oldRow,treatedAt}]}:current)
  observed.lock.current=kind==='locked'
  await treatInboxRequest(observed.state.page,kind==='missing'?newRow.id:oldRow.id,observed.lock,()=>{throw new Error('Unexpected attempt')},async()=>{throw new Error('Unexpected mutation')},observed.effects)
  expect(observed.events).toEqual([])
})
test('treatment locks before mutation, sends exact signal, updates only matching current rows and preserves cursor',async()=>{
  const observed=observeTreatment(),receipt=deferred<{requestId:string;treatedAt:string}|Response>(),signal=new AbortController().signal
  let sent:{requestId:string;signal:AbortSignal}|undefined
  const operation=treatInboxRequest(current,oldRow.id,observed.lock,()=>{observed.events.push('begin');return {signal,live:()=>true}},(requestId,signal)=>{sent={requestId,signal};expect(observed.lock.current).toBe(true);return receipt.promise},observed.effects)
  expect(sent).toEqual({requestId:oldRow.id,signal})
  expect(observed.events).toEqual(['begin','pending:false',`treating:${oldRow.id}`,'readFailed:false','failed:false'])
  observed.state.page={requests:[oldRow,newRow],nextCursor:cursor}
  receipt.resolve({requestId:oldRow.id,treatedAt});await operation
  expect(observed.state.page).toEqual({requests:[{...oldRow,treatedAt},newRow],nextCursor:cursor})
  expect(observed.state.page.requests[1]).toBe(newRow);expect(observed.state.page.nextCursor).toBe(cursor)
  expect(observed.state.treating).toBe(null);expect(observed.lock.current).toBe(false)
})
test('a deferred treatment update keeps the requested row identity captured before the receipt can change',async()=>{
  const observed=observeTreatment({requests:[oldRow,newRow],nextCursor:cursor}),receipt={requestId:oldRow.id,treatedAt}
  let update=(page:ListRequestsPage)=>page
  await treatInboxRequest(observed.state.page,oldRow.id,observed.lock,()=>({signal:new AbortController().signal,live:()=>true}),async()=>receipt,{...observed.effects,setCurrent:next=>{update=next}})
  receipt.requestId=newRow.id
  expect(update(observed.state.page)).toEqual({requests:[{...oldRow,treatedAt},newRow],nextCursor:cursor})
})
test.each(['rejection','503','mismatch'] as const)('current treatment %s leaves prior rows and announces unknown outcome',async kind=>{
  const observed=observeTreatment()
  await treatInboxRequest(current,oldRow.id,observed.lock,()=>({signal:new AbortController().signal,live:()=>true}),async()=>{
    if(kind==='rejection')throw new Error('Owned failure')
    if(kind==='503')return new Response(null,{status:503})
    return {requestId:newRow.id,treatedAt}
  },observed.effects)
  expect(observed.state.page).toBe(current);expect(observed.state.failed).toBe(true);expect(observed.state.readFailed).toBe(false)
  expect(observed.state.refusals).toBe(0);expect(observed.lock.current).toBe(false);expect(observed.state.treating).toBe(null)
})
test.each(['receipt','401','rejection'] as const)('retired treatment %s cannot change newer state, refusal or lock',async kind=>{
  const observed=observeTreatment(),result=deferred<{requestId:string;treatedAt:string}|Response>()
  let live=true
  const operation=treatInboxRequest(current,oldRow.id,observed.lock,()=>({signal:new AbortController().signal,live:()=>live}),()=>result.promise,observed.effects)
  live=false;observed.state.page=next;observed.state.treating=newRow.id;observed.lock.current=true
  const before=[...observed.events]
  if(kind==='rejection')result.reject(new Error('Owned late failure'))
  else result.resolve(kind==='401'?new Response(null,{status:401}):{requestId:oldRow.id,treatedAt})
  await operation
  expect(observed.events).toEqual(before);expect(observed.state.page).toBe(next);expect(observed.state.treating).toBe(newRow.id)
  expect(observed.state.refusals).toBe(0);expect(observed.lock.current).toBe(true)
})
test.each(['current','retired'] as const)('treatment 401 marks refusal before awaiting and %s finally respects ownership',async kind=>{
  const observed=observeTreatment(),entered=deferred<void>(),refusal=deferred<void>()
  let live=true
  const operation=treatInboxRequest(current,oldRow.id,observed.lock,()=>({signal:new AbortController().signal,live:()=>live}),async()=>new Response(null,{status:401}),{...observed.effects,onRefused:()=>{entered.resolve();return refusal.promise}})
  await entered.promise
  expect(observed.state.refused).toBe(true);expect(observed.lock.current).toBe(true);expect(observed.state.treating).toBe(oldRow.id)
  live=kind==='current';refusal.resolve();await operation
  expect(observed.lock.current).toBe(kind==='retired');expect(observed.state.treating).toBe(kind==='retired'?oldRow.id:null)
})
test('a rejected treatment refusal propagates after releasing the current treatment lock',async()=>{
  const observed=observeTreatment(),failure=new Error('Owned refusal failure')
  await expect(treatInboxRequest(current,oldRow.id,observed.lock,()=>({signal:new AbortController().signal,live:()=>true}),async()=>new Response(null,{status:401}),{...observed.effects,onRefused:async()=>{throw failure}})).rejects.toBe(failure)
  expect(observed.state.refused).toBe(true);expect(observed.state.page).toBe(current)
  expect(observed.lock.current).toBe(false);expect(observed.state.treating).toBe(null)
})
