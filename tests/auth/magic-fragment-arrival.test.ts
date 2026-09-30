import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
function environment(hash = '', failure?: 'throw' | 'noop') {
  const url = new URL('https://app.example.test/auth/magic/confirm?lang=en' + hash)
  const window = new EventTarget(), state = { opaque: 'retained' }
  const history = { state, replaceState(value: unknown, _title: string, href?: string | URL | null) {
    expect(this).toBe(history); expect(value).toBe(state)
    if (failure === 'throw') throw new Error('Controlled native clear failure')
    if (failure !== 'noop') url.href = new URL(String(href), url).href
  } }
  vi.stubGlobal('window', window); vi.stubGlobal('location', url); vi.stubGlobal('history', history)
  function hashchange(oldURL: string, newURL: string) { return Object.assign(new Event('hashchange'), { oldURL, newURL }) }
  return { url, window, history, hashchange, failNative: (next: 'throw' | 'noop') => { failure = next } }
}

test('native arrival clears before downstream observers, uses one revision per pair, and delayed A cannot replace B', async () => {
  const env = environment(), mod = await import('../../src/ui/auth/magic-fragment')
  expect(typeof mod.installMagicFragmentGuard).toBe('function')
  expect(mod.installMagicFragmentGuard()).toBe(true)
  const initial = mod.getMagicFragmentRevision(), observed: number[] = []
  const off = mod.subscribeMagicFragment(revision => { expect(env.url.hash).toBe(''); observed.push(revision) })
  let downstream = 0, wrapped = 0
  env.window.addEventListener('popstate', () => { expect(env.url.hash).toBe(''); downstream++ })
  env.window.addEventListener('hashchange', () => { downstream++ })
  const native = env.history.replaceState.bind(env.history)
  env.history.replaceState = (...args) => { wrapped++; native(...args) }
  const clean = env.url.href
  env.url.hash = '#token=' + 'A'.repeat(43); const a = env.url.href
  env.window.dispatchEvent(new Event('popstate'))
  expect(mod.readMagicFragment() === 'A'.repeat(43)).toBe(true)
  env.window.dispatchEvent(env.hashchange(clean, a))
  expect(observed).toEqual([initial + 1]); expect(downstream).toBe(1); expect(wrapped).toBe(0)
  env.url.hash = '#token=' + 'E'.repeat(43)
  env.window.dispatchEvent(new Event('popstate'))
  const second = mod.getMagicFragmentRevision()
  env.window.dispatchEvent(env.hashchange(a, clean))
  expect(mod.getMagicFragmentRevision()).toBe(second)
  expect(mod.readMagicFragment() === 'E'.repeat(43)).toBe(true)
  expect(mod.readMagicFragment(initial + 1)).toBeUndefined()
  off()
})

test('hashchange-first synchronizes the wrapped history only after native cleaning and private notification', async () => {
  const env = environment(), mod = await import('../../src/ui/auth/magic-fragment')
  mod.installMagicFragmentGuard()
  const order: string[] = [], clean = env.url.href
  mod.subscribeMagicFragment(() => { expect(env.url.hash).toBe(''); order.push('private') })
  const native = env.history.replaceState.bind(env.history)
  env.history.replaceState = (...args) => { expect(env.url.hash).toBe(''); order.push('wrapped'); native(...args) }
  env.url.hash = '#token=' + 'A'.repeat(43)
  env.window.dispatchEvent(env.hashchange(clean, env.url.href))
  expect(order).toEqual(['private', 'wrapped'])
  expect(mod.readMagicFragment() === 'A'.repeat(43)).toBe(true)
})

test('malformed arrival replaces old authority, leave purges, and unrelated anchors survive', async () => {
  const env = environment('#token=' + 'A'.repeat(43)), mod = await import('../../src/ui/auth/magic-fragment')
  mod.installMagicFragmentGuard()
  const revision = mod.getMagicFragmentRevision()
  env.url.hash = '#token=malformed'; env.window.dispatchEvent(new Event('popstate'))
  expect(env.url.hash).toBe(''); expect(mod.readMagicFragment()).toBeUndefined()
  expect(mod.getMagicFragmentRevision()).toBeGreaterThan(revision)
  env.url.hash = '#token=' + 'E'.repeat(43); env.window.dispatchEvent(new Event('popstate'))
  env.window.dispatchEvent(new Event('pagehide'))
  expect(mod.readMagicFragment()).toBeUndefined()
  env.url.pathname = '/workspace'; env.url.hash = '#section'
  env.window.dispatchEvent(new Event('popstate'))
  expect(env.url.hash).toBe('#section')
})

test.each(['throw', 'noop'] as const)('native clear %s prevents auth and sensitive downstream delivery without claiming clean URL', async failure => {
  const env = environment('#token=' + 'A'.repeat(43), failure), mod = await import('../../src/ui/auth/magic-fragment')
  expect(mod.installMagicFragmentGuard()).toBe(false)
  expect(mod.readMagicFragment()).toBeUndefined(); expect(mod.isMagicFragmentBlocked()).toBe(true)
  expect(env.url.hash !== '').toBe(true)
  let observed = false
  env.window.addEventListener('popstate', () => { observed = true })
  env.window.dispatchEvent(new Event('popstate'))
  expect(observed).toBe(false)
})

test('persisted restoration clears an arriving fragment without importing authority from the restored entry', async () => {
  const env = environment('#token=' + 'A'.repeat(43)), mod = await import('../../src/ui/auth/magic-fragment')
  mod.installMagicFragmentGuard()
  env.window.dispatchEvent(new Event('pagehide'))
  let delivered = 0
  env.window.addEventListener('pageshow', () => { delivered++ }, { capture: true })
  env.url.hash = '#token=' + 'E'.repeat(43)
  env.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(env.url.hash).toBe('')
  expect(mod.readMagicFragment()).toBeUndefined()
  expect(mod.isMagicFragmentBlocked()).toBe(false)
  expect(delivered).toBe(1)
})

// This Node EventTarget checks suppression and synchronous notification, not
// actual browser capture/bubble phase ordering or a real BFCache restoration.
test.each(['throw', 'noop'] as const)('persisted restoration with native %s blocks, notifies and prevents sensitive downstream delivery', async failure => {
  const env = environment('#token=' + 'A'.repeat(43)), mod = await import('../../src/ui/auth/magic-fragment')
  expect(mod.installMagicFragmentGuard()).toBe(true)
  env.window.dispatchEvent(new Event('pagehide'))
  const pending = new AbortController(), notifications: { blocked: boolean; absent: boolean; dirty: boolean }[] = []
  mod.subscribeMagicFragment(() => {
    pending.abort()
    notifications.push({ blocked: mod.isMagicFragmentBlocked(), absent: mod.readMagicFragment() === undefined, dirty: env.url.hash !== '' })
  })
  let delivered = false
  env.window.addEventListener('pageshow', () => { delivered = true }, { capture: true })
  env.failNative(failure)
  env.url.hash = '#token=' + 'E'.repeat(43)
  env.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(notifications).toEqual([{ blocked: true, absent: true, dirty: true }])
  expect(pending.signal.aborted).toBe(true)
  expect(mod.isMagicFragmentBlocked()).toBe(true)
  expect(mod.readMagicFragment()).toBeUndefined()
  expect(env.url.hash !== '').toBe(true)
  expect(delivered).toBe(false)
})
