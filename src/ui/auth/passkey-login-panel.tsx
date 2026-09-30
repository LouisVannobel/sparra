import type { startAuthentication } from '@simplewebauthn/browser'
import { useRouter } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { useEffect, useRef, useState } from 'react'
import { passkeyMessages, type Locale } from './messages'

type BrowserHelper = typeof import('@simplewebauthn/browser')
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']
type AuthenticationResponse = Awaited<ReturnType<typeof startAuthentication>>
type Phase = 'helper-loading' | 'helper-failed' | 'unsupported' | 'ready' | 'options' | 'ceremony' | 'finalizing'
type Problem = 'cancelled' | 'uncertain' | 'denied' | 'refused' | 'conflict' | 'rateLimited' | 'serviceUnavailable' | 'failed'

export function passkeyCancellationProblem(finishSent: boolean): 'cancelled' | 'uncertain' {
  return finishSent ? 'uncertain' : 'cancelled'
}
export function passkeyRestoreProblem(finishSent: boolean): 'uncertain' | undefined {
  return finishSent ? 'uncertain' : undefined
}
export function passkeyRestorePhase(input: { helperReady: boolean; helperFailed: boolean; supported: boolean }): 'ready' | 'helper-failed' | 'helper-loading' | 'unsupported' {
  return input.helperReady ? input.supported ? 'ready' : 'unsupported' : input.helperFailed ? 'helper-failed' : 'helper-loading'
}

export function PasskeyLoginPanel({ locale, onBegin, onFinish }: {
  locale: Locale
  onBegin(signal: AbortSignal): Promise<{ options: AuthenticationOptions } | Response>
  onFinish(response: AuthenticationResponse, signal: AbortSignal): Promise<{ authenticated: true } | Response>
}) {
  const t = passkeyMessages[locale], router = useRouter()
  const [phase, setPhase] = useState<Phase>('helper-loading')
  const [problem, setProblem] = useState<Problem>()
  const helper = useRef<BrowserHelper | undefined>(undefined)
  const pending = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(false)
  const finishSent = useRef(false)
  const helperFailed = useRef(false)

  function current(operation?: AbortController) {
    return mounted.current && pending.current === operation && !operation?.signal.aborted
  }
  function cancelWork() {
    const operation = pending.current
    pending.current = undefined
    operation?.abort()
    helper.current?.WebAuthnAbortService.cancelCeremony()
  }
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    async function load() {
      helperFailed.current = false; setPhase('helper-loading'); setProblem(undefined)
      try {
        const loaded = await import('@simplewebauthn/browser')
        if (cancelled || !mounted.current) return
        helper.current = loaded
        setPhase(window.isSecureContext && loaded.browserSupportsWebAuthn() ? 'ready' : 'unsupported')
      } catch { if (!cancelled && mounted.current) { helperFailed.current = true; setPhase('helper-failed') } }
    }
    void load()
    const unsubscribe = router.subscribe('onBeforeNavigate', event => {
      if (event.toLocation.pathname !== '/login') cancelWork()
    })
    function hide() {
      const problem = passkeyRestoreProblem(finishSent.current)
      cancelWork()
      setProblem(problem); setPhase('ready')
    }
    function restore(event: PageTransitionEvent) {
      if (!event.persisted) return
      const problem = passkeyRestoreProblem(finishSent.current)
      cancelWork(); finishSent.current = false
      setProblem(problem)
      const loaded = helper.current
      setPhase(passkeyRestorePhase({ helperReady: loaded !== undefined, helperFailed: helperFailed.current,
        supported: loaded !== undefined && window.isSecureContext && loaded.browserSupportsWebAuthn() }))
    }
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', restore)
    return () => {
      cancelled = true; mounted.current = false; cancelWork(); unsubscribe()
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore)
    }
  }, [router])

  function safeProblem(response: Response): Problem {
    return response.status === 401 || response.status === 400 ? 'refused' : response.status === 409 ? 'conflict'
      : response.status === 429 ? 'rateLimited' : response.status === 503 ? 'serviceUnavailable' : 'failed'
  }
  function retryHelper() {
    if (pending.current) return
    // The installed Chromium/Vite artifact did not recover by importing the
    // same failed chunk URL again. Reload this public route so the normal
    // bounded loader gets a fresh document; do not invent a cache-busting URL.
    window.location.reload()
  }
  function signIn() {
    const loaded = helper.current
    if (!loaded || phase !== 'ready' || pending.current) return
    const operation = new AbortController()
    pending.current = operation
    finishSent.current = false
    setPhase('options'); setProblem(undefined)
    void (async () => {
      try {
        const beginning = await onBegin(operation.signal)
        if (!current(operation)) return
        if (beginning instanceof Response) {
          setProblem(safeProblem(beginning)); setPhase('ready'); return
        }
        // One explicit click is the adopted default. The helper is already
        // loaded; this continuation requests a fresh ceremony every time.
        const ceremony = loaded.startAuthentication({ optionsJSON: beginning.options })
        setPhase('ceremony')
        const response = await ceremony
        if (!current(operation)) return
        setPhase('finalizing'); finishSent.current = true
        const completed = await onFinish(response, operation.signal)
        if (!current(operation)) return
        if (completed instanceof Response) {
          finishSent.current = false
          setProblem(safeProblem(completed)); setPhase('ready'); return
        }
        if (completed.authenticated !== true) { setProblem('failed'); setPhase('ready'); return }
        window.location.assign(`/account?lang=${locale}`)
      } catch (error) {
        if (!current(operation)) return
        const code = error instanceof loaded.WebAuthnError ? error.code : undefined
        const causeName = error instanceof loaded.WebAuthnError && error.cause instanceof DOMException ? error.cause.name : undefined
        setProblem(code === 'ERROR_CEREMONY_ABORTED' ? 'cancelled'
          : causeName === 'NotAllowedError' || code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' ? 'denied'
          : passkeyRestoreProblem(finishSent.current) ?? 'failed')
        setPhase('ready')
      } finally { if (pending.current === operation) pending.current = undefined }
    })()
  }
  function cancel() {
    if (!pending.current) return
    const problem = passkeyCancellationProblem(finishSent.current)
    cancelWork(); finishSent.current = false; setProblem(problem); setPhase('ready')
  }

  return <section className="passkey-sign-in" aria-labelledby="passkey-sign-in-title">
    <h2 id="passkey-sign-in-title">{t.title}</h2>
    <Button label={t.action} variant="primary" isDisabled={phase !== 'ready'} isLoading={phase === 'options' || phase === 'finalizing'} onClick={signIn} />
    {phase === 'helper-loading' && <p role="status">{t.helperLoading}</p>}
    {phase === 'helper-failed' && <><p role="alert">{t.helperFailed}</p><Button label={t.helperRetry} onClick={retryHelper} /></>}
    {phase === 'unsupported' && <p role="alert">{t.unsupported}</p>}
    {phase === 'options' && <p role="status">{t.options}</p>}
    {phase === 'ceremony' && <><p role="status">{t.ceremony}</p><Button label={t.cancel} onClick={cancel} /></>}
    {phase === 'finalizing' && <><p role="status">{t.finalizing}</p><Button label={t.cancel} onClick={cancel} /></>}
    {problem && <p role={problem === 'cancelled' ? 'status' : 'alert'}>{t[problem]}</p>}
  </section>
}
