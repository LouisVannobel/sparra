import { expect, test } from 'vitest'
import type { EraseReceipt, RequestDetailDto } from '../../src/modules/sparra/sparra.functions'
import { performRequestAction, type RequestLoaded } from '../../src/ui/sparra/request-panel'

const detail: RequestDetailDto = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z',
  endedAt: '2026-10-01T10:03:00.000Z', status: 'closed', configurationRevision: 7,
  treatedAt: null, resultAvailability: 'available', resultQuality: 'partial', category: 'information',
  summary: 'Local request text', contact: { name: 'Camille', callback_e164: '+33123456789', preference: 'Afternoon', callback_source: 'caller', callback_confirmed: false },
  nextAction: 'Check the request', configuration: { workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 7, savedAt: '2026-09-30T10:00:00.000Z', businessName: 'Local garage', sector: 'garage', knowledge: { openingHours: '09:00–17:00', services: 'Oil change', prices: '', faq: 'Bring the vehicle papers', instructions: 'Ask before proceeding' }, transferDestination: null },
  transcript: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ordinal: 1, role: 'user', text: 'Caller turn', interrupted: false, startedAt: '2026-10-01T10:00:00.000Z' }],
  transcriptAvailability: 'partial', unavailableTurnCount: 2, moreTurns: true, transcriptLossCount: 3, erasureState: null,
}
const receipt: EraseReceipt = { requestId: detail.id, state: 'queued' }
const current: RequestLoaded = { detail, receipt }
const treated = { requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', treatedAt: '2026-10-04T10:00:00.000Z' }
const unexpectedAction = async (): Promise<never> => { throw new Error('Unexpected action') }
const unexpectedRefusal = async (): Promise<never> => { throw new Error('Unexpected refusal') }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function observeRequest(loaded: RequestLoaded) {
  const events: string[] = [], state = { loaded, pending: false, failed: true, refused: false }
  const setters = {
    setCurrent(value: RequestLoaded) { state.loaded = value; events.push('loaded') },
    setPending(value: boolean) { state.pending = value; events.push(`pending:${value}`) },
    setFailed(value: boolean) { state.failed = value; events.push(`failed:${value}`) },
    setRefused(value: boolean) { state.refused = value; events.push(`refused:${value}`) },
  }
  return { events, state, setters }
}

test('treat uses its owned signal and preserves the loaded DTO except treatedAt', async () => {
  const observed = observeRequest(current), result = deferred<typeof treated | Response>(), signal = new AbortController().signal
  let received: AbortSignal | undefined
  const operation = performRequestAction('treat', current, () => { observed.events.push('begin'); return { signal, live: () => true } }, actualSignal => { received = actualSignal; observed.events.push('treat'); return result.promise }, unexpectedAction, { ...observed.setters, onRefused: unexpectedRefusal })
  expect(received).toBe(signal)
  expect(observed.events).toEqual(['begin', 'pending:true', 'failed:false', 'treat'])
  expect(observed.state.loaded).toBe(current); expect(observed.state.pending).toBe(true)
  result.resolve(treated); await operation
  expect(observed.state).toEqual({ loaded: { detail: { ...detail, treatedAt: '2026-10-04T10:00:00.000Z' }, receipt }, pending: false, failed: false, refused: false })
  expect(observed.state.loaded.detail?.id).toBe(detail.id)
  expect(observed.state.loaded.detail?.contact).toBe(detail.contact)
  expect(observed.state.loaded.detail?.configuration).toBe(detail.configuration)
  expect(observed.state.loaded.detail?.transcript).toBe(detail.transcript)
  expect(observed.state.loaded.receipt).toBe(receipt)
  expect(current.detail?.treatedAt).toBeNull()
  expect(observed.events).toEqual(['begin', 'pending:true', 'failed:false', 'treat', 'loaded', 'pending:false'])
})

test('treat keeps null detail and the existing receipt when its result settles', async () => {
  const loaded: RequestLoaded = { detail: null, receipt }, observed = observeRequest(loaded), signal = new AbortController().signal
  await performRequestAction('treat', loaded, () => ({ signal, live: () => true }), async () => treated, unexpectedAction, { ...observed.setters, onRefused: unexpectedRefusal })
  expect(observed.state).toEqual({ loaded: { detail: null, receipt }, pending: false, failed: false, refused: false })
  expect(observed.state.loaded.receipt).toBe(receipt)
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'loaded', 'pending:false'])
})

test('erase uses its owned signal and replaces the detail with exactly its returned receipt', async () => {
  const observed = observeRequest(current), erased: EraseReceipt = { requestId: treated.requestId, state: 'completed' }, result = deferred<EraseReceipt | Response>(), signal = new AbortController().signal
  let received: AbortSignal | undefined
  const operation = performRequestAction('erase', current, () => { observed.events.push('begin'); return { signal, live: () => true } }, unexpectedAction, actualSignal => { received = actualSignal; observed.events.push('erase'); return result.promise }, { ...observed.setters, onRefused: unexpectedRefusal })
  expect(received).toBe(signal)
  expect(observed.events).toEqual(['begin', 'pending:true', 'failed:false', 'erase'])
  expect(observed.state.loaded).toBe(current)
  result.resolve(erased); await operation
  expect(observed.state).toEqual({ loaded: { detail: null, receipt: { requestId: treated.requestId, state: 'completed' } }, pending: false, failed: false, refused: false })
  expect(observed.state.loaded.receipt).toBe(erased)
  expect(observed.events).toEqual(['begin', 'pending:true', 'failed:false', 'erase', 'loaded', 'pending:false'])
})

test('a fulfilled non-401 Response is decoded as a current treat failure', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal
  await performRequestAction('treat', current, () => ({ signal, live: () => true }), async () => new Response(null, { status: 503 }), unexpectedAction, { ...observed.setters, onRefused: unexpectedRefusal })
  expect(observed.state).toEqual({ loaded: current, pending: false, failed: true, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'failed:true', 'pending:false'])
})

test('a rejected non-401 Response is a current erase failure', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal
  await performRequestAction('erase', current, () => ({ signal, live: () => true }), unexpectedAction, async () => { throw new Response(null, { status: 409 }) }, { ...observed.setters, onRefused: unexpectedRefusal })
  expect(observed.state).toEqual({ loaded: current, pending: false, failed: true, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'failed:true', 'pending:false'])
})

test('an ordinary rejected action marks failure without replacing the loaded request', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal
  await performRequestAction('erase', current, () => ({ signal, live: () => true }), unexpectedAction, async () => { throw new Error('Local action failure') }, { ...observed.setters, onRefused: unexpectedRefusal })
  expect(observed.state).toEqual({ loaded: current, pending: false, failed: true, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'failed:true', 'pending:false'])
})

test('a fulfilled treat 401 marks refusal before awaiting it and keeps pending until it settles', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, entered = deferred<void>(), refusal = deferred<void>()
  const operation = performRequestAction('treat', current, () => ({ signal, live: () => true }), async () => new Response(null, { status: 401 }), unexpectedAction, { ...observed.setters, onRefused: () => { observed.events.push('onRefused'); entered.resolve(); return refusal.promise } })
  await entered.promise
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: true })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'onRefused'])
  refusal.resolve(); await operation
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'onRefused', 'pending:false'])
})

test('a rejected erase 401 propagates refusal rejection after clearing current pending', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, entered = deferred<void>(), refusal = deferred<void>(), error = new Error('Local refusal failure')
  const operation = performRequestAction('erase', current, () => ({ signal, live: () => true }), unexpectedAction, async () => { throw new Response(null, { status: 401 }) }, { ...observed.setters, onRefused: () => { observed.events.push('onRefused'); entered.resolve(); return refusal.promise } })
  await entered.promise
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: true })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'onRefused'])
  refusal.reject(error)
  await expect(operation).rejects.toBe(error)
  expect(observed.state.pending).toBe(false)
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true', 'onRefused', 'pending:false'])
})

test('a stale treat success cannot replace the request or clear the newer pending state', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, result = deferred<typeof treated | Response>()
  let owned = true
  const operation = performRequestAction('treat', current, () => ({ signal, live: () => owned }), () => result.promise, unexpectedAction, { ...observed.setters, onRefused: unexpectedRefusal })
  owned = false; result.resolve(treated); await operation
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('a stale erase success cannot replace the request or clear the newer pending state', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, result = deferred<EraseReceipt | Response>()
  let owned = true
  const operation = performRequestAction('erase', current, () => ({ signal, live: () => owned }), unexpectedAction, () => result.promise, { ...observed.setters, onRefused: unexpectedRefusal })
  owned = false; result.resolve({ requestId: detail.id, state: 'completed' }); await operation
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('a stale action failure cannot mark failure or clear the newer pending state', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, result = deferred<EraseReceipt | Response>()
  let owned = true
  const operation = performRequestAction('erase', current, () => ({ signal, live: () => owned }), unexpectedAction, () => result.promise, { ...observed.setters, onRefused: unexpectedRefusal })
  owned = false; result.reject(new Error('Local stale failure')); await operation
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('a stale fulfilled treat 401 cannot mark refusal, invoke refusal or clear pending', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, result = deferred<typeof treated | Response>()
  let owned = true, refusals = 0
  const operation = performRequestAction('treat', current, () => ({ signal, live: () => owned }), () => result.promise, unexpectedAction, { ...observed.setters, onRefused: async () => { refusals++ } })
  owned = false; result.resolve(new Response(null, { status: 401 })); await operation
  expect(refusals).toBe(0)
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('a stale rejected erase 401 cannot mark refusal, invoke refusal or clear pending', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, result = deferred<EraseReceipt | Response>()
  let owned = true, refusals = 0
  const operation = performRequestAction('erase', current, () => ({ signal, live: () => owned }), unexpectedAction, () => result.promise, { ...observed.setters, onRefused: async () => { refusals++ } })
  owned = false; result.reject(new Response(null, { status: 401 })); await operation
  expect(refusals).toBe(0)
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: false })
  expect(observed.events).toEqual(['pending:true', 'failed:false'])
})

test('the request action rechecks ownership after awaiting refusal before clearing pending', async () => {
  const observed = observeRequest(current), signal = new AbortController().signal, entered = deferred<void>(), refusal = deferred<void>()
  let owned = true
  const operation = performRequestAction('treat', current, () => ({ signal, live: () => owned }), async () => new Response(null, { status: 401 }), unexpectedAction, { ...observed.setters, onRefused: () => { entered.resolve(); return refusal.promise } })
  await entered.promise
  expect(observed.state.refused).toBe(true); expect(observed.state.pending).toBe(true)
  owned = false; refusal.resolve(); await operation
  expect(observed.state).toEqual({ loaded: current, pending: true, failed: false, refused: true })
  expect(observed.events).toEqual(['pending:true', 'failed:false', 'refused:true'])
})
