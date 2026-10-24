import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

export async function unusedLoopbackPort(): Promise<number> {
  const reservation = createServer()
  try {
    await bounded(new Promise<void>((ready, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', ready)
    }))
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address')
    return address.port
  } finally {
    await new Promise<void>((closed, reject) => reservation.close(error => error ? reject(error) : closed()))
  }
}

export async function unusedLoopbackPortPair(): Promise<readonly [number, number]> {
  const reservations = [createServer(), createServer()]
  try {
    // Keep both real binds alive until both addresses are known. Sequential
    // single-port selection can return the same released ephemeral port twice.
    const listening = await Promise.allSettled(reservations.map(reservation => bounded(new Promise<void>((ready, reject) => {
      reservation.once('error', reject); reservation.listen(0, '127.0.0.1', ready)
    }))))
    if (listening.some(result => result.status === 'rejected')) throw new Error('Loopback port pair unavailable')
    const first = reservations[0].address(), second = reservations[1].address()
    if (!first || typeof first === 'string' || !second || typeof second === 'string' || first.port === second.port)
      throw new Error('Expected distinct loopback TCP ports')
    return [first.port, second.port]
  } finally {
    const closed = await Promise.allSettled(reservations.filter(reservation => reservation.listening).map(reservation =>
      new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))))
    if (closed.some(result => result.status === 'rejected')) throw new Error('Loopback port reservations did not retire')
  }
}

export function startWeb(overrides: Record<string, string | undefined> = {}) {
  const entry = resolve('.output/server/index.mjs')
  if (!existsSync(entry)) throw new Error('Production web artifact missing: run pnpm build')
  // Deliberately allowlist OS essentials. No inherited providers, NODE_OPTIONS,
  // .env, CI/TEST, framework aliases or credentials enter the child.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    ProgramFiles: process.env.ProgramFiles,
    TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'production', APP_ORIGIN: 'https://template.example',
    HOST: '127.0.0.1', PORT: '0', REQUEST_TIMEOUT_MS: '1000',
    SHUTDOWN_TIMEOUT_MS: '1000', FIXTURE_STREAM_MS: '100', ...overrides,
  }
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/helpers/runtime-probe.mjs')).href, entry], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const startupEvidence = overrides.FIXTURE_STARTUP_EVIDENCE === 'yes' ? createWebStartupEvidence(child) : undefined
  let output = ''
  let listened = false
  let googleReady = false
  let googleClosed = false
  child.on('message', message => {
    startupEvidence?.receive(message)
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'google-ready') googleReady = true
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'google-closed' && 'evidence' in message) {
      const value = message.evidence
      googleClosed = typeof value === 'object' && value !== null && 'activeClientSockets' in value && value.activeClientSockets === 0 && 'activeRequests' in value && value.activeRequests === 0 && 'emergencyCleanup' in value && value.emergencyCleanup === false
    }
  })
  child.stdout?.on('data', data => { output += String(data) })
  child.stderr?.on('data', data => { output += String(data) })
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  const ready = new Promise<{ address: string; port: number }>((resolveReady, reject) => {
    child.on('message', message => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'listening' && 'address' in message) {
        startupEvidence?.listening(message)
        listened = true
        // SAFETY: The owned runtime probe sends Server.address() in this receipt; keep the original IPC readiness contract.
        resolveReady(message.address as { address: string; port: number })
      }
    })
    child.once('exit', () => reject(new Error(`Web exited before listen: ${output}`)))
  })
  // Invalid-config cases intentionally never await ready.
  void ready.catch(() => {})
  return {
    child, exit, ready, output: () => output, listened: () => listened, ...(startupEvidence ? { startupEvidence } : {}),
    async registerGoogle(url: string, subject: string, options?: import('./google-protocol-peer.mjs').GoogleFixtureOptions) {
      if (!googleReady) throw new Error('Google fixture protection not armed')
      const id = randomUUID()
      let listener: (message: unknown) => void = () => {}
      try {
        const receipt = new Promise<string>((resolve, reject) => {
          listener = message => {
            if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'google-registered' || !('id' in message) || message.id !== id) return
            if ('code' in message && typeof message.code === 'string') resolve(message.code)
            else reject(new Error('Google fixture registration failed'))
          }
          child.on('message', listener)
        })
        child.send({ type: 'google-register', id, url, subject, options })
        return await bounded(receipt)
      } finally { child.removeListener('message', listener) }
    },
    async googleEvidence() {
      const id = randomUUID()
      let listener: (message: unknown) => void = () => {}
      try {
        const receipt = new Promise<{ posts: number; tls: number; disallowed: number; activeClientSockets: number; activeRequests: number }>((resolve, reject) => {
          listener = message => {
            if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'google-evidence' || !('id' in message) || message.id !== id || !('evidence' in message)) return
            const value = message.evidence
            if (typeof value !== 'object' || value === null || !('posts' in value) || typeof value.posts !== 'number' || !('tls' in value) || typeof value.tls !== 'number'
              || !('disallowed' in value) || typeof value.disallowed !== 'number' || !('activeClientSockets' in value) || typeof value.activeClientSockets !== 'number' || !('activeRequests' in value) || typeof value.activeRequests !== 'number') { reject(new Error('Invalid Google fixture receipt')); return }
            resolve({ posts: value.posts, tls: value.tls, disallowed: value.disallowed, activeClientSockets: value.activeClientSockets, activeRequests: value.activeRequests })
          }
          child.on('message', listener)
        })
        child.send({ type: 'google-evidence', id })
        return await bounded(receipt)
      } finally { child.removeListener('message', listener) }
    },
    async shutdown() {
      const receipt = new Promise<number>((resolveReceipt) => {
        child.on('message', message => {
          if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown' && 'handlers' in message) resolveReceipt(Number(message.handlers))
        })
      })
      child.send('shutdown')
      return bounded(receipt)
    },
    async cleanup() {
      try {
        if (googleReady && child.exitCode === null && child.signalCode === null) {
          child.send('shutdown')
          await bounded(exit)
        }
        if (googleReady && (!googleClosed || child.exitCode !== 0)) throw new Error('Google child cleanup did not complete normally')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await bounded(exit)
      }
    },
  }
}

const startupStages = ['probe-entry', 'ssr-imported', 'start-imported'] as const
type StartupStage = typeof startupStages[number] | 'listening-sent' | 'listening-received'
type StartupListeningReceipt = { type: unknown; address: unknown; startupSentAtNs?: unknown }

function createWebStartupEvidence(child: ReturnType<typeof spawn>) {
  const started = process.hrtime.bigint()
  const stages: { stage: StartupStage; elapsedMs: number }[] = []
  let next = 0
  const record = (stage: StartupStage, at = process.hrtime.bigint()) => {
    const elapsedMs = Number((at - started) / 1_000_000n)
    if (at < started || !Number.isSafeInteger(elapsedMs)) return
    stages.push({ stage, elapsedMs })
  }
  return {
    receive(message: unknown) {
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'startup-evidence'
        || !('stage' in message) || Object.keys(message).length !== 2 || message.stage !== startupStages[next]) return
      record(startupStages[next])
      next++
    },
    listening(message: StartupListeningReceipt) {
      const received = process.hrtime.bigint()
      if ('startupSentAtNs' in message && typeof message.startupSentAtNs === 'string' && /^\d{1,20}$/.test(message.startupSentAtNs)) {
        const sent = BigInt(message.startupSentAtNs)
        if (sent >= started && sent <= received) record('listening-sent', sent)
      }
      record('listening-received', received)
    },
    snapshot(outcome: 'ready' | 'error') {
      return {
        outcome,
        stages: stages.map(event => ({ ...event })),
        exitCode: Number.isSafeInteger(child.exitCode) ? child.exitCode : null,
        signal: child.signalCode === null ? null : 'signaled',
      }
    },
  }
}

export async function awaitWebStartup(app: Pick<ReturnType<typeof startWeb>, 'ready' | 'startupEvidence'>) {
  try {
    const address = await bounded(app.ready)
    if (app.startupEvidence) console.info('WEB_STARTUP_EVIDENCE', app.startupEvidence.snapshot('ready'))
    return address
  } catch (error) {
    if (app.startupEvidence) console.info('WEB_STARTUP_EVIDENCE', app.startupEvidence.snapshot('error'))
    throw error
  }
}

export async function bounded<T>(promise: T | Promise<T>, ms = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned process operation exceeded its bound')), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

export async function probeRealStart(scenario: string) {
  const child = spawn(process.execPath, [resolve('tests/helpers/start-boundary-probe.mjs'), scenario], {
    windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'production', APP_ORIGIN: 'https://template.example',
      HOST: '127.0.0.1', PORT: '0', REQUEST_TIMEOUT_MS: '100', SHUTDOWN_TIMEOUT_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', data => { stdout += String(data) })
  child.stderr?.on('data', data => { stderr += String(data) })
  const exit = new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  })
  try {
    const code = await bounded(exit, 4000)
    return { code, stdout, stderr }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await bounded(exit)
  }
}
