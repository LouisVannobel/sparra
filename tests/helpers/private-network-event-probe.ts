import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

type PrivateNetworkStage = 'fixture-create-start' | 'fixture-ready' | 'migration-done' | 'chromium-launch-start' | 'chromium-launch-done' | 'goto-start' | 'goto-done' | 'first-script-network-change'
type Outcome = 'signed-in' | 'native-failure' | 'setup-incomplete'
type Cleanup = 'not-spawned' | 'reaped' | 'unknown'
type Association = { name: string; master?: string; veth: boolean; active: boolean; generation: number }
type Event = { atMs: number; kind: 'link-new' | 'link-delete' | 'address-new' | 'address-delete' | 'route-new' | 'route-delete' | 'unknown';
  family: 'ipv4' | 'ipv6' | 'unknown'; tentative: boolean | null; linkState: 'up' | 'down' | 'unknown' | 'other' | null;
  name?: string; master?: string; veth: boolean; associated: boolean; beforeLaunch: boolean }
const stages: PrivateNetworkStage[] = ['fixture-create-start', 'fixture-ready', 'migration-done', 'chromium-launch-start', 'chromium-launch-done', 'goto-start', 'goto-done', 'first-script-network-change']

function nameHash(value: string | undefined) {
  // Only bounded hashes survive parsing; no interface names enter the report.
  return value && /^[a-zA-Z0-9_.-]{1,15}$/.test(value) ? createHash('sha256').update(value).digest('hex') : undefined
}
function identity(body: string) {
  const match = /^(\d+):\s+([^\s:]+)(?::\s|\s)/.exec(body)
  if (!match) return undefined
  const index = Number(match[1]), name = match[2].split('@')[0], hash = nameHash(name)
  return Number.isSafeInteger(index) && index > 0 && hash ? { index, name: hash, veth: name.startsWith('veth') } : undefined
}
function routeFamily(body: string): Event['family'] | undefined {
  const destination = body.replace(/^(?:unicast|local|broadcast|multicast|anycast|blackhole|unreachable|prohibit|throw|nat)\s+/, '').split(/\s/, 1)[0]
  if (destination === 'default') return 'unknown'
  const parts = destination.split('/'), family = isIP(parts[0])
  if (!family || parts.length > 2) return undefined
  if (parts[1] !== undefined && (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128))) return undefined
  return family === 4 ? 'ipv4' : 'ipv6'
}

class PrivateNetworkEventProbe {
  private readonly origin = performance.now()
  private readonly events: Event[] = []
  private readonly milestones: { stage: PrivateNetworkStage; atMs: number }[] = []
  private readonly associations = new Map<number, Association>()
  private readonly dropped = { rows: 0, lines: 0, associations: 0, bytes: 0 }
  private bridge?: string
  private child?: ChildProcess
  private watchdog?: ReturnType<typeof setTimeout>
  private closeWaiter?: () => void
  private closed = false
  private frozen = false
  private complete = true
  private observer: 'active' | 'unsupported' | 'unavailable' | 'early-exit' | 'timed-out' = 'active'
  private partial = Buffer.alloc(0)
  private discarding = false
  private inputBytes = 0
  private finished?: Promise<{ line: string; cleanup: Cleanup }>

  constructor(platform: NodeJS.Platform) {
    if (platform !== 'linux') { this.observer = 'unsupported'; this.complete = false; return }
    try {
      this.child = spawn('ip', ['-o', 'monitor', 'label', 'link', 'address', 'route'], {
        shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(typeof process.env.PATH === 'string' ? { PATH: process.env.PATH } : {}), LC_ALL: 'C' },
      })
      this.child.stdout?.on('data', this.consume); this.child.stderr?.on('data', this.stderr)
      this.child.stdout?.on('error', this.failed); this.child.stderr?.on('error', this.failed)
      this.child.on('error', this.failed); this.child.on('exit', this.exited); this.child.on('close', this.reaped)
      this.watchdog = setTimeout(() => {
        this.observer = 'timed-out'; this.complete = false; void this.finish('setup-incomplete')
      }, 120000)
    } catch { this.observer = 'unavailable'; this.complete = false }
  }
  private atMs() { return Math.max(0, Math.round((performance.now() - this.origin) * 1000) / 1000) }
  private drop(field: keyof typeof this.dropped, count = 1) {
    this.complete = false; this.dropped[field] = Math.min(255, this.dropped[field] + count)
  }
  mark(stage: PrivateNetworkStage) {
    if (this.frozen || !stages.includes(stage) || this.milestones.some(row => row.stage === stage)) return
    if (this.milestones.length < 12) this.milestones.push({ stage, atMs: this.atMs() })
  }
  ownNetwork(networkId: unknown) {
    if (this.frozen) return
    if (typeof networkId !== 'string' || !/^[0-9a-f]{64}$/.test(networkId)) { this.complete = false; return }
    const bridge = nameHash('br-' + networkId.slice(0, 12))
    if (this.bridge && this.bridge !== bridge) { this.complete = false; return }
    this.bridge = bridge
  }
  private base(): Event {
    return { atMs: this.atMs(), kind: 'unknown', family: 'unknown', tentative: null, linkState: null, veth: false, associated: false,
      beforeLaunch: !this.milestones.some(row => row.stage === 'chromium-launch-start') }
  }
  private link(body: string, deleted: boolean, event: Event) {
    const device = identity(body)
    if (!device || !/^\d+:\s+[^\s:]+:\s+</.test(body)) return false
    const master = nameHash(/\bmaster\s+(\S+)/.exec(body)?.[1]), state = /\bstate\s+(\S+)/.exec(body)?.[1]
    Object.assign(event, { kind: deleted ? 'link-delete' : 'link-new', name: device.name, master, veth: device.veth, associated: true,
      linkState: state === 'UP' ? 'up' : state === 'DOWN' ? 'down' : !state || state === 'UNKNOWN' ? 'unknown' : 'other' })
    const previous = this.associations.get(device.index)
    if (!previous && this.associations.size >= 64) { this.drop('associations'); return true }
    const generation = previous ? previous.generation + Number(!previous.active || previous.name !== device.name) : 0
    this.associations.set(device.index, { name: device.name, master, veth: device.veth, active: !deleted, generation })
    return true
  }
  private address(body: string, deleted: boolean, event: Event) {
    const device = identity(body), match = /^\d+:\s+\S+\s+(inet6|inet)\s+(\S+)/.exec(body)
    if (!device || !match || isIP(match[2].split('/')[0]) !== (match[1] === 'inet' ? 4 : 6)) return false
    const association = this.associations.get(device.index)
    const known = association?.active && association.name === device.name ? association : undefined
    Object.assign(event, { kind: deleted ? 'address-delete' : 'address-new', family: match[1] === 'inet' ? 'ipv4' : 'ipv6',
      tentative: /\btentative\b/.test(body), name: device.name, master: known?.master, veth: known?.veth ?? device.veth, associated: !!known })
    return true
  }
  private route(body: string, deleted: boolean, event: Event) {
    const family = routeFamily(body)
    if (!family) return false
    const devices = [...body.matchAll(/\bdev\s+(\S+)/g)]
    const name = devices.length === 1 ? nameHash(devices[0][1]) : undefined
    const matches = name ? [...this.associations.values()].filter(row => row.active && row.name === name) : []
    const known = matches.length === 1 ? matches[0] : undefined
    if (devices.length > 1 || matches.length > 1) this.complete = false
    Object.assign(event, { kind: deleted ? 'route-delete' : 'route-new', family, name, master: known?.master,
      veth: known?.veth ?? false, associated: !!known })
    return true
  }
  private line(line: string) {
    if (!line.trim()) return
    const match = /^\[(LINK|ADDR|ROUTE)\](Deleted\s+)?(.*)$/.exec(line), event = this.base()
    let parsed = false
    if (match?.[1] === 'LINK') parsed = this.link(match[3], !!match[2], event)
    if (match?.[1] === 'ADDR') parsed = this.address(match[3], !!match[2], event)
    if (match?.[1] === 'ROUTE') parsed = this.route(match[3], !!match[2], event)
    if (!parsed) this.complete = false
    if (this.events.length < 128) this.events.push(event)
    else this.drop('rows')
  }
  private budget(chunk: Buffer) {
    const length = Math.min(chunk.length, Math.max(0, 262144 - this.inputBytes))
    this.inputBytes += length
    if (length < chunk.length) this.drop('bytes', chunk.length - length)
    return chunk.subarray(0, length)
  }
  private segment(chunk: Buffer, start: number, end: number, newline: boolean) {
    if (!this.discarding && this.partial.length + end - start > 4096) {
      this.partial = Buffer.alloc(0); this.discarding = true; this.drop('lines')
    }
    if (!this.discarding) this.partial = Buffer.concat([this.partial, chunk.subarray(start, end)])
    if (!newline) return
    if (!this.discarding) this.line(this.partial.toString('utf8'))
    this.partial = Buffer.alloc(0); this.discarding = false
  }
  private consume = (input: Buffer) => {
    if (this.frozen) return // Keep draining the pipes during retirement.
    const chunk = this.budget(input)
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline
      this.segment(chunk, start, end, newline >= 0); start = end + 1
    }
  }
  private stderr = (chunk: Buffer) => {
    if (this.frozen || !chunk.length) return
    this.budget(chunk); this.failed()
  }
  private failed = () => { if (!this.frozen) { this.observer = 'unavailable'; this.complete = false } }
  private exited = () => { if (!this.frozen && this.observer === 'active') { this.observer = 'early-exit'; this.complete = false } }
  private reaped = () => {
    this.closed = true; this.exited(); clearTimeout(this.watchdog); this.closeWaiter?.()
    this.child?.stdout?.off('data', this.consume); this.child?.stderr?.off('data', this.stderr)
    this.child?.stdout?.off('error', this.failed); this.child?.stderr?.off('error', this.failed)
    this.child?.off('error', this.failed); this.child?.off('exit', this.exited); this.child?.off('close', this.reaped)
  }
  private waitForClose() {
    if (this.closed) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { this.closeWaiter = undefined; resolve(false) }, 500)
      this.closeWaiter = () => { clearTimeout(timer); this.closeWaiter = undefined; resolve(true) }
    })
  }
  private kill(signal: 'SIGTERM' | 'SIGKILL') { try { this.child?.kill(signal) } catch { /* Only close proves retirement. */ } }
  private async retire(): Promise<Cleanup> {
    if (!this.child) return 'not-spawned'
    if (!this.closed) {
      this.kill('SIGTERM')
      if (!await this.waitForClose()) { this.kill('SIGKILL'); await this.waitForClose() }
    }
    return this.closed ? this.child.pid ? 'reaped' : 'not-spawned' : 'unknown'
  }
  private membership(event: Event) {
    if (!this.bridge || !event.associated) return 'unknown'
    if (event.name === this.bridge) return 'owned-bridge'
    if (event.veth && event.master === this.bridge) return 'owned-veth'
    return event.master || !event.veth ? 'other' : 'unknown'
  }
  private result(outcome: Outcome, cleanup: Cleanup) {
    const launch = this.milestones.find(row => row.stage === 'chromium-launch-start')
    const scope = this.observer === 'active' && this.bridge && launch && this.events.some(row => row.kind === 'link-new' && row.name === this.bridge && row.associated && row.beforeLaunch) ? 'confirmed' : 'unknown'
    // Reconstruct every field; hashes, generations and raw parser input never
    // leave this helper. Times are receipt times, not kernel emission times.
    return { cleanup, line: 'PRIVATE_NETWORK_EVENT_TIMELINE ' + JSON.stringify({
      outcome: outcome === 'signed-in' || outcome === 'native-failure' ? outcome : 'setup-incomplete', scope,
      coverage: this.complete && cleanup !== 'unknown' ? 'complete' : 'incomplete', observer: this.observer, cleanup,
      milestones: this.milestones.map(row => ({ stage: row.stage, atMs: row.atMs })),
      events: this.events.map(row => ({ atMs: row.atMs, kind: row.kind, membership: this.membership(row), family: row.family, tentative: row.tentative, linkState: row.linkState })),
      dropped: { rows: this.dropped.rows, lines: this.dropped.lines, associations: this.dropped.associations, bytes: this.dropped.bytes },
    }) }
  }
  finish(outcome: Outcome) {
    if (this.finished) return this.finished
    this.frozen = true; clearTimeout(this.watchdog)
    if (this.partial.length) this.drop('lines')
    this.partial = Buffer.alloc(0)
    this.finished = this.retire().then(cleanup => this.result(outcome, cleanup), () => this.result(outcome, 'unknown'))
    return this.finished
  }
}

export function startPrivateNetworkEventProbe(platform: NodeJS.Platform = process.platform) {
  return new PrivateNetworkEventProbe(platform)
}
