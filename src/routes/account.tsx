import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useRef, useState } from 'react'
import { getAccount, logout, beginAdditionalPasskey, authorizeAdditionalPasskey, finishAdditionalPasskey } from '../modules/auth/auth.functions'
import { beginFirstGooglePasskey, readFirstGooglePasskey, prepareFirstGooglePasskey, finishFirstGooglePasskey, cancelFirstGooglePasskey } from '../modules/auth/auth.functions'
import { beginGoogleAccountLink, authorizeGoogleAccountLink, beginGoogleAccountUnlink, finishGoogleAccountUnlink, readGoogleAccountIntent, cancelGoogleAccountIntent } from '../modules/auth/auth.functions'
import { beginSessionList, finishSessionList, beginSessionRevocation, finishSessionRevocation } from '../modules/auth/auth.functions'
import { AccountPanel } from '../ui/auth/auth-panels'
import { messages } from '../ui/auth/messages'

export const Route = createFileRoute('/account')({
  head: ({ match }) => ({ meta: [{ title: messages[match.search.lang].account }] }),
  validateSearch: (search: Record<string, unknown>) => ({
    firstPasskey: typeof search.firstPasskey === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.firstPasskey) ? search.firstPasskey : undefined,
    googleAccount: typeof search.googleAccount === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.googleAccount) ? search.googleAccount : undefined,
  }),
  loader: async () => {
    try {
      const result = await getAccount()
      // Client RPC returns raw Responses; the SSR call can throw them.
      if (result instanceof Response) throw result
      return result
    } catch { throw new Error('Account unavailable') }
  }, component: Account, errorComponent: AccountUnavailable,
  pendingMs: 150, pendingMinMs: 150,
  pendingComponent: () => { const { lang } = Route.useSearch(); return <main className="auth-content"><p role="status">{messages[lang].loading}</p></main> },
})
function AccountUnavailable() {
  const { lang } = Route.useSearch()
  return <main className="auth-content"><h1>{messages[lang].account}</h1><p role="alert">{messages[lang].accountLoadFailed}</p><a href={`/login?lang=${lang}`}>{messages[lang].back}</a></main>
}
function Account() {
  const { lang, firstPasskey, googleAccount } = Route.useSearch()
  const loaded = Route.useLoaderData()
  const loadedRef = useRef(loaded); loadedRef.current = loaded
  const [display, setDisplay] = useState({ source: loaded, principal: loaded, refused: false })
  // A later authoritative loader result always supersedes a local display refresh.
  const principal = display.source === loaded ? display.principal : loaded
  const signOut = useServerFn(logout)
  const begin = useServerFn(beginAdditionalPasskey), authorize = useServerFn(authorizeAdditionalPasskey), finish = useServerFn(finishAdditionalPasskey)
  const refresh = useServerFn(getAccount)
  const firstBegin = useServerFn(beginFirstGooglePasskey), firstRead = useServerFn(readFirstGooglePasskey), firstPrepare = useServerFn(prepareFirstGooglePasskey)
  const firstFinish = useServerFn(finishFirstGooglePasskey), firstCancel = useServerFn(cancelFirstGooglePasskey)
  const googleBegin = useServerFn(beginGoogleAccountLink), googleAuthorize = useServerFn(authorizeGoogleAccountLink), googleUnlink = useServerFn(beginGoogleAccountUnlink)
  const googleFinish = useServerFn(finishGoogleAccountUnlink), googleRead = useServerFn(readGoogleAccountIntent), googleCancel = useServerFn(cancelGoogleAccountIntent)
  const listBegin = useServerFn(beginSessionList), listFinish = useServerFn(finishSessionList)
  const revokeBegin = useServerFn(beginSessionRevocation), revokeFinish = useServerFn(finishSessionRevocation)
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  async function onAccountChanged(signal: AbortSignal) {
    const live = () => !signal.aborted && loadedRef.current === loaded && router.state.location.pathname === '/account'
    if (!live()) return
    try {
      const result = await refresh({ signal }).catch(error => { if (error instanceof Response) return error; throw error })
      if (!live()) return
      if (result instanceof Response ? result.status === 401 : result.userId !== loaded.userId) {
        // Never retain private UI after an actual principal refusal/change.
        setDisplay({ source: loaded, principal: loaded, refused: true })
        await router.invalidate({ sync: true }); return
      }
      if (result instanceof Response) throw new Error('Account refresh unavailable')
      // This is the one protected refresh, not a preflight before a second loader read.
      setDisplay({ source: loaded, principal: result, refused: false })
    } catch (error) { if (live()) throw error }
  }
  async function onLogout() {
    if (pending) return
    setPending(true); setFailed(false)
    try {
      const result = await signOut()
      if (!result || result instanceof Response || result.signedOut !== true) throw new Error('Sign-out unavailable')
      window.location.assign(`/login?lang=${lang}`)
    }
    catch { setFailed(true); setPending(false) }
  }
  if (display.source === loaded && display.refused) return <AccountUnavailable />
  return <AccountPanel locale={lang} principal={principal} pending={pending} failed={failed} onLogout={onLogout}
    sessions={{ locale: lang, userId: principal.userId, available: principal.sessionManagement,
      onBeginList: (data, signal) => listBegin({ data, signal }), onFinishList: (data, signal) => listFinish({ data, signal }),
      onBeginRevocation: (data, signal) => revokeBegin({ data, signal }), onFinishRevocation: (data, signal) => revokeFinish({ data, signal }),
      onRefused: async () => { setDisplay({ source: loaded, principal: loaded, refused: true }); await router.invalidate({ sync: true }) } }}
    googleAccount={{ locale: lang, userId: principal.userId, connection: principal.googleAccount, intentId: googleAccount,
      onBeginLink: signal => googleBegin({ data: lang, signal }), onAuthorize: (data, signal) => googleAuthorize({ data, signal }),
      onBeginUnlink: (data, signal) => googleUnlink({ data, signal }), onFinishUnlink: (data, signal) => googleFinish({ data, signal }),
      onRead: (data, signal) => googleRead({ data, signal }), onCancel: (data, signal) => googleCancel({ data, signal }), onChanged: onAccountChanged,
      onRefused: async () => { setDisplay({ source: loaded, principal: loaded, refused: true }); await router.invalidate({ sync: true }) } }}
    firstGoogle={principal.passkeys.length === 0 || firstPasskey ? { locale: lang, userId: principal.userId, available: principal.firstGooglePasskey, intentId: firstPasskey,
      onBegin: signal => firstBegin({ data: lang, signal }), onRead: (data, signal) => firstRead({ data, signal }),
      onPrepare: (data, signal) => firstPrepare({ data, signal }), onFinish: (data, signal) => firstFinish({ data, signal }),
      onCancel: (data, signal) => firstCancel({ data, signal }), onAdded: onAccountChanged } : undefined}
    additional={{ locale: lang, userId: principal.userId, availability: principal.additionalPasskey, passkeys: principal.passkeys,
      onBegin: signal => begin({ signal }), onAuthorize: (data, signal) => authorize({ data, signal }),
      onFinish: (data, signal) => finish({ data, signal }), onRefresh: async signal => {
        const result = await refresh({ signal })
        // A service failure cannot resolve an uncertain addition. A principal
        // refusal still invalidates the private route through its real loader.
        if (result instanceof Response && result.status !== 401) return result
        if (!signal.aborted) await router.invalidate({ sync: true })
        return result
      } }} />
}
