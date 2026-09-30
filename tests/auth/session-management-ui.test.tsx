import { expect, test } from 'vitest'
import { renderToString } from 'react-dom/server'
import { SessionManagementPanel, SessionRows } from '../../src/ui/auth/session-management-panel'
test.each(['fr', 'en'] as const)('session panel keeps private data absent and explicit proof controls disabled before hydration in %s', async locale => {
  const unused = async (): Promise<never> => { throw new Error('SSR must not start session commands') }
  const html = renderToString(<SessionManagementPanel locale={locale} userId="private-user-canary" available
    onBeginList={unused} onFinishList={unused} onBeginRevocation={unused} onFinishRevocation={unused} onRefused={unused} />)
  expect(html).toContain(locale === 'fr' ? 'Voir les sessions' : 'View sessions')
  expect(html).toContain('disabled')
  expect(html).not.toContain('private-user-canary')
  expect(html).not.toContain('<time'); expect(html).not.toContain('<li')
})
test.each(['fr', 'en'] as const)('current session has a marker and no revoke control; other rows have localized dates in %s', async locale => {
  const rows = [{ id: 'current', current: true, createdAt: '2030-01-01T12:00:00.000Z', lastActivityAt: '2030-01-02T12:00:00.000Z', expiresAt: '2030-01-03T00:00:00.000Z' },
    { id: 'other', current: false, createdAt: '2030-01-01T12:00:00.000Z', lastActivityAt: '2030-01-02T12:00:00.000Z', expiresAt: '2030-01-03T00:00:00.000Z' }]
  const html = renderToString(<SessionRows locale={locale} rows={rows} disabled={false} onRevoke={() => {}} />)
  expect(html).toContain(locale === 'fr' ? 'Session actuelle' : 'Current session')
  expect(html.match(/<button/g)?.length).toBe(1)
  expect(html.match(/<time/g)?.length).toBe(6)
  expect(html).not.toContain('token'); expect(html).not.toContain('userAgent')
})
