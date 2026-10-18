import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { useHydrated } from '@tanstack/react-router'
import { useEffect, useRef, type RefObject } from 'react'
import type { BillingSummary } from '../../modules/billing/checkout.server'
import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import type { Locale } from '../auth/messages'
import { observedDate } from '../sparra/app-shell'
import { billingMessages } from './messages'

type Props = Readonly<{
  locale: Locale; workspace: WorkspaceDto | null; summary: BillingSummary | null; pending: boolean; failed: boolean
  onCheckout(): Promise<void>; onCancel(): Promise<void>; onRefresh(): Promise<void>
}>

function billingNotice(locale: Locale, summary: BillingSummary | null, pending: boolean, failed: boolean) {
  const t = billingMessages[locale]
  if (failed) return t.failed
  if (pending) return t.busy
  if (summary?.availability !== 'available') return t.unavailable
  const cancellation = summary.cancellation
  if (cancellation === 'incident' || summary.state === 'incident') return t.incident
  if (cancellation === 'confirmed') return t.confirmed
  if (cancellation === 'pending' || summary.state === 'customer-pending' || summary.state === 'checkout-pending') return t.pending
  if (summary.state === 'held') return t.held
  if (summary.state === 'paid') return t.paid
  if (summary.state === 'subscription-present') return t.subscription
  return t.verification
}

function billingAction(summary: BillingSummary | null) {
  const cancellation = summary?.cancellation ?? 'none'
  if (summary?.availability !== 'available' || cancellation !== 'none') return null
  if (summary.state === 'not-started') return 'checkout'
  if (summary.state === 'checkout-ready') return 'resume'
  if (summary.state === 'paid' || summary.state === 'subscription-present') return 'cancel'
  return null
}

function BillingActions({ locale, summary, pending, failed, onCheckout, onCancel, onRefresh, hydrated }:
  Pick<Props, 'locale' | 'summary' | 'pending' | 'failed' | 'onCheckout' | 'onCancel' | 'onRefresh'> & Readonly<{ hydrated: boolean }>) {
  const t = billingMessages[locale], action = billingAction(summary)
  return <div className="sparra-billing-actions">
    {(action === 'checkout' || action === 'resume') && <Button label={action === 'resume' ? t.resume : t.checkout} size="lg"
      isDisabled={!hydrated || pending || failed} onClick={() => { if (!pending && !failed) void onCheckout() }} />}
    {action === 'cancel' && <Button label={t.cancel} size="lg" isDisabled={!hydrated || pending || failed}
      onClick={() => { if (!pending && !failed) void onCancel() }} />}
    <Button label={t.refresh} variant="secondary" size="lg" isDisabled={!hydrated || pending}
      onClick={() => { if (!pending) void onRefresh() }} />
  </div>
}

function BillingWorkspaceSummary({ locale, workspace, summary, pending, failed, onCheckout, onCancel, onRefresh, hydrated, message }:
  Omit<Props, 'workspace'> & Readonly<{ workspace: WorkspaceDto; hydrated: boolean; message: RefObject<HTMLParagraphElement | null> }>) {
  const t = billingMessages[locale]
  const available = summary?.availability === 'available'
  const cancellation = summary?.cancellation ?? 'none'
  const issue = cancellation === 'incident' || summary?.state === 'incident' || summary?.state === 'held'
  const notice = billingNotice(locale, summary, pending, failed)
  return <div className="sparra-billing-summary">
    <p>{workspace.displayName}</p>
    <p ref={message} tabIndex={-1} role={failed || issue ? 'alert' : 'status'}>{notice}</p>
    {!available && <p>{t.negotiated}</p>}
    {available && summary.paidThrough && <p>{t.paidThrough}{' '}<time dateTime={summary.paidThrough}>{observedDate(summary.paidThrough, locale)}</time></p>}
    <BillingActions locale={locale} summary={summary} pending={pending} failed={failed} hydrated={hydrated}
      onCheckout={onCheckout} onCancel={onCancel} onRefresh={onRefresh}/>
  </div>
}

export function BillingPanel({ locale, workspace, summary, pending, failed, onCheckout, onCancel, onRefresh }: Props) {
  const t = billingMessages[locale], hydrated = useHydrated()
  const message = useRef<HTMLParagraphElement>(null), wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending) message.current?.focus()
    wasPending.current = pending
  }, [pending])
  return <section className="sparra-billing" aria-busy={pending}>
    <header className="sparra-page-heading"><Heading level={1}>{t.title}</Heading><p>{t.monthly}</p></header>
    {workspace ? <BillingWorkspaceSummary locale={locale} workspace={workspace} summary={summary} pending={pending} failed={failed}
      hydrated={hydrated} message={message} onCheckout={onCheckout} onCancel={onCancel} onRefresh={onRefresh}/>
      : <div className="sparra-app-state"><p ref={message} tabIndex={-1} role={failed ? 'alert' : undefined}>{failed ? t.failed : t.empty}</p>
      <a href={`/workspace?lang=${locale}`}>{t.workspace}</a></div>}
  </section>
}
