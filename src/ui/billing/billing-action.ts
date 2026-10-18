import type { BillingInput, BillingSummary } from '../../modules/billing/checkout.server'
import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import type { Locale } from '../auth/messages'

export type BillingAction = 'refresh' | 'checkout' | 'cancel'
export type BillingActionData = { workspace: WorkspaceDto | null; summary: BillingSummary | null }
export type PendingBillingAction = Readonly<{ signal: AbortSignal; live(): boolean }>

type BillingActionAdmission = Readonly<{
  hydrated: boolean; mounted: boolean; operation: AbortController | undefined; data: BillingActionData | null
}>
type CapturedBillingAction = Readonly<{
  controller: AbortController; source: BillingActionData | undefined; locale: Locale; href: string
}>
type CurrentBillingAction = Readonly<{
  mounted: boolean; operation: AbortController | undefined; source: BillingActionData | undefined
  locale: Locale; href: string; pathname: string
}>

export function canStartBillingAction(action: BillingAction, current: BillingActionAdmission) {
  return !(!current.hydrated || !current.mounted || current.operation || action !== 'refresh' && !current.data?.workspace)
}

export function billingActionIsLive(current: CurrentBillingAction, captured: CapturedBillingAction) {
  return current.mounted && current.operation === captured.controller && !captured.controller.signal.aborted
    && current.source === captured.source && current.locale === captured.locale && current.href === captured.href
    && current.pathname === '/billing'
}

type WorkspaceRequest = Readonly<{ data: Record<string, never>; signal: AbortSignal }>
type BillingRequest = Readonly<{ data: BillingInput; signal: AbortSignal }>
type BillingActionOperations = Readonly<{
  workspaceRead(input: WorkspaceRequest): Promise<WorkspaceDto | null | Response>
  billingRead(input: BillingRequest): Promise<BillingSummary | Response>
  checkout(input: BillingRequest): Promise<Readonly<{ url: string }> | Response>
  cancel(input: BillingRequest): Promise<Readonly<{ state: string }> | Response>
  publish(data: BillingActionData): void
  assign(href: string): void
  handOff(): void
  invalidate(): Promise<void>
}>

async function refreshBilling(workspace: WorkspaceDto | null, action: PendingBillingAction, operations: BillingActionOperations) {
  const summary = workspace ? await operations.billingRead({ data: { workspaceId: workspace.id }, signal: action.signal }) : null
  if (!action.live()) return
  if (summary instanceof Response) throw summary
  operations.publish({ workspace, summary })
}

async function navigateToCheckout(workspace: WorkspaceDto, action: PendingBillingAction, operations: BillingActionOperations) {
  const result = await operations.checkout({ data: { workspaceId: workspace.id }, signal: action.signal })
  if (!action.live()) return
  if (result instanceof Response) throw result
  const destination = new URL(result.url)
  if (destination.origin !== 'https://checkout.stripe.com' || destination.username || destination.password
    || !/^\/c\/pay\/cs_(test|live)_[A-Za-z0-9]+$/.test(destination.pathname)) throw new Error('Billing unavailable')
  const principalWorkspace = await operations.workspaceRead({ data: {}, signal: action.signal })
  if (!action.live()) return
  if (principalWorkspace instanceof Response) throw principalWorkspace
  if (principalWorkspace?.id !== workspace.id) throw new Error('Billing unavailable')
  operations.assign(destination.href); operations.handOff()
}

async function cancelSubscription(workspace: WorkspaceDto, action: PendingBillingAction, operations: BillingActionOperations) {
  const result = await operations.cancel({ data: { workspaceId: workspace.id }, signal: action.signal })
  if (!action.live()) return
  if (result instanceof Response) throw result
  if (result.state !== 'confirmed') throw new Error('Billing unavailable')
  await operations.invalidate()
}

export async function executeBillingAction(action: BillingAction, selected: string | undefined, lifetime: PendingBillingAction,
  operations: BillingActionOperations): Promise<void> {
  const workspace = await operations.workspaceRead({ data: {}, signal: lifetime.signal })
  if (!lifetime.live()) return
  if (workspace instanceof Response) throw workspace
  if (selected && workspace?.id !== selected) throw new Error('Billing unavailable')
  if (action !== 'refresh') {
    if (!workspace || workspace.id !== selected) throw new Error('Billing unavailable')
    if (action === 'checkout') return await navigateToCheckout(workspace, lifetime, operations)
    return await cancelSubscription(workspace, lifetime, operations)
  }
  return await refreshBilling(workspace, lifetime, operations)
}
