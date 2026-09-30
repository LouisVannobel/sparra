import { Button } from '@astryxdesign/core/Button'
import { useEffect, useRef, useState } from 'react'
import type { AdditionalPasskeyAuthorizeInput, AdditionalPasskeyAuthorized, AdditionalPasskeyBegin, AdditionalPasskeyFinishInput } from '../../modules/auth/additional-passkey.server'
import { additionalPasskeyMessages, type Locale } from './messages'
import { useHydrated } from '@tanstack/react-router'

type Stage = 'idle' | 'preparing' | 'proof-ready' | 'proving' | 'authorizing' | 'registration-ready' | 'registering' | 'finishing' | 'added' | 'unconfirmed' | 'error'
type Availability = 'available' | 'workspace-required' | 'existing-key-required' | 'unavailable'
type ListedKey = { id: string; name: string | null; createdAt: string | null }
export type AdditionalPasskeyPanelProps = {
  locale: Locale; userId: string; availability: Availability; passkeys: ListedKey[]
  onBegin(signal: AbortSignal): Promise<AdditionalPasskeyBegin | Response>
  onAuthorize(input: AdditionalPasskeyAuthorizeInput, signal: AbortSignal): Promise<AdditionalPasskeyAuthorized | Response>
  onFinish(input: AdditionalPasskeyFinishInput, signal: AbortSignal): Promise<{ added: true } | Response>
  onRefresh(signal: AbortSignal): Promise<{ userId: string; additionalPasskey: Availability; passkeys: ListedKey[] } | Response>
}
export function AdditionalPasskeyPanel(props: AdditionalPasskeyPanelProps) {
  const { locale, userId, availability } = props, t = additionalPasskeyMessages[locale]
  const hydrated = useHydrated()
  const [stage, setStage] = useState<Stage>('idle'), [error, setError] = useState<keyof typeof t>('error')
  const [keys, setKeys] = useState(props.passkeys), [retryAfter, setRetryAfter] = useState('')
  const [refreshFailed, setRefreshFailed] = useState(false)
  const attempt = useRef(0), pending = useRef<AbortController | undefined>(undefined)
  const stageRef = useRef<Stage>('idle'), proof = useRef<AdditionalPasskeyBegin | undefined>(undefined)
  const registration = useRef<AdditionalPasskeyAuthorized | undefined>(undefined)
  const helper = useRef<typeof import('@simplewebauthn/browser') | undefined>(undefined)
  const region = useRef<HTMLElement | null>(null)
  function move(next: Stage) { stageRef.current = next; setStage(next) }
  function invalidate() {
    attempt.current++; pending.current?.abort(); pending.current = undefined
    helper.current?.WebAuthnAbortService.cancelCeremony()
    proof.current = undefined; registration.current = undefined
  }
  function focus() { queueMicrotask(() => region.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()) }
  function cancel() { const sent = stageRef.current === 'finishing'; invalidate(); move(sent ? 'unconfirmed' : 'idle'); focus() }
  useEffect(() => {
    invalidate(); move('idle'); setKeys(props.passkeys); setRefreshFailed(false)
    const hide = () => { const uncertain = stageRef.current === 'finishing' || stageRef.current === 'unconfirmed'; invalidate(); move(uncertain ? 'unconfirmed' : 'idle') }
    window.addEventListener('pagehide', hide)
    return () => { invalidate(); window.removeEventListener('pagehide', hide) }
  }, [userId, availability])
  useEffect(() => { setKeys(props.passkeys) }, [props.passkeys])
  function refused(response: Response) {
    if (response.status === 409) { invalidate(); move('unconfirmed'); return }
    setError(response.status === 401 ? 'rejected' : response.status === 429 ? 'rateLimited' : response.status === 503 ? 'serviceUnavailable' : 'error')
    setRetryAfter(response.status === 429 ? response.headers.get('retry-after') ?? '' : '')
    invalidate(); move('error'); focus()
  }
  function refreshUnavailable() { invalidate(); setRefreshFailed(true); focus() }
  async function act(kind: 'begin' | 'prove' | 'register' | 'refresh') {
    if (pending.current) return
    setRefreshFailed(false)
    if (kind === 'begin' && stageRef.current === 'error' && error === 'helperFailed' && !helper.current) {
      invalidate(); window.location.reload(); return
    }
    if (kind === 'prove' && stageRef.current !== 'proof-ready' || kind === 'register' && stageRef.current !== 'registration-ready') return
    if (kind === 'begin') { invalidate(); move('preparing') }
    const controller = new AbortController(), captured = attempt.current; pending.current = controller
    const live = () => attempt.current === captured && !controller.signal.aborted
    const deadline = () => {
      const expiry = registration.current?.expiresAt ?? proof.current?.expiresAt
      if (!expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) {
        setError('expired'); invalidate(); move('error'); focus(); return false
      }
      return true
    }
    try {
      if (kind === 'refresh') {
        const result = await props.onRefresh(controller.signal)
        if (!live()) return
        if (result instanceof Response) { refreshUnavailable(); return }
        if (result.userId !== userId || result.additionalPasskey !== availability) { invalidate(); move('idle') }
        setKeys(result.passkeys); move('idle'); focus(); return
      }
      let api = helper.current
      if (!api) {
        try { api = await import('@simplewebauthn/browser') }
        catch { if (live()) { setError('helperFailed'); move('error'); focus() }; return }
        if (!live()) return
        helper.current = api
      }
      if (!window.isSecureContext || !api.browserSupportsWebAuthn()) { setError('unsupported'); invalidate(); move('error'); focus(); return }
      if (kind === 'begin') {
        const result = await props.onBegin(controller.signal)
        if (!live()) return
        if (result instanceof Response) { refused(result); return }
        proof.current = result
        if (deadline()) { move('proof-ready'); focus() }
        return
      }
      if (!deadline()) return
      if (kind === 'prove') {
        const current = proof.current
        if (!current) return
        move('proving')
        const response = await api.startAuthentication({ optionsJSON: current.options })
        if (!live() || !deadline()) return
        move('authorizing')
        const result = await props.onAuthorize({ intentId: current.intentId, response }, controller.signal)
        if (!live()) return
        if (result instanceof Response) { refused(result); return }
        if (result.intentId !== current.intentId) throw new Error('Invalid additional-key response')
        proof.current = undefined; registration.current = result
        if (deadline()) { move('registration-ready'); focus() }
        return
      }
      const current = registration.current
      if (!current) return
      move('registering')
      const response = await api.startRegistration({ optionsJSON: current.options })
      if (!live() || !deadline()) return
      move('finishing')
      const result = await props.onFinish({ intentId: current.intentId, response: {
        id: response.id, rawId: response.rawId, type: response.type,
        response: { clientDataJSON: response.response.clientDataJSON, attestationObject: response.response.attestationObject,
          transports: response.response.transports },
        clientExtensionResults: response.clientExtensionResults, authenticatorAttachment: response.authenticatorAttachment,
      } }, controller.signal)
      if (!live()) return
      if (result instanceof Response) {
        // A server error after Finish was sent cannot prove that COMMIT failed.
        if (result.status >= 500 && result.status < 600) { invalidate(); move('unconfirmed'); focus() }
        else refused(result)
        return
      }
      if (result.added !== true) throw new Error('Invalid additional-key result')
      invalidate(); move('added'); focus()
    } catch {
      if (live()) {
        if (kind === 'refresh') refreshUnavailable()
        else { const sent = stageRef.current === 'finishing'; invalidate(); setError('error'); move(sent ? 'unconfirmed' : 'error'); focus() }
      }
    } finally { if (pending.current === controller) pending.current = undefined }
  }
  const busy = ['preparing', 'proving', 'authorizing', 'registering', 'finishing'].includes(stage)
  return <section ref={region} className="additional-passkey" aria-busy={busy} aria-label={t.title}>
    <h2>{t.title}</h2>
    <ul>{keys.map(key => <li key={key.id}>{key.name || t.unnamed}{key.createdAt && <time dateTime={key.createdAt}> — {new Date(key.createdAt).toLocaleDateString(locale, { timeZone: 'UTC' })}</time>}</li>)}</ul>
    {availability === 'workspace-required' ? <a href={`/workspace?lang=${locale}`}>{t.workspace}</a>
      : availability === 'existing-key-required' ? <p role="status">{t.existing}</p>
        : availability !== 'available' ? <p role="status">{t.unavailable}</p> : <>
          <p role={stage === 'error' ? 'alert' : 'status'}>{stage === 'error' ? t[error] : t[stage]}{retryAfter && stage === 'error' ? ` (${retryAfter}s)` : ''}</p>
          {refreshFailed && <p role="alert">{t.refreshFailed}</p>}
          <div className="additional-passkey-actions">
            {stage === 'idle' && <Button label={t.add} isDisabled={!hydrated} onClick={() => void act('begin')} />}
            {stage === 'proof-ready' && <Button label={t.verify} isDisabled={!hydrated} onClick={() => void act('prove')} />}
            {stage === 'registration-ready' && <Button label={t.create} isDisabled={!hydrated} onClick={() => void act('register')} />}
            {busy && <Button label={t[stage]} isLoading isDisabled />}
            {['error', 'added'].includes(stage) && <Button label={t.restart} isDisabled={!hydrated} onClick={() => void act('begin')} />}
            {['unconfirmed', 'added', 'error'].includes(stage) && <Button label={t.refresh} variant="secondary" isDisabled={!hydrated} onClick={() => void act('refresh')} />}
            {!['idle', 'added', 'unconfirmed'].includes(stage) && <Button label={t.cancel} variant="secondary" isDisabled={!hydrated} onClick={cancel} />}
          </div>
        </>}
  </section>
}
