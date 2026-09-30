import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AdditionalPasskeyPanel } from '../../src/ui/auth/additional-passkey-panel'

const unavailable = async (): Promise<never> => { throw new Error('SSR must not invoke commands') }
test('initial_account_renders_add_action_in_both_locales', () => {
  for (const [locale, label] of [['fr', 'Ajouter une clé'], ['en', 'Add a passkey']] as const) {
    const html = renderToStaticMarkup(<AdditionalPasskeyPanel locale={locale} userId="fixture" availability="available" passkeys={[]}
      onBegin={unavailable} onAuthorize={unavailable} onFinish={unavailable} onRefresh={unavailable} />)
    expect(html.includes(label)).toBe(true)
    expect(html.includes('role="status"')).toBe(true)
  }
})
test('missing_prerequisites_render_truthful_workspace_or_key_state', () => {
  for (const availability of ['workspace-required', 'existing-key-required'] as const) {
    const html = renderToStaticMarkup(<AdditionalPasskeyPanel locale="en" userId="fixture" availability={availability} passkeys={[]}
      onBegin={unavailable} onAuthorize={unavailable} onFinish={unavailable} onRefresh={unavailable} />)
    expect(html.includes(availability === 'workspace-required' ? '/workspace?lang=en' : 'existing passkey')).toBe(true)
    expect(html.includes('Add a passkey')).toBe(false)
  }
})
