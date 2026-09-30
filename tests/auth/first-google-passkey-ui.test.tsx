import { expect, test, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { FirstGooglePasskeyPanelProps } from '../../src/ui/auth/first-google-passkey-panel'

test.each(['fr', 'en'] as const)('first-key UI explains conditional Google proof and stays disabled before hydration in %s', async locale => {
  const modules = import.meta.glob('../../src/ui/auth/first-google-passkey-panel.tsx')
  const load = modules['../../src/ui/auth/first-google-passkey-panel.tsx']
  expect(typeof load).toBe('function')
  const { FirstGooglePasskeyPanel } = await load() as typeof import('../../src/ui/auth/first-google-passkey-panel')
  const unused = async (): Promise<never> => { throw new Error('SSR must not trigger an action') }
  const props: FirstGooglePasskeyPanelProps = { locale, available: true, userId: 'private-user', onBegin: unused, onRead: unused,
    onPrepare: unused, onFinish: unused, onCancel: unused, onAdded: unused }
  const html = renderToString(<FirstGooglePasskeyPanel {...props} />)
  expect(html).toContain(locale === 'fr' ? 'Première passkey' : 'First passkey')
  expect(html).toContain(locale === 'fr' ? 'authentification Google récente' : 'recent Google authentication')
  expect(html).toContain('disabled')
  expect(html).not.toContain('private-user')
})

test('terminal invalidation never promises that authorization is still pending', async () => {
  const module = await import('../../src/ui/auth/first-google-passkey-panel')
  const message = Reflect.get(module, 'firstGoogleStatusMessage')
  expect(typeof message).toBe('function')
  for (const reason of ['unavailable', 'superseded'] as const) {
    expect(message({ state: 'invalidated', reason })).toBe('invalidated')
  }
  expect(message({ state: 'invalidated', reason: 'proof_unavailable' })).toBe('proofUnavailable')
  expect(message({ state: 'invalidated', reason: 'proof_stale' })).toBe('proofStale')
  expect(message({ state: 'invalidated', reason: 'cancelled' })).toBe('cancelled')
  expect(message({ state: 'authorized', reason: null })).toBe('authorized')
  expect(message({ state: 'added', reason: null })).toBe('added')
})

test('only a live Begin stores its non-authoritative target in account history before same-tab provider navigation', async () => {
  const module = await import('../../src/ui/auth/first-google-passkey-panel')
  const navigate = Reflect.get(module, 'navigateFirstGoogleProof')
  expect(typeof navigate).toBe('function')
  const metadata = { __TSR_index: 3, scroll: 'preserved' }, effects: string[] = []
  const replaceState = vi.fn((_state: unknown, _title: string, _url: string) => { effects.push('history') })
  const assign = vi.fn((_url: string) => { effects.push('navigate') })
  vi.stubGlobal('window', { history: { state: metadata, replaceState }, location: { assign } })
  const intentId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  const value = { intentId, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' }
  try {
    navigate(value, 'en', () => false)
    expect(effects).toEqual([])
    navigate(value, 'en', () => true)
    expect(effects).toEqual(['history', 'navigate'])
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(metadata, '', '/account?lang=en&firstPasskey=' + intentId)
    expect(assign).toHaveBeenCalledExactlyOnceWith(value.url)
    expect(() => navigate({ ...value, intentId: 'not-a-target' }, 'en', () => true)).toThrow()
    expect(effects).toEqual(['history', 'navigate'])
  } finally { vi.unstubAllGlobals() }
})
