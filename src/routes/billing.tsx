import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { createFileRoute, redirect, useHydrated, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'
import { getWorkspace } from '../modules/workspaces/workspace.functions'
import { getBilling, startBillingCheckout, cancelBillingAtPeriodEnd } from '../modules/billing/billing.functions'
import { BillingPanel } from '../ui/billing/billing-panel'
import { billingActionIsLive, canStartBillingAction, executeBillingAction, type BillingAction, type BillingActionData as Loaded, type PendingBillingAction } from '../ui/billing/billing-action'
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

  async function run(action: BillingAction) {
    if (!canStartBillingAction(action, { hydrated, mounted: mounted.current, operation: operation.current, data: current.data })) return
    const controller = new AbortController(), source = loaded, locale = lang, href = router.state.location.href
    const selected = current.data?.workspace?.id
    operation.current = controller
    const captured = { controller, source, locale, href }
    const live = () => billingActionIsLive({
      mounted: mounted.current, operation: operation.current, source: latest.current.loaded, locale: latest.current.lang,
      href: router.state.location.href, pathname: router.state.location.pathname,
    }, captured)
    setDisplay({ source, data: current.data, pending: true, focusIssue: false })
    let handedOff = false
    async function showFailure(error: unknown) {
      if (!live()) return
      setDisplay({ source, data: null, pending: false, focusIssue: true })
      if (error instanceof Response && error.status === 401) {
        await router.navigate({ to: '/login', search: { lang: locale, error: undefined } }).catch(() => {})
      }
    }
    function finishAction() {
      if (!handedOff) {
        if (live()) setDisplay(value => value.source === source ? { ...value, pending: false } : value)
        if (operation.current === controller) operation.current = undefined
      }
    }
    const lifetime: PendingBillingAction = { signal: controller.signal, live }
    try {
      return await executeBillingAction(action, selected, lifetime, {
        workspaceRead, billingRead, checkout, cancel,
        publish: data => setDisplay({ source, data, pending: false, focusIssue: false }),
        assign: href => window.location.assign(href),
        handOff: () => { handedOff = true },
        invalidate: () => router.invalidate({ sync: true }),
      })
    } catch (error) {
      await showFailure(error)
    } finally {
      finishAction()
    }
  }
  return <AppShell locale={lang}>{current.data
    ? <BillingPanel locale={lang} workspace={current.data.workspace} summary={current.data.summary} pending={current.pending} failed={false}
      onCheckout={() => run('checkout')} onCancel={() => run('cancel')} onRefresh={() => run('refresh')}/>
    : <BillingUnavailable pending={current.pending} focusIssue={current.focusIssue} onRefresh={() => run('refresh')}/>}</AppShell>
}
