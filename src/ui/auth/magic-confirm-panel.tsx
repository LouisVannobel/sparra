import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { AuthScreen } from './auth-screen'
import { useAnnounce } from '@astryxdesign/core/hooks'
import { AuthEmailInput } from './auth-email-input'
import { readMagicFragment, forgetMagicFragment, getMagicFragmentRevision, isMagicFragmentBlocked, subscribeMagicFragment } from './magic-fragment'
import { magicMessages, messages, type Locale } from './messages'

type BrowserHelper = typeof import('@simplewebauthn/browser')
type Phase = 'loading' | 'email' | 'pending' | 'missing' | 'blocked' | 'conflict' | 'helper-loading' | 'helper-failed' | 'unsupported' | 'ready' | 'ceremony' | 'finalizing' | 'final-failed'
type Problem = 'invalidEmail' | 'refused' | 'rateLimited' | 'serviceUnavailable' | 'failed' | 'ceremonyCancelled' | 'ceremonyDenied' | 'ceremonyRegistered' | 'ceremonyFailed'

export function MagicConfirmPanel({ locale }: { locale: Locale }) {
  const t = magicMessages[locale], router = useRouter()
  const announce = useAnnounce()
  const [phase, setPhase] = useState<Phase>('loading')
  const [revision, setRevision] = useState(getMagicFragmentRevision), [arrived, setArrived] = useState(false)
  const [email, setEmail] = useState(''), [error, setError] = useState<Problem>()
  const pending = useRef<AbortController | undefined>(undefined)
  const helper = useRef<BrowserHelper | undefined>(undefined)
  const options = useRef<Parameters<BrowserHelper['startRegistration']>[0]['optionsJSON'] | undefined>(undefined)
  const currentLocale = useRef(locale); currentLocale.current = locale
  // This closes over the revision of THIS render, not a ref updated by B.
  function current(operation?: AbortController) {
    return revision === getMagicFragmentRevision() && !isMagicFragmentBlocked() && !operation?.signal.aborted
  }
  function cancelWork() {
    pending.current?.abort(); pending.current = undefined
    helper.current?.WebAuthnAbortService.cancelCeremony(); options.current = undefined
  }
  useEffect(() => {
    setRevision(getMagicFragmentRevision())
    setPhase(readMagicFragment() ? 'email' : 'missing')
    const unsubscribeArrival = subscribeMagicFragment(nextRevision => {
      // B is already installed. Cancel A without calling leave()/forget().
      cancelWork(); setRevision(nextRevision); setEmail(''); setError(undefined); setArrived(true)
      setPhase(isMagicFragmentBlocked() ? 'blocked' : readMagicFragment(nextRevision) ? 'email' : 'missing')
      announce('', 'assertive'); announce(magicMessages[currentLocale.current].linkChanged)
    })
    function leave() {
      cancelWork(); forgetMagicFragment(); setRevision(getMagicFragmentRevision())
      setEmail(''); setError(undefined); setArrived(false); setPhase(isMagicFragmentBlocked() ? 'blocked' : 'missing')
    }
    const unsubscribe = router.subscribe('onBeforeNavigate', event => { if (event.toLocation.pathname !== '/auth/magic/confirm') leave() })
    window.addEventListener('pagehide', leave)
    window.addEventListener('pageshow', restored)
    function restored(event: PageTransitionEvent) { if (event.persisted) leave() }
    // Cleanup cancels client work, but StrictMode's development replay does
    // not consume proof. Actual route/page leave explicitly forgets it above.
    return () => { cancelWork(); unsubscribeArrival(); unsubscribe(); window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', restored) }
  }, [router, announce])
  async function prepareHelper(operation: AbortController) {
    setPhase('helper-loading'); setError(undefined)
    try {
      const loaded = await import('@simplewebauthn/browser')
      if (!current(operation)) return
      helper.current = loaded
      setPhase(window.isSecureContext && loaded.browserSupportsWebAuthn() ? 'ready' : 'unsupported')
    } catch { if (current(operation)) setPhase('helper-failed') }
  }
  async function retryHelper() {
    if (!current() || pending.current || !options.current || !readMagicFragment(revision)) return
    const operation = new AbortController(); pending.current = operation
    try { await prepareHelper(operation) } finally { if (pending.current === operation) pending.current = undefined }
  }
  async function confirm() {
    if (!current() || pending.current) return
    const token = readMagicFragment(revision)
    if (!token) { forgetMagicFragment(); setPhase('missing'); return }
    const operation = new AbortController(); pending.current = operation
    setPhase('pending'); setError(undefined)
    try {
      const response = await fetch('/auth/magic/consume', { method: 'POST', credentials: 'same-origin', signal: operation.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, intendedEmail: email }) })
      if (!current(operation)) return
      if (!response.ok) {
        setPhase(response.status === 409 ? 'conflict' : 'email')
        setError(response.status === 401 || response.status === 400 ? 'refused' : response.status === 429 ? 'rateLimited' : response.status === 503 ? 'serviceUnavailable' : 'failed')
        return
      }
      const result = await response.json()
      if (!current(operation)) return
      if (result.authenticated === true) {
        forgetMagicFragment(); window.location.assign(`/account?lang=${currentLocale.current}`)
      } else if (result.enrollmentRequired === true && result.options) {
        options.current = result.options
        await prepareHelper(operation)
      }
      else { setPhase('email'); setError('failed') }
    } catch { if (current(operation)) { setPhase('email'); setError('failed') } }
    finally { if (pending.current === operation) pending.current = undefined }
  }
  function createPasskey() {
    if (!current()) return
    const loaded = helper.current, optionsJSON = options.current
    if (pending.current || !loaded || !optionsJSON || phase !== 'ready') return
    if (!readMagicFragment(revision)) { setPhase('missing'); return }
    const operation = new AbortController(); pending.current = operation
    // Direct click reaches the already-loaded native ceremony before any
    // React state update, RPC, dynamic import or intervening promise.
    const ceremony = loaded.startRegistration({ optionsJSON })
    setPhase('ceremony'); setError(undefined)
    void ceremony.then(async response => {
      if (!current(operation)) return
      const token = readMagicFragment(revision)
      if (!token) { setPhase('missing'); return }
      setPhase('finalizing')
      try {
        const completed = await fetch('/auth/magic/enroll', { method: 'POST', credentials: 'same-origin', signal: operation.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, intendedEmail: email, response }) })
        if (!current(operation)) return
        if (completed.status === 429 || completed.status === 503) {
          setPhase('ready'); setError(completed.status === 429 ? 'rateLimited' : 'serviceUnavailable'); return
        }
        if (completed.ok) {
          const result = await completed.json()
          // Both a late success AND a late unsuccessful JSON must leave B alone.
          if (!current(operation)) return
          if (result?.authenticated === true) {
            forgetMagicFragment(); options.current = undefined; window.location.assign(`/account?lang=${currentLocale.current}`); return
          }
        }
        // Native500 can be a crypto refusal or an operational failure. Never
        // claim its cause or replay an uncertain finalization automatically.
        forgetMagicFragment(); options.current = undefined; setPhase('final-failed')
      } catch {
        if (current(operation)) { forgetMagicFragment(); options.current = undefined; setPhase('final-failed') }
      }
    }, error => {
      if (!current(operation)) return
      const code = error instanceof loaded.WebAuthnError ? error.code : undefined
      setPhase('ready')
      setError(code === 'ERROR_CEREMONY_ABORTED' ? 'ceremonyCancelled'
        : code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' ? 'ceremonyDenied'
        : code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' ? 'ceremonyRegistered' : 'ceremonyFailed')
    }).finally(() => { if (pending.current === operation) pending.current = undefined })
  }
  function cancelCeremony() {
    if (!current()) return
    pending.current?.abort(); pending.current = undefined
    helper.current?.WebAuthnAbortService.cancelCeremony(); setPhase('ready'); setError('ceremonyCancelled')
  }
  return <AuthScreen title={t.confirm}>
    {arrived && <p>{t.linkChanged}</p>}
    {phase === 'loading' && <p role="status">{messages[locale].loading}</p>}
    {phase === 'missing' && <p role="alert">{t.missing}</p>}
    {phase === 'blocked' && <p role="alert">{t.clearFailed}</p>}
    {phase === 'conflict' && <><p role="alert">{t.conflict}</p><a href={`/account?lang=${locale}`}>{t.account}</a></>}
    {['helper-loading', 'helper-failed', 'unsupported', 'ready', 'ceremony', 'finalizing'].includes(phase) && <p>{t.enrollment}</p>}
    {phase === 'helper-loading' && <p role="status">{t.helperLoading}</p>}
    {phase === 'helper-failed' && <><p role="alert">{t.helperFailed}</p><Button label={t.helperRetry} onClick={() => { void retryHelper() }} /></>}
    {phase === 'unsupported' && <p role="alert">{t.unsupported}</p>}
    {(phase === 'ready' || phase === 'ceremony' || phase === 'finalizing') && <>
      <Button label={t.createPasskey} variant="primary" isLoading={phase !== 'ready'} onClick={createPasskey} />
      {phase === 'ceremony' && <><p role="status">{t.ceremonyPending}</p><Button label={t.cancel} onClick={cancelCeremony} /></>}
      {phase === 'finalizing' && <p role="status">{t.finalizing}</p>}
      {error && <p role="alert">{t[error]}</p>}
    </>}
    {phase === 'final-failed' && <p role="alert">{t.finalFailed}</p>}
    {(phase === 'email' || phase === 'pending') && <form className="auth-form" noValidate aria-busy={phase === 'pending'} onSubmit={event => {
      event.preventDefault()
      if (!current()) return
      if (!event.currentTarget.checkValidity()) { setError('invalidEmail'); return }
      void confirm()
    }}>
      <AuthEmailInput locale={locale} value={email} onChange={value => { if (current()) { setEmail(value); setError(undefined) } }} description={t.confirmHelp}
        disabled={phase === 'pending'} error={error === 'invalidEmail' || error === 'refused' ? t[error] : undefined} />
      <Button label={t.confirm} type="submit" variant="primary" isLoading={phase === 'pending'} />
      {phase === 'pending' && <p role="status">{t.confirming}</p>}
      {error && error !== 'invalidEmail' && error !== 'refused' && <p role="alert">{t[error]}</p>}
    </form>}
    <a href={`/login?lang=${locale}`}>{t.newLink}</a>
  </AuthScreen>
}
