import { Button } from '@astryxdesign/core/Button'
import { useHydrated } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { FirstGoogleStatus } from '../../modules/auth/first-google-passkey.server'
import type { AdditionalPasskeyAuthorized, AdditionalPasskeyFinishInput } from '../../modules/auth/additional-passkey.server'
import { firstGooglePasskeyMessages, type Locale } from './messages'

export type FirstGooglePasskeyPanelProps = {
  locale: Locale; available: boolean; userId: string; intentId?: string
  onBegin(signal: AbortSignal): Promise<{ url: string; intentId: string } | Response>
  onRead(input: { intentId: string }, signal: AbortSignal): Promise<FirstGoogleStatus | Response>
  onPrepare(input: { intentId: string }, signal: AbortSignal): Promise<AdditionalPasskeyAuthorized | Response>
  onFinish(input: AdditionalPasskeyFinishInput, signal: AbortSignal): Promise<{ added: true } | Response>
  onCancel(input: { intentId: string }, signal: AbortSignal): Promise<FirstGoogleStatus | Response>
  onAdded(signal: AbortSignal): Promise<void>
}
type Stage = 'idle' | 'reading' | 'busy' | 'registering' | 'finishing' | 'unconfirmed' | 'error'
export function navigateFirstGoogleProof(value: { url: string; intentId?: string }, locale: Locale, live: () => boolean) {
  if (!live()) return
  if (typeof value.intentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.intentId)) throw new Error('First-passkey target unavailable')
  // Preserve router-owned state; the URL retains only a selector for a future protected read.
  window.history.replaceState(window.history.state, '', '/account?lang=' + locale + '&firstPasskey=' + value.intentId)
  window.location.assign(value.url)
}
export function firstGoogleStatusMessage(status: Pick<FirstGoogleStatus, 'state' | 'reason'> | undefined) {
  return status?.reason === 'proof_unavailable' ? 'proofUnavailable' : status?.reason === 'proof_stale' ? 'proofStale'
    : status?.reason === 'cancelled' ? 'cancelled' : status?.state === 'added' ? 'added' : status?.state === 'authorized' ? 'authorized'
      : status?.state === 'expired' ? 'expired' : status?.state === 'invalidated' ? 'invalidated' : status ? 'pending' : 'intro'
}
export function FirstGooglePasskeyPanel(props: FirstGooglePasskeyPanelProps) {
  const t = firstGooglePasskeyMessages[props.locale], hydrated = useHydrated()
  const [stage, setStage] = useState<Stage>(props.intentId ? 'reading' : 'idle')
  const [status, setStatus] = useState<FirstGoogleStatus>(), [readFailed, setReadFailed] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const pending = useRef<AbortController | undefined>(undefined), epoch = useRef(0), phase = useRef<Stage>(stage)
  const helper = useRef<typeof import('@simplewebauthn/browser') | undefined>(undefined)
  const propsRef = useRef(props); propsRef.current = props
  function move(next: Stage) { phase.current = next; setStage(next) }
  function invalidate() { epoch.current++; pending.current?.abort(); pending.current = undefined; helper.current?.WebAuthnAbortService.cancelCeremony() }
  async function refreshAfterAdded(refresh: FirstGooglePasskeyPanelProps['onAdded'], signal: AbortSignal, live: () => boolean) {
    try { if (live()) await refresh(signal) }
    catch { if (live()) setRefreshFailed(true) }
  }
  async function read() {
    const current = propsRef.current
    if (!current.intentId || pending.current) return
    const controller = new AbortController(), id = epoch.current; pending.current = controller
    setReadFailed(false); setRefreshFailed(false); move('reading'); setStatus(undefined)
    try {
      const value = await current.onRead({ intentId: current.intentId }, controller.signal)
      if (controller.signal.aborted || epoch.current !== id) return
      if (value instanceof Response || value.intentId !== current.intentId) throw new Error('Status unavailable')
      setStatus(value); move('idle')
      if (value.state === 'added') await refreshAfterAdded(current.onAdded, controller.signal, () => !controller.signal.aborted && epoch.current === id)
    } catch { if (!controller.signal.aborted && epoch.current === id) { setReadFailed(true); move('unconfirmed') } }
    finally { if (pending.current === controller) pending.current = undefined }
  }
  useEffect(() => {
    invalidate(); setStatus(undefined); setRefreshFailed(false)
    if (props.intentId) void read(); else move('idle')
    const hide = () => { const sent = phase.current === 'finishing'; invalidate(); setStatus(undefined); setRefreshFailed(false); move(sent ? 'unconfirmed' : 'reading') }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      invalidate(); setStatus(undefined); setRefreshFailed(false); move('reading')
      // A retained pre-Begin route may have old search props despite the saved history URL.
      // Reload only that mismatch so no action uses its obsolete client state.
      const current = new URL(window.location.href)
      if (current.pathname === '/account' && current.searchParams.get('firstPasskey') !== (propsRef.current.intentId ?? null)) { window.location.reload(); return }
      if (propsRef.current.intentId) void read(); else move('idle')
    }
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show)
    return () => { invalidate(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) }
  }, [props.userId, props.intentId])
  async function act(kind: 'begin' | 'create' | 'cancel') {
    if (kind === 'cancel' && pending.current) invalidate()
    if (pending.current || !hydrated) return
    if (kind !== 'cancel' && ['reading', 'busy', 'registering', 'finishing'].includes(phase.current)) return
    const intentId = props.intentId
    if (kind !== 'begin' && !intentId || kind === 'create' && status?.state !== 'authorized') return
    const controller = new AbortController(), id = epoch.current; pending.current = controller
    const live = () => !controller.signal.aborted && epoch.current === id
    move('busy'); setReadFailed(false); setRefreshFailed(false)
    try {
      if (kind === 'begin') {
        const value = await props.onBegin(controller.signal)
        if (!live()) return
        if (value instanceof Response) throw new Error('Begin unavailable')
        navigateFirstGoogleProof(value, props.locale, live); return
      }
      if (kind === 'cancel') {
        const value = await props.onCancel({ intentId: intentId! }, controller.signal)
        if (!live()) return
        if (value instanceof Response) throw new Error('Cancellation unconfirmed')
        setStatus(value); move('idle'); if (value.state === 'added') await refreshAfterAdded(props.onAdded, controller.signal, live); return
      }
      const options = await props.onPrepare({ intentId: intentId! }, controller.signal)
      if (!live()) return
      if (options instanceof Response || options.intentId !== intentId || Date.parse(options.expiresAt) <= Date.now()) throw new Error('Proof expired')
      const api = helper.current ?? await import('@simplewebauthn/browser'); helper.current = api
      if (!live()) return
      if (!window.isSecureContext || !api.browserSupportsWebAuthn()) throw new Error('Passkey unavailable')
      move('registering')
      const response = await api.startRegistration({ optionsJSON: options.options })
      if (!live()) return
      if (Date.parse(options.expiresAt) <= Date.now()) throw new Error('Proof expired')
      move('finishing')
      const result = await props.onFinish({ intentId: intentId!, response: { id: response.id, rawId: response.rawId, type: response.type,
        response: { clientDataJSON: response.response.clientDataJSON, attestationObject: response.response.attestationObject, transports: response.response.transports },
        clientExtensionResults: response.clientExtensionResults, authenticatorAttachment: response.authenticatorAttachment } }, controller.signal)
      if (!live()) return
      // Every unconfirmed Finish goes to a protected read, never an automatic resend.
      if (result instanceof Response || result.added !== true) { setStatus(undefined); move('unconfirmed'); return }
      setStatus({ intentId: intentId!, state: 'added', expiresAt: options.expiresAt, reason: null }); move('idle'); await refreshAfterAdded(props.onAdded, controller.signal, live)
    } catch {
      if (live()) { setStatus(undefined); move(phase.current === 'finishing' || kind === 'cancel' ? 'unconfirmed' : 'error') }
    } finally { if (pending.current === controller) pending.current = undefined }
  }
  const busy = ['reading', 'busy', 'registering', 'finishing'].includes(stage)
  const terminal = status && ['invalidated', 'expired'].includes(status.state)
  const message = readFailed ? t.readFailed : stage === 'unconfirmed' ? t.unconfirmed : stage === 'error' ? t.error
    : busy ? t.busy : t[firstGoogleStatusMessage(status)]
  return <section className="additional-passkey first-google-passkey" aria-busy={busy} aria-label={t.title}>
    <h2>{t.title}</h2><p>{t.conditional}</p>
    <p role={stage === 'error' || readFailed ? 'alert' : 'status'}>{message}</p>
    {refreshFailed && <p role="alert">{t.refreshFailed}</p>}
    {!props.available && !props.intentId && <p>{t.unavailable}</p>}
    <div className="additional-passkey-actions">
      {props.available && !busy && (!props.intentId || terminal) && <Button label={t.begin} isDisabled={!hydrated} onClick={() => void act('begin')} />}
      {status?.state === 'authorized' && stage === 'idle' && <Button label={t.create} isDisabled={!hydrated} onClick={() => void act('create')} />}
      {props.intentId && !busy && status?.state !== 'added' && <Button label={t.read} variant="secondary" isDisabled={!hydrated} onClick={() => void read()} />}
      {props.intentId && status?.state !== 'added' && !terminal && <Button label={t.cancel} variant="secondary" isDisabled={!hydrated} onClick={() => void act('cancel')} />}
    </div>
  </section>
}
