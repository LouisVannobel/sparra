import { expect, test } from 'vitest'
import { billingActionIsLive, canStartBillingAction, executeBillingAction } from '../../src/ui/billing/billing-action'
import type { BillingInput, BillingSummary } from '../../src/modules/billing/checkout.server'
import type { WorkspaceDto } from '../../src/modules/workspaces/personal.server'

type ActionOperations = Parameters<typeof executeBillingAction>[3]
type Operations = { -readonly [Key in keyof ActionOperations]: ActionOperations[Key] }
type Action = Parameters<typeof executeBillingAction>[0]
type Step = 'workspace:1' | 'billing' | 'checkout' | 'workspace:2' | 'cancel'
type FixtureState = { live: boolean; workspace: WorkspaceDto | null; checkoutUrl: string; cancellation: string }
const workspace: WorkspaceDto = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Owned workspace' }
const summary: BillingSummary = { availability: 'available', state: 'not-started', paidThrough: null, cancellation: 'none' }
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_ownedMarker'

function fixture(pause?: Step) {
  const trace: string[] = [], published: Parameters<Operations['publish']>[0][] = [], assigned: string[] = []
  const requests: { operation: string; data: BillingInput | Record<string, never>; signal: AbortSignal }[] = []
  const state: FixtureState = {
    live: true, workspace, checkoutUrl, cancellation: 'confirmed',
  }
  const controller = new AbortController()
  let release = () => {}, entered = () => {}, workspaceReads = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  async function read(step: Step) {
    trace.push(step)
    if (step === pause) { entered(); await held }
  }
  const operations: Operations = {
    workspaceRead: async input => {
      requests.push({ operation: 'workspace', ...input })
      workspaceReads++
      await read(workspaceReads === 1 ? 'workspace:1' : 'workspace:2')
      return state.workspace
    },
    billingRead: async input => {
      requests.push({ operation: 'billing', ...input }); await read('billing'); return summary
    },
    checkout: async input => {
      requests.push({ operation: 'checkout', ...input }); await read('checkout'); return { url: state.checkoutUrl }
    },
    cancel: async input => {
      requests.push({ operation: 'cancel', ...input }); await read('cancel'); return { state: state.cancellation }
    },
    publish: data => { trace.push('publish'); published.push(data) },
    assign: href => { trace.push('assign'); assigned.push(href) },
    handOff: () => { trace.push('handoff') },
    invalidate: async () => { trace.push('invalidate') },
  }
  const lifetime = { signal: controller.signal, live: () => { trace.push('live'); return state.live } }
  return { trace, published, assigned, requests, state, controller, operations, lifetime, started, release }
}

test.each([
  { action: 'refresh', trace: ['workspace:1', 'live', 'billing', 'live', 'publish'], financial: 'billing' },
  { action: 'checkout', trace: ['workspace:1', 'live', 'checkout', 'live', 'workspace:2', 'live', 'assign', 'handoff'], financial: 'checkout' },
  { action: 'cancel', trace: ['workspace:1', 'live', 'cancel', 'live', 'invalidate'], financial: 'cancel' },
] satisfies { action: Action; trace: string[]; financial: string }[])('$action revalidates the principal before the selected action and forwards only the Workspace and same signal', async row => {
  const f = fixture()
  await executeBillingAction(row.action, row.action === 'refresh' ? undefined : workspace.id, f.lifetime, f.operations)
  expect(f.trace).toEqual(row.trace)
  expect(f.requests).toEqual(row.action === 'checkout' ? [
    { operation: 'workspace', data: {}, signal: f.controller.signal },
    { operation: row.financial, data: { workspaceId: workspace.id }, signal: f.controller.signal },
    { operation: 'workspace', data: {}, signal: f.controller.signal },
  ] : [
    { operation: 'workspace', data: {}, signal: f.controller.signal },
    { operation: row.financial, data: { workspaceId: workspace.id }, signal: f.controller.signal },
  ])
  expect(f.published).toEqual(row.action === 'refresh' ? [{ workspace, summary }] : [])
  expect(f.assigned).toEqual(row.action === 'checkout' ? [checkoutUrl] : [])
})

test('refresh without a Workspace publishes the empty DTO without a Billing read', async () => {
  const f = fixture(); f.state.workspace = null
  await executeBillingAction('refresh', undefined, f.lifetime, f.operations)
  expect(f.trace).toEqual(['workspace:1', 'live', 'live', 'publish'])
  expect(f.published).toEqual([{ workspace: null, summary: null }])
  expect(f.requests).toEqual([{ operation: 'workspace', data: {}, signal: f.controller.signal }])
})

test.each(['refresh', 'checkout', 'cancel'] satisfies Action[])('%s refuses a selected Workspace that no longer matches before any financial operation', async action => {
  const f = fixture()
  await expect(executeBillingAction(action, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', f.lifetime, f.operations)).rejects.toThrow('Billing unavailable')
  expect(f.trace).toEqual(['workspace:1', 'live'])
  expect(f.published).toEqual([]); expect(f.assigned).toEqual([])
})

test.each(['checkout', 'cancel'] satisfies Action[])('%s requires both a selected and currently present Workspace', async action => {
  for (const selected of [undefined, workspace.id]) {
    const f = fixture()
    if (selected) f.state.workspace = null
    await expect(executeBillingAction(action, selected, f.lifetime, f.operations)).rejects.toThrow('Billing unavailable')
    expect(f.trace).toEqual(['workspace:1', 'live'])
    expect(f.published).toEqual([]); expect(f.assigned).toEqual([])
  }
})

test.each([
  { action: 'refresh', step: 'workspace:1', trace: ['workspace:1', 'live'] },
  { action: 'refresh', step: 'billing', trace: ['workspace:1', 'live', 'billing', 'live'] },
  { action: 'checkout', step: 'checkout', trace: ['workspace:1', 'live', 'checkout', 'live'] },
  { action: 'checkout', step: 'workspace:2', trace: ['workspace:1', 'live', 'checkout', 'live', 'workspace:2', 'live'] },
  { action: 'cancel', step: 'cancel', trace: ['workspace:1', 'live', 'cancel', 'live'] },
] satisfies { action: Action; step: Step; trace: string[] }[])('$action abandons a result that becomes stale during $step', async row => {
  const f = fixture(row.step)
  const running = executeBillingAction(row.action, workspace.id, f.lifetime, f.operations)
  try {
    await f.started
    f.state.live = false; f.release()
    await running
    expect(f.trace).toEqual(row.trace)
    expect(f.published).toEqual([]); expect(f.assigned).toEqual([])
    expect(f.controller.signal.aborted).toBe(false)
  } finally { f.release(); await running }
})

test.each([
  'https://checkout.stripe.com.evil.invalid/c/pay/cs_test_ownedMarker',
  'http://checkout.stripe.com/c/pay/cs_test_ownedMarker',
  'https://checkout.stripe.com:444/c/pay/cs_test_ownedMarker',
  'https://user@checkout.stripe.com/c/pay/cs_test_ownedMarker',
  'https://:password@checkout.stripe.com/c/pay/cs_test_ownedMarker',
  'https://checkout.stripe.com/foreign/cs_test_ownedMarker',
  'https://checkout.stripe.com/c/pay/cs_test_ownedMarker/extra',
  'https://checkout.stripe.com/c/pay/cs_test_owned-Marker',
])('Checkout refuses an unapproved destination before the second principal read: %s', async url => {
  const f = fixture(); f.state.checkoutUrl = url
  await expect(executeBillingAction('checkout', workspace.id, f.lifetime, f.operations)).rejects.toThrow('Billing unavailable')
  expect(f.trace).toEqual(['workspace:1', 'live', 'checkout', 'live'])
  expect(f.assigned).toEqual([])
})

test('malformed Checkout URL preserves the URL error and never hands off', async () => {
  const f = fixture(); f.state.checkoutUrl = '/relative-destination'
  await expect(executeBillingAction('checkout', workspace.id, f.lifetime, f.operations)).rejects.toBeInstanceOf(TypeError)
  expect(f.trace).toEqual(['workspace:1', 'live', 'checkout', 'live'])
  expect(f.assigned).toEqual([])
})

test.each([
  'https://checkout.stripe.com/c/pay/cs_test_ownedMarker?prefilled_email=fixture%40example.test#payment',
  'https://checkout.stripe.com/c/pay/cs_live_ownedMarker?locale=fr#payment',
])('Checkout preserves admitted query and fragment after revalidating the same Workspace: %s', async url => {
  const f = fixture(); f.state.checkoutUrl = url
  await executeBillingAction('checkout', workspace.id, f.lifetime, f.operations)
  expect(f.trace).toEqual(['workspace:1', 'live', 'checkout', 'live', 'workspace:2', 'live', 'assign', 'handoff'])
  expect(f.assigned).toEqual([url])
})

test.each([null, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Other workspace' }])('Checkout refuses a changed or missing principal at the second read', async next => {
  const f = fixture('checkout')
  const running = executeBillingAction('checkout', workspace.id, f.lifetime, f.operations)
  await f.started; f.state.workspace = next; f.release()
  await expect(running).rejects.toThrow('Billing unavailable')
  expect(f.trace).toEqual(['workspace:1', 'live', 'checkout', 'live', 'workspace:2', 'live'])
  expect(f.assigned).toEqual([])
})

test('a failed location assignment preserves its error without handoff', async () => {
  const f = fixture(), failure = new Error('Synthetic location failure')
  f.operations.assign = () => { f.trace.push('assign'); throw failure }
  await expect(executeBillingAction('checkout', workspace.id, f.lifetime, f.operations)).rejects.toBe(failure)
  expect(f.trace).toEqual(['workspace:1', 'live', 'checkout', 'live', 'workspace:2', 'live', 'assign'])
})

test.each(['pending', 'incident', 'unavailable'])('cancellation acknowledgement %s never invalidates or publishes', async state => {
  const f = fixture(); f.state.cancellation = state
  await expect(executeBillingAction('cancel', workspace.id, f.lifetime, f.operations)).rejects.toThrow('Billing unavailable')
  expect(f.trace).toEqual(['workspace:1', 'live', 'cancel', 'live'])
  expect(f.published).toEqual([])
})

test('a confirmed cancellation awaits invalidation and preserves its failure', async () => {
  const f = fixture(), failure = new Error('Synthetic invalidation failure')
  f.operations.invalidate = async () => { f.trace.push('invalidate'); throw failure }
  await expect(executeBillingAction('cancel', workspace.id, f.lifetime, f.operations)).rejects.toBe(failure)
  expect(f.trace).toEqual(['workspace:1', 'live', 'cancel', 'live', 'invalidate'])
})

test.each([
  { action: 'refresh', step: 'workspace:1' },
  { action: 'refresh', step: 'billing' },
  { action: 'checkout', step: 'checkout' },
  { action: 'checkout', step: 'workspace:2' },
  { action: 'cancel', step: 'cancel' },
] satisfies { action: Action; step: Step }[])('$action propagates returned and thrown Responses at $step without later publication or navigation', async row => {
  for (const kind of ['returned', 'thrown']) {
    const f = fixture(), response = new Response('Synthetic unauthorized', { status: 401 })
    async function refuse() { if (kind === 'thrown') throw response; return response }
    if (row.step === 'billing') f.operations.billingRead = refuse
    else if (row.step === 'checkout') f.operations.checkout = refuse
    else if (row.step === 'cancel') f.operations.cancel = refuse
    else if (row.step === 'workspace:1') f.operations.workspaceRead = refuse
    else f.operations.workspaceRead = async () => f.trace.includes('checkout') ? refuse() : workspace
    await expect(executeBillingAction(row.action, workspace.id, f.lifetime, f.operations)).rejects.toBe(response)
    expect(f.published).toEqual([]); expect(f.assigned).toEqual([])
    expect(f.trace).not.toContain('invalidate'); expect(f.trace).not.toContain('handoff')
  }
})

test('a returned unauthorized response from a stale read stays inert before route-level error handling', async () => {
  const f = fixture(), response = new Response('Synthetic stale unauthorized', { status: 401 })
  f.operations.billingRead = async () => { f.state.live = false; return response }
  await executeBillingAction('refresh', workspace.id, f.lifetime, f.operations)
  expect(f.published).toEqual([]); expect(f.assigned).toEqual([])
  expect(f.trace).toEqual(['workspace:1', 'live', 'live'])
})

type AdmissionContext = Parameters<typeof canStartBillingAction>[1]
type CurrentBillingContext = Parameters<typeof billingActionIsLive>[0]

function billingContext(controller = new AbortController()) {
  const captured = { controller, source: { workspace, summary }, locale: 'en' as const, href: '/billing?lang=en' }
  const current: CurrentBillingContext = {
    mounted: true, operation: controller, source: captured.source, locale: 'en', href: captured.href, pathname: '/billing',
  }
  return { captured, current }
}

test.each(['refresh', 'checkout', 'cancel'] satisfies Action[])('%s admission requires current hydration, mount and a free operation before starting', action => {
  const current: AdmissionContext = { hydrated: true, mounted: true, operation: undefined, data: { workspace, summary } }
  expect(canStartBillingAction(action, current)).toBe(true)
  for (const refused of [
    { ...current, hydrated: false },
    { ...current, mounted: false },
    { ...current, operation: new AbortController() },
  ]) expect(canStartBillingAction(action, refused)).toBe(false)
})

test.each(['checkout', 'cancel'] satisfies Action[])('%s admission refuses absent display data and an absent financial Workspace', action => {
  for (const data of [null, { workspace: null, summary: null }]) {
    expect(canStartBillingAction(action, { hydrated: true, mounted: true, operation: undefined, data })).toBe(false)
  }
})

test('Refresh admission remains available with no display data or Workspace', () => {
  for (const data of [null, { workspace: null, summary: null }]) {
    expect(canStartBillingAction('refresh', { hydrated: true, mounted: true, operation: undefined, data })).toBe(true)
  }
})

test('Billing freshness admits only the same owned action and current route context', () => {
  const f = billingContext()
  expect(billingActionIsLive(f.current, f.captured)).toBe(true)
  expect(billingActionIsLive({ ...f.current, source: f.captured.source }, f.captured)).toBe(true)
  expect(f.captured.controller.signal.aborted).toBe(false)
})

test.each([
  { name: 'unmounted route', change: (current: CurrentBillingContext) => ({ ...current, mounted: false }) },
  { name: 'released operation', change: (current: CurrentBillingContext) => ({ ...current, operation: undefined }) },
  { name: 'another non-aborted operation', change: (current: CurrentBillingContext) => ({ ...current, operation: new AbortController() }) },
  { name: 'missing loader source', change: (current: CurrentBillingContext) => ({ ...current, source: undefined }) },
  { name: 'equal loader contents under a new identity', change: (current: CurrentBillingContext) => ({ ...current, source: { workspace, summary } }) },
  { name: 'changed locale with the same href', change: (current: CurrentBillingContext) => ({ ...current, locale: 'fr' as const }) },
  { name: 'changed href on the same pathname', change: (current: CurrentBillingContext) => ({ ...current, href: '/billing?lang=en#later' }) },
  { name: 'departed pathname with the same captured href', change: (current: CurrentBillingContext) => ({ ...current, pathname: '/account' }) },
] satisfies { name: string; change(current: CurrentBillingContext): CurrentBillingContext }[])('Billing freshness refuses $name independently', row => {
  const f = billingContext(), current = row.change(f.current)
  expect(billingActionIsLive(current, f.captured)).toBe(false)
  expect(f.captured.controller.signal.aborted).toBe(false)
})

test('Billing freshness refuses the captured aborted signal even when operation and every context value still match', () => {
  const f = billingContext()
  f.captured.controller.abort()
  expect(f.current.operation).toBe(f.captured.controller)
  expect(billingActionIsLive(f.current, f.captured)).toBe(false)
})

test.each([
  { action: 'refresh', step: 'billing', divergence: 'locale' },
  { action: 'checkout', step: 'checkout', divergence: 'source' },
  { action: 'checkout', step: 'workspace:2', divergence: 'locale' },
  { action: 'cancel', step: 'cancel', divergence: 'source' },
] satisfies { action: Action; step: Step; divergence: 'source' | 'locale' }[])('$action uses the real freshness predicate after $step when the current $divergence changes', async row => {
  const f = fixture(row.step), context = billingContext(f.controller)
  let current = context.current
  f.lifetime.live = () => billingActionIsLive({ ...current }, context.captured)
  const running = executeBillingAction(row.action, workspace.id, f.lifetime, f.operations)
  try {
    await f.started
    current = row.divergence === 'source'
      ? { ...current, source: { workspace, summary } }
      : { ...current, locale: 'fr' }
    f.release(); await running
    expect(f.published).toEqual([]); expect(f.assigned).toEqual([])
    expect(f.trace).not.toContain('invalidate'); expect(f.trace).not.toContain('handoff')
    expect(f.controller.signal.aborted).toBe(false)
  } finally { f.release(); await running }
})
