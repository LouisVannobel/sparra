import { afterEach, expect, test, vi } from 'vitest'
import { createControlledPromise } from '@tanstack/react-router'
import { Route } from '../../../src/routes/app.demandes.$requestId'
import type { EraseReceipt, RequestDetailDto, getRequestDetail, getRequestErasure } from '../../../src/modules/sparra/sparra.functions'
import type { Locale } from '../../../src/ui/auth/messages'

// Only the RPC boundary is controlled. These are ordinary consumer tests,
// without native auth, workspace, transaction or database qualification.
const rpc = vi.hoisted(() => ({
  getRequestDetail: vi.fn<(input: Parameters<typeof getRequestDetail>[0]) => Promise<RequestDetailDto | Response>>(),
  getRequestErasure: vi.fn<(input: Parameters<typeof getRequestErasure>[0]) => Promise<EraseReceipt | Response>>(),
  markRequestTreated: vi.fn(),
  eraseRequest: vi.fn(),
}))
vi.mock('../../../src/modules/sparra/sparra.functions', () => rpc)
afterEach(() => vi.resetAllMocks())

const configuredLoader = Route.options.loader
if (typeof configuredLoader !== 'function') throw new Error('Actual request route loader required')
const loader = configuredLoader
type LoaderContext = Parameters<typeof loader>[0]
type ParentMatch = Awaited<LoaderContext['parentMatchPromise']>

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const detail: RequestDetailDto = {
  id: requestId, admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null, status: 'pending', configurationRevision: null, treatedAt: null,
  resultAvailability: 'unavailable', resultQuality: null, category: null, summary: null, contact: null, nextAction: null, configuration: null,
  transcript: [], transcriptAvailability: 'unavailable', unavailableTurnCount: 0, moreTurns: false, transcriptLossCount: 0, erasureState: null,
}

function fixture(lang: Locale = 'fr') {
  const parent = createControlledPromise<ParentMatch>(), abortController = new AbortController()
  // Complete installed RouteMatch and LoaderFnContext shapes. Parent flags
  // are test data; no principal or Workspace result is fabricated here.
  const match: ParentMatch = {
    id: '/app', routeId: '/app', fullPath: '/app', index: 1, pathname: '/app', params: {}, _strictParams: {},
    status: 'success', isFetching: false, error: undefined, paramsError: undefined, searchError: undefined, updatedAt: 0,
    context: {}, search: { lang }, _strictSearch: { lang }, abortController: new AbortController(), cause: 'enter',
    loaderDeps: { lang }, preload: false, invalid: false, staticData: {},
  }
  const pathname = '/app/demandes/' + requestId, href = pathname + '?lang=' + lang
  const context: LoaderContext = {
    abortController, preload: false, params: { requestId }, deps: { lang }, context: {},
    location: { href, pathname, search: { lang }, searchStr: '?lang=' + lang, state: { __TSR_index: 0, __TSR_key: 'request-loader-fixture' }, hash: '', publicHref: href, external: false },
    navigate: vi.fn<LoaderContext['navigate']>(), parentMatchPromise: parent, cause: 'enter', route: Route,
  }
  return { context, match, parent }
}

test('the actual request loader waits for its parent before reading detail with the same selector and signal', async () => {
  const { context, match, parent } = fixture()
  rpc.getRequestDetail.mockResolvedValue(detail)
  const pending = loader(context)
  await Promise.resolve()
  expect(rpc.getRequestDetail).not.toHaveBeenCalled()
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
  parent.resolve(match)
  await expect(pending).resolves.toEqual({ detail, receipt: null })
  expect(rpc.getRequestDetail).toHaveBeenCalledExactlyOnceWith({ data: { requestId }, signal: context.abortController.signal })
  expect(rpc.getRequestDetail.mock.calls[0]?.[0]?.signal).toBe(context.abortController.signal)
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
})

test.each([
  { name: 'unknown parent error', failure: new Error('private-parent-error') },
  { name: 'parent 404', failure: new Response('private-parent-response', { status: 404 }) },
  { name: 'unknown parent value', failure: { private: 'parent-value' } },
])('$name closes without dispatching either private read', async ({ failure }) => {
  const { context, parent } = fixture()
  const pending = loader(context)
  const rejected = expect(pending).rejects.toEqual(new Error('Request unavailable'))
  parent.reject(failure)
  await rejected
  expect(rpc.getRequestDetail).not.toHaveBeenCalled()
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
})

test('cancellation while the parent is pending prevents a read after the parent settles', async () => {
  const { context, match, parent } = fixture()
  const pending = loader(context)
  context.abortController.abort(new Error('private-cancellation-reason'))
  await Promise.resolve()
  expect(rpc.getRequestDetail).not.toHaveBeenCalled()
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
  const rejected = expect(pending).rejects.toEqual(new Error('Request unavailable'))
  parent.resolve(match)
  await rejected
  expect(rpc.getRequestDetail).not.toHaveBeenCalled()
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
})

const missingDetailCases: ReadonlyArray<{ delivery: 'returned' | 'thrown'; state: EraseReceipt['state'] }> = [
  { delivery: 'returned', state: 'queued' },
  { delivery: 'thrown', state: 'completed' },
]
test.each(missingDetailCases)('a $delivery detail 404 reads its $state erasure receipt with the identical selector and signal', async ({ delivery, state }) => {
  const { context, match, parent } = fixture()
  const missing = new Response('private-detail-404', { status: 404 }), receipt: EraseReceipt = { requestId, state }
  if (delivery === 'returned') rpc.getRequestDetail.mockResolvedValue(missing)
  else rpc.getRequestDetail.mockRejectedValue(missing)
  rpc.getRequestErasure.mockResolvedValue(receipt)
  parent.resolve(match)
  await expect(loader(context)).resolves.toEqual({ detail: null, receipt })
  expect(rpc.getRequestDetail).toHaveBeenCalledExactlyOnceWith({ data: { requestId }, signal: context.abortController.signal })
  expect(rpc.getRequestErasure).toHaveBeenCalledExactlyOnceWith({ data: { requestId }, signal: context.abortController.signal })
  expect(rpc.getRequestErasure.mock.calls[0]?.[0]?.signal).toBe(context.abortController.signal)
})

const unauthorizedCases: ReadonlyArray<{ lang: Locale; delivery: 'returned' | 'thrown' }> = [
  { lang: 'fr', delivery: 'returned' },
  { lang: 'fr', delivery: 'thrown' },
  { lang: 'en', delivery: 'returned' },
  { lang: 'en', delivery: 'thrown' },
]
test.each(unauthorizedCases)('a deferred $delivery detail 401 redirects in $lang without reading erasure or exposing an error', async ({ lang, delivery }) => {
  const { context, match, parent } = fixture(lang), read = createControlledPromise<RequestDetailDto | Response>()
  rpc.getRequestDetail.mockReturnValue(read)
  parent.resolve(match)
  const pending = loader(context)
  await Promise.resolve()
  expect(rpc.getRequestDetail).toHaveBeenCalledOnce()
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
  const rejected = expect(pending).rejects.toMatchObject({ status: 307, options: { to: '/login', search: { lang, error: undefined } } })
  const unauthorized = new Response('private-detail-401', { status: 401 })
  if (delivery === 'returned') read.resolve(unauthorized)
  else read.reject(unauthorized)
  await rejected
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
})

test.each(unauthorizedCases)('a deferred $delivery erasure 401 redirects in $lang with error undefined', async ({ lang, delivery }) => {
  const { context, match, parent } = fixture(lang), read = createControlledPromise<EraseReceipt | Response>(), dispatched = createControlledPromise<void>()
  rpc.getRequestDetail.mockRejectedValue(new Response('private-detail-404', { status: 404 }))
  rpc.getRequestErasure.mockImplementation(() => { dispatched.resolve(undefined); return read })
  parent.resolve(match)
  const pending = loader(context)
  await dispatched
  expect(rpc.getRequestErasure).toHaveBeenCalledOnce()
  const rejected = expect(pending).rejects.toMatchObject({ status: 307, options: { to: '/login', search: { lang, error: undefined } } })
  const unauthorized = new Response('private-erasure-401', { status: 401 })
  if (delivery === 'returned') read.resolve(unauthorized)
  else read.reject(unauthorized)
  await rejected
  expect(rpc.getRequestDetail).toHaveBeenCalledOnce()
})

test.each([403, 503])('a returned detail %i is sanitized without falling back to erasure', async status => {
  const { context, match, parent } = fixture()
  rpc.getRequestDetail.mockResolvedValue(new Response('private-detail-response', { status }))
  parent.resolve(match)
  await expect(loader(context)).rejects.toEqual(new Error('Request unavailable'))
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
})

test.each([
  { name: 'Error', failure: new Error('private-detail-error') },
  { name: 'opaque value', failure: { private: 'detail-value' } },
])('a detail $name is sanitized without falling back to erasure', async ({ failure }) => {
  const { context, match, parent } = fixture()
  rpc.getRequestDetail.mockRejectedValue(failure)
  parent.resolve(match)
  await expect(loader(context)).rejects.toEqual(new Error('Request unavailable'))
  expect(rpc.getRequestErasure).not.toHaveBeenCalled()
})

test.each([404, 503])('a returned erasure %i closes safely after the single detail fallback', async status => {
  const { context, match, parent } = fixture()
  rpc.getRequestDetail.mockResolvedValue(new Response('private-detail-404', { status: 404 }))
  rpc.getRequestErasure.mockResolvedValue(new Response('private-erasure-response', { status }))
  parent.resolve(match)
  await expect(loader(context)).rejects.toEqual(new Error('Request unavailable'))
  expect(rpc.getRequestDetail).toHaveBeenCalledOnce()
  expect(rpc.getRequestErasure).toHaveBeenCalledOnce()
})

test('an unknown erasure rejection closes without exposing its payload or loaded detail', async () => {
  const { context, match, parent } = fixture()
  rpc.getRequestDetail.mockRejectedValue(new Response('private-detail-404', { status: 404 }))
  rpc.getRequestErasure.mockRejectedValue({ private: 'erasure-value' })
  parent.resolve(match)
  await expect(loader(context)).rejects.toEqual(new Error('Request unavailable'))
  expect(rpc.getRequestDetail).toHaveBeenCalledOnce()
  expect(rpc.getRequestErasure).toHaveBeenCalledOnce()
})
