import { expect, test } from 'vitest'
import { WorkspacePanel } from '../../src/ui/workspaces/workspace-panel'
import { renderPrivatePanel } from '../helpers/private-panel-router'

test('unprovisioned account offers only explicit creation and back navigation', async () => {
  const html = await renderPrivatePanel(<WorkspacePanel locale="fr" workspace={null} pending={false} failed={false} saved={false} onEnsure={async () => {}} onRename={async () => {}} />, '/workspace?lang=fr')
  expect(html).toContain('Créer mon espace')
  expect(html).toContain('/account?lang=fr')
  expect(html).not.toContain('type="text"')
})
test('actual persisted name is escaped; form and announced busy/error/saved states are accessible in both languages', async () => {
  for (const locale of ['fr','en'] as const) {
    const html = await renderPrivatePanel(<WorkspacePanel locale={locale} workspace={{ id: 'private-selector', displayName: '<script>persisted</script>' }} pending failed saved onEnsure={async () => {}} onRename={async () => {}} />, `/workspace?lang=${locale}`)
    expect(html).toContain('&lt;script&gt;persisted&lt;/script&gt;')
    expect(html).not.toContain('<script>persisted')
    expect(html).not.toContain('private-selector')
    expect(html).toContain('type="text"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain(locale === 'fr' ? 'Nom enregistré' : 'Name saved')
  }
})

test.each(['fr', 'en'] as const)('workspace creation and rename share the private navigation and current workspace context in %s', async locale => {
  const forbidden = async (): Promise<never> => { throw new Error('Navigation must not create or rename a workspace') }
  for (const workspace of [null, { id: 'private-selector', displayName: 'Persisted name' }]) {
    const html = await renderPrivatePanel(<WorkspacePanel locale={locale} workspace={workspace} pending={false} failed={false} saved={false} onEnsure={forbidden} onRename={forbidden} />, `/workspace?lang=${locale}`)
    const navigation = html.match(/<nav\b[^>]*class="sparra-app-nav"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(navigation).toContain(`href="/account?lang=${locale}"`)
    expect(navigation).toContain(`href="/app?lang=${locale}"`)
    const active = navigation.match(/<a\b[^>]*aria-current="page"[^>]*>/g) ?? []
    expect(active).toHaveLength(1)
    expect(active[0]).toContain(`href="/workspace?lang=${locale}"`)
    expect(active[0]).toContain('data-status="active"')
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html).toContain('href="#app-content"')
    expect(html).toContain('id="app-content"')
    expect(html).toContain(locale === 'fr' ? 'Votre espace personnel' : 'Your personal workspace')
    expect(html).toContain(`<a class="auth-back" href="/account?lang=${locale}">${locale === 'fr' ? 'Retour au compte' : 'Back to account'}</a>`)
    expect(html).not.toContain('private-selector')
  }
})
