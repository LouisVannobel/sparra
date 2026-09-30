import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

// Replacing capture with a post-render clear, parsing before clearing, or
// using a destructive render read would lose or expose the transient proof.
test('bootstrap removes fragment before parsing and preserves non-secret URL/state; reads survive StrictMode', async () => {
  const { bootstrapMagicFragment, readMagicFragment, forgetMagicFragment } = await import('../../src/ui/auth/magic-fragment')
  const state = { native: 'history' }, events: string[] = []
  vi.stubGlobal('location', { pathname: '/auth/magic/confirm', search: '?lang=en', hash: '#token=' + 'A'.repeat(43) })
  vi.stubGlobal('history', { state, replaceState(value: unknown, title: string, url: string) {
    expect(value).toBe(state); expect(title).toBe(''); expect(url).toBe('/auth/magic/confirm?lang=en')
    events.push('clear'); expect(readMagicFragment()).toBeUndefined()
    location.hash = ''
  } })
  bootstrapMagicFragment()
  expect(events).toEqual(['clear'])
  expect(readMagicFragment() === 'A'.repeat(43)).toBe(true)
  expect(readMagicFragment() === 'A'.repeat(43)).toBe(true)
  forgetMagicFragment(); expect(readMagicFragment()).toBeUndefined()
})

test.each(['#token=short', '#token=' + 'A'.repeat(42) + 'B', '#token=' + 'A'.repeat(43) + '&extra=yes', '#unrelated'])('invalid confirmation fragment is removed and unavailable %#', async hash => {
  const { bootstrapMagicFragment, readMagicFragment } = await import('../../src/ui/auth/magic-fragment')
  let cleared = false
  vi.stubGlobal('location', { pathname: '/auth/magic/confirm', search: '', hash })
  vi.stubGlobal('history', { state: null, replaceState() { cleared = true; location.hash = '' } })
  bootstrapMagicFragment()
  expect(cleared).toBe(true); expect(readMagicFragment()).toBeUndefined()
})

test('unrelated route anchor is untouched and reload with clean URL has no proof', async () => {
  const { bootstrapMagicFragment, readMagicFragment } = await import('../../src/ui/auth/magic-fragment')
  let clears = 0
  vi.stubGlobal('location', { pathname: '/workspace', search: '', hash: '#section' })
  vi.stubGlobal('history', { state: null, replaceState() { clears++ } })
  bootstrapMagicFragment(); expect(clears).toBe(0); expect(readMagicFragment()).toBeUndefined()
  vi.stubGlobal('location', { pathname: '/auth/magic/confirm', search: '?lang=fr', hash: '' })
  bootstrapMagicFragment(); expect(readMagicFragment()).toBeUndefined()
})
