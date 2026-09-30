import { Button } from '@astryxdesign/core/Button'
import { useHydrated } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import type { projectSessionPage } from '../../modules/auth/session-management.server'
import { sessionManagementMessages, type Locale } from './messages'

type Page = ReturnType<typeof projectSessionPage>
type Begin = { challengeId: string; expiresAt: string; options: PublicKeyCredentialRequestOptionsJSON }
type Finish = { challengeId: string; response: AuthenticationResponseJSON }
export type SessionManagementPanelProps = {
  locale: Locale; userId: string; available: boolean
  onBeginList(input: { cursor?: string; reconcileSessionId?: string }, signal: AbortSignal): Promise<Begin | Response>
  onFinishList(input: Finish, signal: AbortSignal): Promise<Page | Response>
  onBeginRevocation(input: { sessionId: string }, signal: AbortSignal): Promise<Begin | Response>
  onFinishRevocation(input: Finish, signal: AbortSignal): Promise<{ revoked: true; sessionId: string } | Response>
  onRefused(): Promise<void>
}
type Stage = 'idle' | 'beginning' | 'verifying' | 'sending' | 'listed' | 'confirmed' | 'unconfirmed' | 'cancelled' | 'refused' | 'unavailable' | 'restart'
type Display = { userId: string; locale: Locale; stage: Stage; page?: Page; uncertainTarget?: string; reconciled?: Page['targetState'] }
export function SessionRows({ locale, rows, disabled, onRevoke }: { locale: Locale; rows: Page['sessions']; disabled: boolean; onRevoke(id: string): void }) {
  const t = sessionManagementMessages[locale]
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return <ul className="auth-session-list">{rows.map(row => <li key={row.id} data-session-id={row.id}>
    <h3>{row.current ? t.current : t.other}</h3>
    <dl>{[['createdAt', t.created], ['lastActivityAt', t.activity], ['expiresAt', t.expires]].map(([field, label]) => {
      const value = field === 'createdAt' ? row.createdAt : field === 'lastActivityAt' ? row.lastActivityAt : row.expiresAt
      return <div key={field}><dt>{label}</dt><dd><time dateTime={value}>{dates.format(new Date(value))}</time></dd></div>
    })}</dl>
    {row.current ? <p>{t.signOut}</p> : <Button label={t.revoke} variant="secondary" isDisabled={disabled} onClick={() => onRevoke(row.id)} />}
  </li>)}</ul>
}
export function SessionManagementPanel(props: SessionManagementPanelProps) {
  const hydrated = useHydrated(), t = sessionManagementMessages[props.locale]
  const [supported, setSupported] = useState(false)
  const [display, setDisplay] = useState<Display>({ userId: props.userId, locale: props.locale, stage: 'idle' })
  const current = display.userId === props.userId && display.locale === props.locale ? display : { userId: props.userId, locale: props.locale, stage: 'idle' as const }
  const latest = useRef(props); latest.current = props
  const mounted = useRef(false), epoch = useRef(0), message = useRef<HTMLParagraphElement>(null)
  const helper = useRef<typeof import('@simplewebauthn/browser') | undefined>(undefined), ceremony = useRef(false)
  const pending = useRef<{ controller: AbortController; sent: boolean; target?: string } | undefined>(undefined)
  const busy = ['beginning', 'verifying', 'sending'].includes(current.stage)
  function invalidate() {
    epoch.current++; pending.current?.controller.abort(); pending.current = undefined
    if (ceremony.current) { ceremony.current = false; helper.current?.WebAuthnAbortService.cancelCeremony() }
  }
  useEffect(() => {
    mounted.current = true; invalidate()
    setDisplay({ userId: props.userId, locale: props.locale, stage: 'idle' })
    setSupported(typeof window.PublicKeyCredential === 'function' && !!navigator.credentials)
    const hide = () => { invalidate(); setDisplay({ userId: latest.current.userId, locale: latest.current.locale, stage: 'idle' }) }
    window.addEventListener('pagehide', hide)
    return () => { mounted.current = false; invalidate(); window.removeEventListener('pagehide', hide) }
  }, [props.userId, props.locale])
  useEffect(() => { if (current.stage !== 'idle') message.current?.focus() }, [current.stage, current.reconciled])
  async function principalRefused(error: unknown, userId: string) {
    if (!(error instanceof Response) || error.status !== 401 || !mounted.current || latest.current.userId !== userId) return false
    // A real refusal invalidates all earlier work for this User, including a
    // still-pending success. The parent removes the private account display.
    invalidate(); setDisplay({ userId, locale: latest.current.locale, stage: 'refused' })
    await latest.current.onRefused().catch(() => {})
    return true
  }
  function cancel() {
    const work = pending.current
    if (!work) return
    invalidate()
    setDisplay(value => ({ ...value, stage: work.sent && work.target ? 'unconfirmed' : 'cancelled',
      uncertainTarget: work.sent && work.target ? work.target : value.uncertainTarget, reconciled: undefined }))
  }
  async function run(action: 'LIST' | 'REVOKE', selector?: string) {
    if (!hydrated || !supported || !props.available || pending.current) return
    const initial = props, controller = new AbortController(), version = epoch.current
    const work = { controller, sent: false, target: action === 'REVOKE' ? selector : undefined }; pending.current = work
    const live = () => mounted.current && !controller.signal.aborted && version === epoch.current
      && latest.current.userId === initial.userId && latest.current.locale === initial.locale
    setDisplay(value => ({ ...value, stage: 'beginning', reconciled: undefined,
      uncertainTarget: action === 'REVOKE' ? undefined : value.uncertainTarget }))
    try {
      const begun = action === 'LIST' ? await initial.onBeginList({ ...(selector ? { cursor: selector } : {}),
        ...(current.uncertainTarget ? { reconcileSessionId: current.uncertainTarget } : {}) }, controller.signal)
        : await initial.onBeginRevocation({ sessionId: selector! }, controller.signal)
      if (begun instanceof Response) throw begun
      if (!live()) return
      setDisplay(value => ({ ...value, stage: 'verifying' }))
      const browser = await import('@simplewebauthn/browser'); helper.current = browser
      if (!live()) return
      ceremony.current = true
      let response: AuthenticationResponseJSON
      try { response = await browser.startAuthentication({ optionsJSON: begun.options }) }
      finally { if (pending.current === work && epoch.current === version) ceremony.current = false }
      if (!live()) return
      const input = { challengeId: begun.challengeId, response }
      work.sent = true; setDisplay(value => ({ ...value, stage: 'sending' }))
      if (action === 'LIST') {
        const result = await initial.onFinishList(input, controller.signal)
        if (result instanceof Response) throw result
        if (live()) setDisplay(value => ({ ...value, page: result, stage: 'listed', reconciled: result.targetState }))
      } else {
        const result = await initial.onFinishRevocation(input, controller.signal)
        if (result instanceof Response) throw result
        if (!live()) return
        if (result.revoked !== true || result.sessionId !== selector) throw new Error('Revocation outcome unconfirmed')
        setDisplay(value => ({ ...value, stage: 'confirmed', uncertainTarget: undefined, reconciled: undefined,
          page: value.page ? { ...value.page, sessions: value.page.sessions.filter(row => row.id !== result.sessionId) } : undefined }))
      }
    } catch (error) {
      if (await principalRefused(error, initial.userId) || !live()) return
      const status = error instanceof Response ? error.status : undefined
      const unknown = action === 'REVOKE' && work.sent && (status === undefined || status >= 500)
      const cancelled = !work.sent && error instanceof Error && (error.name === 'AbortError' || error.name === 'NotAllowedError')
      const stage: Stage = unknown ? 'unconfirmed' : cancelled ? 'cancelled' : status === 409 ? 'restart'
        : status === 400 || status === 401 ? 'refused' : 'unavailable'
      setDisplay(value => ({ ...value, stage, uncertainTarget: unknown ? selector : value.uncertainTarget, reconciled: undefined }))
    } finally { if (pending.current === work) pending.current = undefined }
  }
  const status = current.uncertainTarget && current.reconciled ? t[current.reconciled] : t[current.stage]
  return <section className="auth-sessions" aria-labelledby="sessions-title" aria-busy={busy}>
    <h2 id="sessions-title">{t.title}</h2><p>{t.intro}</p>
    <div className="auth-session-actions">
      <Button label={current.page ? t.refresh : t.view} variant="secondary" isDisabled={!hydrated || !supported || !props.available || busy} onClick={() => { void run('LIST') }} />
      {current.page?.nextCursor && <Button label={t.next} variant="secondary" isDisabled={busy || !supported} onClick={() => { void run('LIST', current.page!.nextCursor!) }} />}
      {busy && <Button label={t.cancel} variant="secondary" onClick={cancel} />}
    </div>
    {!props.available && <p>{t.eligibility}</p>}
    {hydrated && !supported && <p>{t.unsupported}</p>}
    <p ref={message} tabIndex={-1} role={['unconfirmed', 'refused', 'unavailable', 'restart'].includes(current.stage) ? 'alert' : 'status'}>{status}</p>
    {current.uncertainTarget && <Button label={t.check} variant="secondary" isDisabled={busy || !supported || !props.available} onClick={() => { void run('LIST') }} />}
    {current.page && <><p>{t.pageHelp}</p><SessionRows locale={props.locale} rows={current.page.sessions} disabled={busy || !supported || !props.available}
      onRevoke={id => { void run('REVOKE', id) }} /></>}
  </section>
}
