import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { useHydrated } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import type { BillingSummary } from '../../modules/billing/checkout.server'
import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import type { Locale } from '../auth/messages'
import { observedDate } from '../sparra/app-shell'
import { billingMessages } from './messages'

type Props = Readonly<{
  locale: Locale; workspace: WorkspaceDto | null; summary: BillingSummary | null; pending: boolean; failed: boolean
  onCheckout(): Promise<void>; onCancel(): Promise<void>; onRefresh(): Promise<void>
}>

export function BillingPanel({ locale, workspace, summary, pending, failed, onCheckout, onCancel, onRefresh }: Props) {
  const t = billingMessages[locale], hydrated = useHydrated()
  const message = useRef<HTMLParagraphElement>(null), wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending) message.current?.focus()
    wasPending.current = pending
  }, [pending])
  const available = summary?.availability === 'available'
  const cancellation = summary?.cancellation ?? 'none'
  const issue = cancellation === 'incident' || summary?.state === 'incident' || summary?.state === 'held'
  const unresolved = summary?.state === 'customer-pending' || summary?.state === 'checkout-pending'
  const checkout = available && cancellation === 'none' && (summary.state === 'not-started' || summary.state === 'checkout-ready')
  const cancel = available && cancellation === 'none' && (summary.state === 'paid' || summary.state === 'subscription-present')
  const notice = failed ? t.failed : pending ? t.busy : !available ? t.unavailable
    : cancellation === 'incident' || summary.state === 'incident' ? t.incident : cancellation === 'confirmed' ? t.confirmed
      : cancellation === 'pending' || unresolved ? t.pending : summary.state === 'held' ? t.held
        : summary.state === 'paid' ? t.paid : summary.state === 'subscription-present' ? t.subscription : t.verification
  return <section className="sparra-billing" aria-busy={pending}>
    <header className="sparra-page-heading"><Heading level={1}>{t.title}</Heading><p>{t.monthly}</p></header>
    {workspace ? <div className="sparra-billing-summary">
      <p>{workspace.displayName}</p>
      <p ref={message} tabIndex={-1} role={failed || issue ? 'alert' : 'status'}>{notice}</p>
      {!available && <p>{t.negotiated}</p>}
      {available && summary.paidThrough && <p>{t.paidThrough}{' '}<time dateTime={summary.paidThrough}>{observedDate(summary.paidThrough, locale)}</time></p>}
      <div className="sparra-billing-actions">
        {checkout && <Button label={summary.state === 'checkout-ready' ? t.resume : t.checkout} size="lg"
          isDisabled={!hydrated || pending || failed} onClick={() => { if (!pending && !failed) void onCheckout() }} />}
        {cancel && <Button label={t.cancel} size="lg" isDisabled={!hydrated || pending || failed}
          onClick={() => { if (!pending && !failed) void onCancel() }} />}
        <Button label={t.refresh} variant="secondary" size="lg" isDisabled={!hydrated || pending}
          onClick={() => { if (!pending) void onRefresh() }} />
      </div>
    </div> : <div className="sparra-app-state"><p ref={message} tabIndex={-1} role={failed ? 'alert' : undefined}>{failed ? t.failed : t.empty}</p>
      <a href={`/workspace?lang=${locale}`}>{t.workspace}</a></div>}
  </section>
}
