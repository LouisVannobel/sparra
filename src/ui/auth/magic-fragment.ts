// Proof is never rendered, serialized, or placed in a router/storage object.
// Rendering may read availability repeatedly (including StrictMode).
let proof: string | undefined
let revision = 0, blocked = false, installed = false
let nativeReplace: History['replaceState'] | undefined
const arrivals = new Set<(revision: number) => void>()

function publish(value: string | undefined, failed = false) {
  proof = value; blocked = failed; revision++
  for (const notify of arrivals) notify(revision)
}
function capture(importProof = true) {
  const fragment = location.hash, clean = location.pathname + location.search, state = history.state
  try {
    const replace = nativeReplace ?? history.replaceState.bind(history)
    replace(state, '', clean)
    if (location.hash !== '' || location.pathname + location.search !== clean) throw new Error()
  } catch { publish(undefined, true); return false }
  // Never recover authority from a delayed browser event's oldURL/newURL.
  if (importProof) publish(/^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(fragment) ? fragment.slice(7) : undefined)
  else forgetMagicFragment()
  return true
}

export function bootstrapMagicFragment() {
  return location.pathname !== '/auth/magic/confirm' || capture()
}
export function readMagicFragment(expectedRevision = revision) { return !blocked && expectedRevision === revision ? proof : undefined }
export function getMagicFragmentRevision() { return revision }
export function isMagicFragmentBlocked() { return blocked }
export function forgetMagicFragment() { proof = undefined; revision++ }
export function subscribeMagicFragment(notify: (revision: number) => void) {
  arrivals.add(notify)
  return () => { arrivals.delete(notify) }
}

export function installMagicFragmentGuard() {
  if (installed) return !blocked
  installed = true
  nativeReplace = history.replaceState.bind(history)
  function activeFragment() { return location.pathname === '/auth/magic/confirm' && location.hash !== '' }
  function reservedURL(value: string) {
    try {
      const url = new URL(value)
      return url.origin === location.origin && url.pathname === '/auth/magic/confirm' && url.hash !== ''
    } catch { return false }
  }
  window.addEventListener('popstate', event => {
    if (activeFragment() && !capture()) event.stopImmediatePropagation()
  }, { capture: true })
  window.addEventListener('hashchange', event => {
    // Clearing location cannot rewrite these browser-owned fields. Suppress
    // their delivery even after the panel leaves, without ever importing them.
    if (reservedURL(event.oldURL) || reservedURL(event.newURL)) event.stopImmediatePropagation()
    if (activeFragment()) {
      if (!capture()) { event.stopImmediatePropagation(); return }
      // Hashchange-first fallback: only the already-clean URL reaches the
      // ordinary History wrapper, so its cache and subscribers synchronize.
      try { history.replaceState(history.state, '', location.pathname + location.search) }
      catch { publish(undefined, true); event.stopImmediatePropagation() }
    }
  }, { capture: true })
  window.addEventListener('pagehide', forgetMagicFragment)
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      forgetMagicFragment()
      if (activeFragment() && !capture(false)) event.stopImmediatePropagation()
    }
  }, { capture: true })
  return bootstrapMagicFragment()
}
