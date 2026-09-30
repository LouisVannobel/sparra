import { Button } from '@astryxdesign/core/Button'
import { useHydrated } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { AdditionalPasskeyBegin, AdditionalPasskeyAuthorizeInput } from '../../modules/auth/additional-passkey.server'
import type { GoogleAccountConnection, GoogleAccountStatus } from '../../modules/auth/google-account.server'
import { googleAccountMessages, type Locale } from './messages'

export type GoogleAccountPanelProps = {
  locale: Locale; userId: string; connection: GoogleAccountConnection; intentId?: string
  onBeginLink(signal: AbortSignal): Promise<AdditionalPasskeyBegin | Response>
  onAuthorize(input: AdditionalPasskeyAuthorizeInput, signal: AbortSignal): Promise<{ intentId: string; url: string } | Response>
  onBeginUnlink(input: { accountId: string }, signal: AbortSignal): Promise<AdditionalPasskeyBegin | Response>
  onFinishUnlink(input: AdditionalPasskeyAuthorizeInput, signal: AbortSignal): Promise<GoogleAccountStatus | Response>
  onRead(input: { intentId: string }, signal: AbortSignal): Promise<GoogleAccountStatus | Response>
  onCancel(input: { intentId: string }, signal: AbortSignal): Promise<GoogleAccountStatus | Response>
  onChanged(signal: AbortSignal): Promise<void>
  onRefused(): Promise<void>
}
export function navigateGoogleAccountLink(value: { intentId: string; url: string }, locale: Locale, live: () => boolean) {
  if (!live()) return
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.intentId)) throw new Error('Google target unavailable')
  window.history.replaceState(window.history.state, '', '/account?lang=' + locale + '&googleAccount=' + value.intentId)
  window.location.assign(value.url)
}
type Stage = 'idle' | 'beginning' | 'verifying' | 'sending' | 'reading' | 'unconfirmed' | 'refused'
export function GoogleAccountPanel(props: GoogleAccountPanelProps) {
  const t = googleAccountMessages[props.locale], hydrated = useHydrated()
  const [supported, setSupported] = useState(false), [stage, setStage] = useState<Stage>('idle')
  const [intentId, setIntentId] = useState(props.intentId), [status, setStatus] = useState<GoogleAccountStatus>(), [refreshFailed, setRefreshFailed] = useState(false)
  const pending = useRef<AbortController | undefined>(undefined), epoch = useRef(0), intent = useRef(props.intentId)
  const helper = useRef<typeof import('@simplewebauthn/browser') | undefined>(undefined), latest = useRef(props), message = useRef<HTMLParagraphElement>(null)
  latest.current = props
  const busy = ['beginning', 'verifying', 'sending', 'reading'].includes(stage)
  function invalidate() { epoch.current++; pending.current?.abort(); pending.current = undefined; helper.current?.WebAuthnAbortService.cancelCeremony() }
  function remember(id: string) { intent.current = id; setIntentId(id) }
  async function accepted(value: GoogleAccountStatus, signal: AbortSignal, live: () => boolean) {
    if (!live()) return
    if (value.intentId !== intent.current) throw new Error('Operation unavailable')
    setStatus(value); setStage('idle'); setRefreshFailed(false)
    if (live()) message.current?.focus()
    if (value.state === 'linked' || value.state === 'unlinked') {
      try { await latest.current.onChanged(signal) } catch { if (live()) setRefreshFailed(true) }
    }
  }
  async function checkResponse<A>(value: A | Response): Promise<A> {
    if (value instanceof Response) {
      if (value.status === 401) await latest.current.onRefused()
      throw value
    }
    return value
  }
  async function reconcile(cancel = false) {
    if (!intent.current) return
    if (cancel) invalidate(); else if (pending.current) return
    const controller = new AbortController(), version = epoch.current; pending.current = controller
    const live = () => !controller.signal.aborted && version === epoch.current
    setStage('reading')
    try {
      const value = await (cancel ? latest.current.onCancel : latest.current.onRead)({ intentId: intent.current }, controller.signal)
      if (!live()) return
      await accepted(await checkResponse(value), controller.signal, live)
    } catch (error) { if (live()) setStage(error instanceof Response && error.status < 500 && error.status !== 409 ? 'refused' : 'unconfirmed') }
    finally { if (pending.current === controller) pending.current = undefined }
  }
  useEffect(() => {
    invalidate(); remember(props.intentId ?? ''); setStatus(undefined); setRefreshFailed(false); setStage('idle')
    setSupported(typeof window.PublicKeyCredential === 'function' && !!navigator.credentials)
    if (props.intentId) void reconcile()
    const hide = () => { invalidate(); setStage(intent.current ? 'unconfirmed' : 'idle') }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      invalidate()
      const selected = new URL(window.location.href).searchParams.get('googleAccount')
      if (selected && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected)) remember(selected)
      if (intent.current) void reconcile()
    }
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show)
    return () => { invalidate(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) }
  }, [props.userId, props.locale])
  useEffect(() => {
    const selected = props.intentId ?? ''
    // Router echoes our own history publication into props. That selector is
    // already remembered by the live ceremony; only an external selection
    // replaces it. User/language changes and unmount retain their own cleanup.
    if (selected === intent.current) return
    invalidate(); remember(selected); setStatus(undefined); setRefreshFailed(false); setStage('idle')
    if (selected) void reconcile()
  }, [props.intentId])
  async function begin(action: 'LINK' | 'UNLINK') {
    if (pending.current || !hydrated || !supported) return
    const current = props, controller = new AbortController(), version = epoch.current; pending.current = controller
    const live = () => !controller.signal.aborted && epoch.current === version && latest.current.userId === current.userId
    setStatus(undefined); setRefreshFailed(false); setStage('beginning')
    let sent = false
    try {
      const value = action === 'LINK' ? await current.onBeginLink(controller.signal)
        : current.connection.state === 'linked' ? await current.onBeginUnlink({ accountId: current.connection.accountId }, controller.signal) : undefined
      if (!live()) return
      if (!value) throw new Error('Operation unavailable')
      const begun = await checkResponse(value)
      remember(begun.intentId); setStage('verifying')
      if (action === 'UNLINK') window.history.replaceState(window.history.state, '', '/account?lang=' + current.locale + '&googleAccount=' + begun.intentId)
      const browser = await import('@simplewebauthn/browser'); helper.current = browser
      if (!live()) return
      const response = await browser.startAuthentication({ optionsJSON: begun.options })
      if (!live()) return
      if (Date.parse(begun.expiresAt) <= Date.now()) throw new Error('Operation expired')
      setStage('sending'); sent = true
      const input = { intentId: begun.intentId, response }
      if (action === 'LINK') {
        const result = await current.onAuthorize(input, controller.signal)
        if (!live()) return
        const authorized = await checkResponse(result)
        if (authorized.intentId !== begun.intentId) throw new Error('Operation unavailable')
        navigateGoogleAccountLink(authorized, current.locale, live)
      } else {
        const result = await current.onFinishUnlink(input, controller.signal)
        if (!live()) return
        await accepted(await checkResponse(result), controller.signal, live)
      }
    } catch (error) {
      if (live()) { setStage(sent && !(error instanceof Response && error.status < 500 && error.status !== 409) ? 'unconfirmed' : 'refused'); message.current?.focus() }
    } finally { if (pending.current === controller) pending.current = undefined }
  }
  const canAct = props.connection.state === 'linked' ? props.connection.canUnlink : props.connection.state === 'unlinked' && props.connection.canLink
  const terminal = status?.state === 'linked' || status?.state === 'unlinked' || status?.state === 'invalidated' || status?.state === 'expired'
  const historical = status ? t[status.state] : t.intro
  return <section className="auth-google-account" aria-labelledby="google-account-title" aria-busy={busy}>
    <h2 id="google-account-title">{t.title}</h2>
    <p>{props.connection.state === 'linked' ? t.connected : props.connection.state === 'unlinked' ? t.notConnected : t.unavailable}</p>
    <p>{t.localOnly}</p>
    <Button label={props.connection.state === 'linked' ? t.unlink : t.link} variant="secondary" isDisabled={!hydrated || !supported || !canAct || busy || !!intentId && !terminal}
      onClick={() => { void begin(props.connection.state === 'linked' ? 'UNLINK' : 'LINK') }} />
    {hydrated && !supported && <p>{t.unsupported}</p>}
    {!canAct && <p>{t.eligibility}</p>}
    <p ref={message} tabIndex={-1} role={stage === 'refused' || stage === 'unconfirmed' ? 'alert' : 'status'}>
      {busy ? t.pending : stage === 'unconfirmed' ? t.uncertain : stage === 'refused' ? t.refused : historical}
    </p>
    {refreshFailed && <p role="alert">{t.refreshFailed}</p>}
    {intentId && <div className="auth-google-account-actions">
      <Button label={t.check} variant="secondary" isDisabled={!hydrated || busy} onClick={() => { void reconcile() }} />
      {!terminal && <Button label={t.cancel} variant="secondary" isDisabled={!hydrated || stage === 'reading'} onClick={() => { void reconcile(true) }} />}
    </div>}
  </section>
}
