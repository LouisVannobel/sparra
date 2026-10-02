import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { useEffect, useRef, useState } from 'react'
import { messages, magicMessages, type Locale } from './messages'
import { AuthEmailInput } from './auth-email-input'
import googleSignInIcon from './assets/google-sign-in-light-icon.png'
import { PasskeyLoginPanel } from './passkey-login-panel'
import { AdditionalPasskeyPanel, type AdditionalPasskeyPanelProps } from './additional-passkey-panel'
import { FirstGooglePasskeyPanel, type FirstGooglePasskeyPanelProps } from './first-google-passkey-panel'
import { GoogleAccountPanel, type GoogleAccountPanelProps } from './google-account-panel'
import { SessionManagementPanel, type SessionManagementPanelProps } from './session-management-panel'
import { useHydrated } from '@tanstack/react-router'

type MagicRequestResult = { accepted: true } | Response

export function LoginPanel({ locale, enabled, pending, failed, onBegin, magic, magicSignup, onRequest,
  passkey, onPasskeyBegin, onPasskeyFinish }: {
  locale: Locale; enabled: boolean; pending: boolean; failed: boolean; onBegin(): void
  magic?: boolean; magicSignup?: boolean; onRequest?(email: string, signal: AbortSignal): Promise<MagicRequestResult>
  passkey?: boolean
  onPasskeyBegin?(signal: AbortSignal): Promise<{ options: Parameters<typeof import('@simplewebauthn/browser').startAuthentication>[0]['optionsJSON'] } | Response>
  onPasskeyFinish?(response: Awaited<ReturnType<typeof import('@simplewebauthn/browser').startAuthentication>>, signal: AbortSignal): Promise<{ authenticated: true } | Response>
}) {
  const t = messages[locale]
  const hydrated = useHydrated()
  return <main className="auth-content auth-login"><a className="auth-brand" href="/">sparra</a><header className="auth-heading"><Heading level={1}>{t.login}</Heading><Text>{t.intro}</Text></header>
    {passkey && onPasskeyBegin && onPasskeyFinish && <PasskeyLoginPanel locale={locale} onBegin={onPasskeyBegin} onFinish={onPasskeyFinish} />}
    <Button label={t.google} variant="secondary" size="lg" className="google-sign-in" isDisabled={!enabled || !hydrated} isLoading={pending} onClick={onBegin}
      icon={<img src={googleSignInIcon} alt="" width={40} height={40} />} />
    {!enabled && <p role="status">{t.unavailable}</p>}
    {pending && <p role="status">{t.pending}</p>}
    {failed && <p role="alert">{t.failed}</p>}
    {magic && onRequest ? <MagicRequestForm locale={locale} signup={magicSignup === true} onRequest={onRequest} /> : <p role="status">{magicMessages[locale].unavailable}</p>}
  </main>
}

function MagicRequestForm({ locale, signup, onRequest }: { locale: Locale; signup: boolean; onRequest(email: string, signal: AbortSignal): Promise<MagicRequestResult> }) {
  const t = magicMessages[locale]
  const hydrated = useHydrated()
  const [email, setEmail] = useState(''), [state, setState] = useState<'idle' | 'pending' | 'accepted'>('idle')
  const [error, setError] = useState<'invalidEmail' | 'rateLimited' | 'serviceUnavailable' | 'requestFailed'>()
  const pending = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { pending.current?.abort(); pending.current = undefined }, [])
  async function submit() {
    if (pending.current) return
    const operation = new AbortController(); pending.current = operation
    setState('pending'); setError(undefined)
    try {
      const result = await onRequest(email, operation.signal)
      if (operation.signal.aborted) return
      if (result instanceof Response) {
        setError(result.status === 400 || result.status === 401 ? 'invalidEmail' : result.status === 429 ? 'rateLimited' : result.status === 503 ? 'serviceUnavailable' : 'requestFailed')
        setState('idle')
      } else if (typeof result === 'object' && result !== null && 'accepted' in result && result.accepted === true) setState('accepted')
      else { setError('requestFailed'); setState('idle') }
    } catch { if (!operation.signal.aborted) { setError('requestFailed'); setState('idle') } }
    finally { if (pending.current === operation) pending.current = undefined }
  }
  return <form className="auth-form" noValidate aria-busy={state === 'pending'} onSubmit={event => {
    event.preventDefault()
    if (!event.currentTarget.checkValidity()) { setError('invalidEmail'); return }
    void submit()
  }}>
    <AuthEmailInput locale={locale} value={email} onChange={value => { setEmail(value); setError(undefined); setState('idle') }} description={t.emailHelp} disabled={state === 'pending' || !hydrated} error={error === 'invalidEmail' ? t.invalidEmail : undefined} />
    {signup && <p>{t.signupHelp}</p>}
    <Button label={t.request} type="submit" variant="primary" isLoading={state === 'pending'} isDisabled={!hydrated} />
    {state === 'pending' && <p role="status">{t.requestPending}</p>}
    {state === 'accepted' && <><p role="status">{t.accepted}</p><p>{t.acceptedHelp}</p></>}
    {error && error !== 'invalidEmail' && <p role="alert">{t[error]}</p>}
  </form>
}
export function AccountPanel({ locale, principal, pending, failed, onLogout, additional, firstGoogle, googleAccount, sessions }: { locale: Locale; principal: { userId: string; name: string; email: string }; pending: boolean; failed: boolean; onLogout(): void; additional?: AdditionalPasskeyPanelProps; firstGoogle?: FirstGooglePasskeyPanelProps; googleAccount?: GoogleAccountPanelProps; sessions?: SessionManagementPanelProps }) {
  const t = messages[locale]
  const hydrated = useHydrated()
  return <main className="auth-content auth-account"><a className="auth-brand" href="/">sparra</a><header className="auth-heading"><Heading level={1}>{t.account}</Heading><Text>{principal.name}</Text></header>
    <div className="auth-account-summary">
    <dl><dt>{t.email}</dt><dd>{principal.email}</dd></dl>
    <nav className="auth-account-links" aria-label={t.account}>
      <a href={`/app?lang=${locale}`}>{locale === 'fr' ? 'Boîte d’appels' : 'Call inbox'}</a>
      <a href={`/workspace?lang=${locale}`}>{locale === 'fr' ? 'Mon espace personnel' : 'My personal workspace'}</a>
    </nav>
    </div>
    {additional && <AdditionalPasskeyPanel {...additional} />}
    {firstGoogle && <FirstGooglePasskeyPanel {...firstGoogle} />}
    {googleAccount && <GoogleAccountPanel {...googleAccount} />}
    {sessions && <SessionManagementPanel {...sessions} />}
    <Button label={t.logout} variant="secondary" size="lg" isLoading={pending} isDisabled={!hydrated} onClick={onLogout} />
    {pending && <p role="status">{t.logoutPending}</p>}{failed && <p role="alert">{t.logoutFailed}</p>}
  </main>
}
