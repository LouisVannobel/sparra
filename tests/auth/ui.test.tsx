import { expect, test } from 'vitest'
import { renderToString } from 'react-dom/server'
import { LoginPanel, AccountPanel } from '../../src/ui/auth/auth-panels'
import { AuthEmailInput } from '../../src/ui/auth/auth-email-input'
import * as passkeyPanel from '../../src/ui/auth/passkey-login-panel'

test('first auth controls expose truthful unavailable and translated error states without personal placeholders', () => {
  const fr = renderToString(<LoginPanel locale="fr" enabled={false} pending={false} failed={false} onBegin={() => {}} />)
  expect(fr).toContain('Continuer avec Google')
  expect(fr).toContain('<img')
  expect(fr).toContain('width="40" height="40"')
  expect(fr).toContain('disabled')
  expect(fr).toContain('La connexion Google est indisponible')
  expect(fr).not.toContain('Sign in')
  const en = renderToString(<LoginPanel locale="en" enabled pending failed onBegin={() => {}} />)
  expect(en).toContain('Continue with Google')
  expect(en).toContain('role="alert"')
  expect(en).toContain('aria-busy="true"')
  expect(en).not.toContain('Connexion')
})
test('account presents only supplied current principal and real logout action', () => {
  const html = renderToString(<AccountPanel locale="en" principal={{ name: 'Current person', email: 'current@example.test', userId: 'not-rendered-internal-id' }} pending={false} failed={false} onLogout={() => {}} />)
  expect(html).toContain('Current person')
  expect(html).toContain('current@example.test')
  expect(html).toContain('Sign out')
  expect(html).not.toContain('not-rendered-internal-id')
})

test.each(['fr', 'en'] as const)('login exposes one explicit localized passkey action with an accessible helper state in %s', locale => {
  const html = renderToString(<LoginPanel locale={locale} enabled={false} pending={false} failed={false} onBegin={() => {}}
    passkey onPasskeyBegin={async () => ({ options: { challenge: 'fixture', rpId: 'app.example.test' } })}
    onPasskeyFinish={async () => ({ authenticated: true })} />)
  expect(html).toContain(locale === 'fr' ? 'Se connecter avec une passkey' : 'Sign in with a passkey')
  expect(html).toContain(locale === 'fr' ? 'Préparation de la connexion par passkey' : 'Preparing passkey sign-in')
  expect(html).toContain('role="status"')
  expect(html).not.toContain('Continuer avec ma passkey')
  expect(html).not.toContain('Continue with my passkey')
})

test('passkey lifecycle recovers a BFCache-restored page instead of leaving a disabled stale operation', () => {
  expect('passkeyRestoreProblem' in passkeyPanel, 'Feature absence: BFCache passkey recovery policy is missing').toBe(true)
  if (!('passkeyRestoreProblem' in passkeyPanel)) return
  expect(passkeyPanel.passkeyRestoreProblem(false)).toBeUndefined()
  expect(passkeyPanel.passkeyRestoreProblem(true)).toBe('uncertain')
})

test('passkey restore preserves helper failure and its retry instead of returning to an inert loading state', () => {
  expect('passkeyRestorePhase' in passkeyPanel, 'Feature absence: restored helper-failure policy is missing').toBe(true)
  if (!('passkeyRestorePhase' in passkeyPanel)) return
  expect(passkeyPanel.passkeyRestorePhase({ helperReady: false, helperFailed: true, supported: false })).toBe('helper-failed')
  expect(passkeyPanel.passkeyRestorePhase({ helperReady: true, helperFailed: false, supported: true })).toBe('ready')
  expect(passkeyPanel.passkeyRestorePhase({ helperReady: true, helperFailed: false, supported: false })).toBe('unsupported')
})

test('passkey cancellation after finish was sent reports ambiguity rather than rollback certainty', () => {
  expect('passkeyCancellationProblem' in passkeyPanel, 'Feature absence: sent-finish cancellation policy is missing').toBe(true)
  if (!('passkeyCancellationProblem' in passkeyPanel)) return
  expect(passkeyPanel.passkeyCancellationProblem(false)).toBe('cancelled')
  expect(passkeyPanel.passkeyCancellationProblem(true)).toBe('uncertain')
})

test.each(['fr', 'en'] as const)('auth email exposes native purpose and linked label/help/error in %s SSR', locale => {
  const html = renderToString(<AuthEmailInput locale={locale} value="" onChange={() => {}} description="Intended account" error="Invalid address" />)
  const input = html.match(/<input\b[^>]*>/)?.[0] ?? ''
  const id = input.match(/\bid="([^"]+)"/)?.[1]
  expect(typeof id).toBe('string')
  expect(input).toContain('type="email"')
  expect(input).toContain('name="email"')
  expect(input).toContain('autoComplete="email"')
  expect(input).toContain('inputMode="email"')
  expect(input).toContain('aria-invalid="true"')
  expect(input).toContain(`aria-describedby="${id}-description ${id}-error"`)
  expect(html).toContain(`for="${id}"`)
  expect(html).toContain(`id="${id}-description"`)
  expect(html).toContain(`id="${id}-error"`)
  expect(html).toContain(locale === 'fr' ? 'Adresse e-mail' : 'Email address')
})
