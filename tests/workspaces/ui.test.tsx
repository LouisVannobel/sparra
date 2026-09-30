import { expect, test } from 'vitest'
import { renderToString } from 'react-dom/server'
import { WorkspacePanel } from '../../src/ui/workspaces/workspace-panel'

test('unprovisioned account offers only explicit creation and back navigation', () => {
  const html = renderToString(<WorkspacePanel locale="fr" workspace={null} pending={false} failed={false} saved={false} onEnsure={async () => {}} onRename={async () => {}} />)
  expect(html).toContain('Créer mon espace')
  expect(html).toContain('/account?lang=fr')
  expect(html).not.toContain('type="text"')
})
test('actual persisted name is escaped; form and announced busy/error/saved states are accessible in both languages', () => {
  for (const locale of ['fr','en'] as const) {
    const html = renderToString(<WorkspacePanel locale={locale} workspace={{ id: 'private-selector', displayName: '<script>persisted</script>' }} pending failed saved onEnsure={async () => {}} onRename={async () => {}} />)
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
