import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { beginGoogleSignIn, beginPasskeySignIn, finishPasskeySignIn, getLoginAvailability, requestMagicLink } from '../modules/auth/auth.functions'
import { LoginPanel } from '../ui/auth/auth-panels'
import { messages } from '../ui/auth/messages'

export const Route = createFileRoute('/login')({
  head: ({ match }) => ({ meta: [{ title: messages[match.search.lang].login }] }),
  validateSearch: (search: Record<string, unknown>) => ({ error: typeof search.error === 'string' ? 'auth_failed' : undefined }),
  loader: async () => {
    try {
      const result = await getLoginAvailability()
      // Client RPC returns raw Responses; the SSR call can throw them.
      if (result instanceof Response) throw result
      return result
    } catch { throw new Error('Sign-in unavailable') }
  }, component: Login,
  pendingMs: 150, pendingMinMs: 150,
  pendingComponent: () => { const { lang } = Route.useSearch(); return <main className="auth-content"><p role="status">{messages[lang].loading}</p></main> },
  errorComponent: () => { const { lang } = Route.useSearch(); return <main className="auth-content"><h1>{messages[lang].login}</h1><p role="alert">{messages[lang].loginLoadFailed}</p><a href={`/login?lang=${lang}`}>{messages[lang].back}</a></main> },
})
function Login() {
  const { lang, error } = Route.useSearch()
  const { google, magic, magicSignup, passkey } = Route.useLoaderData()
  const begin = useServerFn(beginGoogleSignIn)
  const beginPasskey = useServerFn(beginPasskeySignIn)
  const finishPasskey = useServerFn(finishPasskeySignIn)
  const requestLink = useServerFn(requestMagicLink)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(error !== undefined)
  async function onBegin() {
    if (pending) return
    setPending(true); setFailed(false)
    try {
      const result = await begin({ data: { locale: lang } })
      if (result instanceof Response) throw result
      window.location.assign(result.url)
    }
    catch { setFailed(true); setPending(false) }
  }
  return <LoginPanel locale={lang} enabled={google} pending={pending} failed={failed} onBegin={onBegin}
    passkey={passkey} onPasskeyBegin={signal => beginPasskey({ signal })}
    onPasskeyFinish={(response, signal) => finishPasskey({ data: { response }, signal })}
    magic={magic} magicSignup={magicSignup} onRequest={(email, signal) => requestLink({ data: { email, locale: lang }, signal })} />
}
