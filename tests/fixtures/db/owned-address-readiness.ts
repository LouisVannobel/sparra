import { execFile } from 'node:child_process'

type Link = Readonly<{ index: number; name: string; active: boolean; addresses: unknown[] }>
type KernelFields = Readonly<{
  ifindex?: unknown; ifname?: unknown; flags?: unknown; master?: unknown
  linkinfo?: unknown; info_kind?: unknown; addr_info?: unknown
  family?: unknown; scope?: unknown; tentative?: unknown; optimistic?: unknown; dadfailed?: unknown
}>
const invalid = () => new Error('Owned address readiness invalid snapshot')
const timeout = () => new Error('Owned address readiness timeout')
const object = (value: unknown): value is KernelFields => value !== null && typeof value === 'object' && !Array.isArray(value)

function readOwnedAddresses(args: string[], deadline: number) {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining < 1) throw timeout()
  return new Promise<string>((resolve, reject) => {
    let completed = false, closed = false, failed = false, output = ''
    const finish = () => {
      if (!completed || !closed) return
      if (failed) reject(new Error('Owned address readiness command failed'))
      else resolve(output)
    }
    try {
      const child = execFile('ip', args, {
        shell: false, windowsHide: true, encoding: 'utf8',
        env: { PATH: process.env.PATH, LC_ALL: 'C' },
        timeout: Math.min(1000, remaining), killSignal: 'SIGKILL', maxBuffer: 32768,
      }, (error, stdout, stderr) => {
        if (completed) return
        completed = true
        failed ||= error !== null || typeof stdout !== 'string' || typeof stderr !== 'string' || stderr.length !== 0 || Buffer.byteLength(stdout) > 32768
        if (!failed) output = stdout
        finish()
      })
      child.once('close', (code, signal) => {
        closed = true
        failed ||= code !== 0 || signal !== null
        finish()
      })
    } catch { reject(new Error('Owned address readiness command failed')) }
  })
}

function parseLinks(raw: string, bridge: string, kind: 'bridge' | 'veth'): Link[] {
  let values: unknown
  try { values = JSON.parse(raw) } catch { throw invalid() }
  if (!Array.isArray(values) || values.length > (kind === 'bridge' ? 1 : 3)) throw invalid()
  return values.map((value: unknown) => {
    if (!object(value) || !Number.isSafeInteger(value.ifindex) || Number(value.ifindex) < 1
      || typeof value.ifname !== 'string' || !/^[a-zA-Z0-9_.-]{1,15}$/.test(value.ifname)
      || !object(value.linkinfo) || value.linkinfo.info_kind !== kind
      || (kind === 'bridge' ? value.ifname !== bridge : value.master !== bridge)
      || !Array.isArray(value.flags) || value.flags.length > 32 || value.flags.some(flag => typeof flag !== 'string' || flag.length > 32)
      || (value.addr_info !== undefined && (!Array.isArray(value.addr_info) || value.addr_info.length > 16))) throw invalid()
    return { index: Number(value.ifindex), name: value.ifname, active: value.flags.includes('UP'), addresses: value.addr_info ?? [] }
  })
}

function ipv6Pending(value: KernelFields) {
  const flags: ('tentative' | 'optimistic' | 'dadfailed')[] = ['tentative', 'optimistic', 'dadfailed']
  if (flags.some(flag => Object.hasOwn(value, flag) && typeof value[flag] !== 'boolean')) throw invalid()
  if (value.dadfailed === true) throw new Error('Owned address readiness DAD failed')
  return value.tentative === true || value.optimistic === true
}

function addressesPending(link: Link) {
  let linkIPv6 = false, pending = !link.active
  for (const value of link.addresses) {
    if (!object(value) || typeof value.family !== 'string' || !['inet', 'inet6'].includes(value.family)
      || typeof value.scope !== 'string' || !['host', 'link', 'global', 'site'].includes(value.scope)
      || Object.hasOwn(value, 'ifa_flags')) throw invalid()
    if (value.family !== 'inet6') continue
    const addressPending = ipv6Pending(value)
    linkIPv6 ||= value.scope === 'link'
    pending ||= addressPending
  }
  return pending || !linkIPv6
}

function snapshotPending(bridges: Link[], veths: Link[]) {
  const links = [...bridges, ...veths]
  if (new Set(links.map(link => link.index)).size !== links.length || new Set(links.map(link => link.name)).size !== links.length) throw invalid()
  // Inspect every present target even when a different target is still absent.
  const pending = links.map(addressesPending).some(Boolean)
  return bridges.length !== 1 || veths.length !== 3 || pending
}

export async function awaitOwnedStoreAddresses(networkId: string): Promise<Readonly<{
  scope: 'confirmed' | 'unperformed'; state: 'ready' | 'unperformed'
  bridgeCount: number; vethCount: number; pendingRounds: number; elapsedMs: number
}>> {
  if (process.platform === 'win32') return { scope: 'unperformed', state: 'unperformed', bridgeCount: 0, vethCount: 0, pendingRounds: 0, elapsedMs: 0 }
  if (process.platform !== 'linux') throw new Error('Owned address readiness unsupported platform')
  if (!/^[a-f0-9]{64}$/.test(networkId)) throw new Error('Owned address readiness invalid network')
  const bridge = 'br-' + networkId.slice(0, 12), started = performance.now(), deadline = started + 5000
  let pendingRounds = 0
  while (performance.now() < deadline) {
    const roundStarted = performance.now()
    const bridges = parseLinks(await readOwnedAddresses(['-j', '-d', 'address', 'show', 'dev', bridge], deadline), bridge, 'bridge')
    const veths = parseLinks(await readOwnedAddresses(['-j', '-d', 'address', 'show', 'master', bridge, 'type', 'veth'], deadline), bridge, 'veth')
    if (performance.now() >= deadline) throw timeout()
    if (!snapshotPending(bridges, veths)) return { scope: 'confirmed', state: 'ready', bridgeCount: 1, vethCount: 3, pendingRounds, elapsedMs: Math.round(performance.now() - started) }
    pendingRounds++
    const delay = Math.min(Math.max(0, 50 - (performance.now() - roundStarted)), deadline - performance.now())
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw timeout()
}
