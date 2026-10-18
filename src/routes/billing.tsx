import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { createFileRoute, redirect, useHydrated, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'
import { getWorkspace } from '../modules/workspaces/workspace.functions'
import { getBilling, startBillingCheckout, cancelBillingAtPeriodEnd } from '../modules/billing/billing.functions'
import type { BillingSummary } from '../modules/billing/checkout.server'
import type { WorkspaceDto } from '../modules/workspaces/personal.server'
import { BillingPanel } from '../ui/billing/billing-panel'
import { billingMessages } from '../ui/billing/messages'
import { AppShell } from '../ui/sparra/app-shell'
import stylesheet from '../ui/sparra/sparra.css?url'

export const Route = createFileRoute('/billing')({
  gcTime: 0, preload: false, shouldReload: true,
  loaderDeps: ({ search }) => ({ lang: search.lang }),
  head: ({ match }) => ({ meta: [{ title: billingMessages[match.search.lang].title }], links: [{ rel: 'stylesheet', href: stylesheet }] }),
  loader: { staleReloadMode: 'blocking', handler: async ({ deps, abortController }) => {
    try {
      const workspace = await getWorkspace({ data: {}, signal: abortController.signal })
      if (workspace instanceof Response) throw workspace
      if (!workspace) return { workspace: null, summary: null }
      const summary = await getBilling({ data: { workspaceId: workspace.id }, signal: abortController.signal })
      if (summary instanceof Response) throw summary
      return { workspace, summary }
    } catch (error) {
      if (error instanceof Response && error.status === 401) throw redirect({ to: '/login', search: { lang: deps.lang, error: undefined } })
      throw new Error('Billing unavailable')
    }
  } },
  component: Billing,
  errorComponent: function BillingError() { const { lang } = Route.useSearch(); return <AppShell locale={lang}><BillingUnavailable/></AppShell> },
  pendingMs: 150, pendingMinMs: 150,
  pendingComponent: function BillingPending() {
    const { lang } = Route.useSearch()
    return <AppShell locale={lang}><section className="sparra-app-state"><Heading level={1}>{billingMessages[lang].title}</Heading><p role="status">{billingMessages[lang].loading}</p></section></AppShell>
  },
})

function BillingUnavailable({ onRefresh, pending = false, focusIssue = false }: { onRefresh?(): Promise<void>; pending?: boolean; focusIssue?: boolean }) {
  const { lang } = Route.useSearch(), t = billingMessages[lang], hydrated = useHydrated()
  const message = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (focusIssue && !pending) message.current?.focus()
  }, [focusIssue, pending])
  return <section className="sparra-app-state sparra-billing" aria-busy={pending}><Heading level={1}>{t.title}</Heading>
    <p ref={message} tabIndex={-1} role={pending ? 'status' : 'alert'}>{pending ? t.busy : t.failed}</p>
    <a href={`/login?lang=${lang}`}>{t.login}</a><a href={`/account?lang=${lang}`}>{t.account}</a>
    {onRefresh && <Button label={t.refresh} size="lg" variant="secondary" isDisabled={!hydrated || pending} onClick={() => { if (!pending) void onRefresh() }}/>}
  </section>
}

type Loaded = { workspace: WorkspaceDto | null; summary: BillingSummary | null }
function Billing() {
  const { lang } = Route.useSearch(), loaded = Route.useLoaderData(), router = useRouter(), hydrated = useHydrated()
  const workspaceRead = useServerFn(getWorkspace), billingRead = useServerFn(getBilling)
  const checkout = useServerFn(startBillingCheckout), cancel = useServerFn(cancelBillingAtPeriodEnd)
  const latest = useRef({ loaded, lang }); latest.current = { loaded, lang }
  const mounted = useRef(false), operation = useRef<AbortController | undefined>(undefined)
  const [display, setDisplay] = useState<{ source: typeof loaded; data: Loaded | null; pending: boolean; focusIssue: boolean }>({ source: loaded, data: loaded ?? null, pending: false, focusIssue: false })
  const current = display.source === loaded ? display : { source: loaded, data: loaded ?? null, pending: false, focusIssue: false }
  useEffect(() => {
    mounted.current = true
    const hide = () => {
      operation.current?.abort(); operation.current = undefined
      setDisplay({ source: latest.current.loaded, data: null, pending: false, focusIssue: false })
    }
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) void router.invalidate({ sync: true }).catch(() => {})
    }
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', restore)
    return () => {
      mounted.current = false; operation.current?.abort(); operation.current = undefined
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore)
    }
  }, [loaded, lang, router])

  async function run(action: 'refresh' | 'checkout' | 'cancel') {
    if (!hydrated || !mounted.current || operation.current || action !== 'refresh' && !current.data?.workspace) return
    const controller = new AbortController(), source = loaded, locale = lang, href = router.state.location.href
    const selected = current.data?.workspace?.id
    operation.current = controller
    const live = () => mounted.current && operation.current === controller && !controller.signal.aborted
      && latest.current.loaded === source && latest.current.lang === locale && router.state.location.href === href
      && router.state.location.pathname === '/billing'
    setDisplay({ source, data: current.data, pending: true, focusIssue: false })
    let handedOff = false
    try {
      const workspace = await workspaceRead({ data: {}, signal: controller.signal })
      if (!live()) return
      if (workspace instanceof Response) throw workspace
      if (selected && workspace?.id !== selected) throw new Error('Billing unavailable')
      if (action !== 'refresh') {
        if (!workspace || workspace.id !== selected) throw new Error('Billing unavailable')
        if (action === 'checkout') {
          const result = await checkout({ data: { workspaceId: workspace.id }, signal: controller.signal })
          if (!live()) return
          if (result instanceof Response) throw result
          const destination = new URL(result.url)
          if (destination.origin !== 'https://checkout.stripe.com' || destination.username || destination.password
            || !/^\/c\/pay\/cs_(test|live)_[A-Za-z0-9]+$/.test(destination.pathname)) throw new Error('Billing unavailable')
          const principalWorkspace = await workspaceRead({ data: {}, signal: controller.signal })
          if (!live()) return
          if (principalWorkspace instanceof Response) throw principalWorkspace
          if (principalWorkspace?.id !== workspace.id) throw new Error('Billing unavailable')
          window.location.assign(destination.href); handedOff = true; return
        }
        const result = await cancel({ data: { workspaceId: workspace.id }, signal: controller.signal })
        if (!live()) return
        if (result instanceof Response) throw result
        if (result.state !== 'confirmed') throw new Error('Billing unavailable')
        await router.invalidate({ sync: true })
        return
      }
      const summary = workspace ? await billingRead({ data: { workspaceId: workspace.id }, signal: controller.signal }) : null
      if (!live()) return
      if (summary instanceof Response) throw summary
      setDisplay({ source, data: { workspace, summary }, pending: false, focusIssue: false })
    } catch (error) {
      if (!live()) return
      setDisplay({ source, data: null, pending: false, focusIssue: true })
      if (error instanceof Response && error.status === 401) {
        await router.navigate({ to: '/login', search: { lang: locale, error: undefined } }).catch(() => {})
      }
    } finally {
      if (!handedOff) {
        if (live()) setDisplay(value => value.source === source ? { ...value, pending: false } : value)
        if (operation.current === controller) operation.current = undefined
      }
    }
  }
  return <AppShell locale={lang}>{current.data
    ? <BillingPanel locale={lang} workspace={current.data.workspace} summary={current.data.summary} pending={current.pending} failed={false}
      onCheckout={() => run('checkout')} onCancel={() => run('cancel')} onRefresh={() => run('refresh')}/>
    : <BillingUnavailable pending={current.pending} focusIssue={current.focusIssue} onRefresh={() => run('refresh')}/>}</AppShell>
}
