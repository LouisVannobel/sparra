import { afterEach, describe, expect, test, vi } from 'vitest'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startWeb, bounded, awaitWebStartup } from '../helpers/web-process'

const sourceProbe = resolve('tests/helpers/runtime-probe.mjs')
const originalCwd = process.cwd()
let fixtureDirectory: string | undefined
let ownedApp: ReturnType<typeof startWeb> | undefined

async function fixture(mode: 'listen' | 'phase-only' | 'exit' | 'silent-exit', evidence: boolean) {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'web-startup-evidence-'))
  const server = join(fixtureDirectory, '.output/server')
  await mkdir(join(server, '_ssr'), { recursive: true })
  await mkdir(join(fixtureDirectory, 'tests/helpers'), { recursive: true })
  await copyFile(sourceProbe, join(fixtureDirectory, 'tests/helpers/runtime-probe.mjs'))
  await writeFile(join(server, '_ssr/ssr.mjs'), 'export const createMiddleware = () => ({server: handler => handler})\n')
  await writeFile(join(server, '_ssr/start-fixture.mjs'), 'export const startInstance = {getOptions: async () => ({})}\n')
  await writeFile(join(server, 'index.mjs'), `
    import { createServer } from 'node:http'
    if (process.env.FIXTURE_STARTUP_MODE === 'phase-only') {
      process.send?.({ type: 'startup-evidence', stage: 'listening', secret: 'SECRET_SENTINEL' })
      process.send?.({ type: 'startup-evidence', stage: 'ssr-imported', secret: 'SECRET_SENTINEL' })
      setInterval(() => {}, 1000)
    } else if (process.env.FIXTURE_STARTUP_MODE === 'exit') {
      process.send?.({ type: 'startup-evidence', stage: 'listening', secret: 'SECRET_SENTINEL' })
      setImmediate(() => process.exit(7))
    } else if (process.env.FIXTURE_STARTUP_MODE === 'silent-exit') {
      setImmediate(() => process.exit(7))
    } else {
      const server = createServer((_request, response) => response.end('ok'))
      server.listen(0, '127.0.0.1')
      process.on('SIGTERM', () => server.close(() => process.exit(0)))
    }
  `)
  process.chdir(fixtureDirectory)
  ownedApp = startWeb({ FIXTURE_STARTUP_MODE: mode, ...(evidence ? { FIXTURE_STARTUP_EVIDENCE: 'yes' } : {}) })
  return ownedApp
}

afterEach(async () => {
  vi.useRealTimers()
  try {
    if (ownedApp) {
      await ownedApp.cleanup()
      expect(ownedApp.child.exitCode !== null || ownedApp.child.signalCode !== null).toBe(true)
    }
  } finally {
    ownedApp = undefined
    process.chdir(originalCwd)
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
    fixtureDirectory = undefined
    vi.restoreAllMocks()
  }
})

async function waitForSyntheticListeningMarker(app: ReturnType<typeof startWeb>) {
  let onMessage: (message: unknown) => void = () => {}
  let onExit: () => void = () => {}
  let onError: () => void = () => {}
  const receipt = new Promise<void>((resolve, reject) => {
    onMessage = message => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'startup-evidence'
        && 'stage' in message && message.stage === 'listening') resolve()
    }
    onExit = () => reject(new Error('Web exited before synthetic listening marker'))
    onError = () => reject(new Error('Web child failed before synthetic listening marker'))
    app.child.on('message', onMessage)
    app.child.once('exit', onExit)
    app.child.once('error', onError)
    if (app.child.exitCode !== null || app.child.signalCode !== null) onExit()
  })
  try { await bounded(receipt) }
  finally {
    app.child.removeListener('message', onMessage)
    app.child.removeListener('exit', onExit)
    app.child.removeListener('error', onError)
  }
}

describe.sequential('owned web startup evidence', () => {
  test('opt-in reports only fixed phases and safe fields after a real listening receipt', async () => {
    const app = await fixture('listen', true)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      expect((await awaitWebStartup(app)).port).toBeGreaterThan(0)
      expect(log).toHaveBeenCalledTimes(1)
      const [label, evidence] = log.mock.calls[0]
      expect(label).toBe('WEB_STARTUP_EVIDENCE')
      expect(evidence).toMatchObject({ outcome: 'ready', exitCode: null, signal: null })
      expect(evidence.stages.map((event: { stage: string }) => event.stage)).toEqual([
        'probe-entry', 'ssr-imported', 'start-imported', 'listening-sent', 'listening-received',
      ])
      expect(evidence.stages.every((event: { elapsedMs: number }) => Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0)).toBe(true)
      expect(JSON.stringify(evidence)).not.toContain('SECRET_SENTINEL')
      expect(Object.keys(evidence).sort()).toEqual(['exitCode', 'outcome', 'signal', 'stages'])
      await app.shutdown()
      expect(await bounded(app.exit)).toBe(0)
    } finally { await app.cleanup() }
  })

  test('no opt-in leaves other web consumers without startup evidence', async () => {
    const app = await fixture('listen', false)
    try {
      expect((await bounded(app.ready)).port).toBeGreaterThan(0)
      expect(app.startupEvidence).toBeUndefined()
    } finally { await app.cleanup() }
  })

  test('a listening-like or malformed phase cannot satisfy ready and never enters safe evidence', async () => {
    const app = await fixture('phase-only', true)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const messageListeners = app.child.listenerCount('message')
      await waitForSyntheticListeningMarker(app)
      expect(app.child.listenerCount('message')).toBe(messageListeners)
      vi.useFakeTimers()
      const waiting = awaitWebStartup(app)
      const rejected = expect(waiting).rejects.toThrow('Owned process operation exceeded its bound')
      expect(app.listened()).toBe(false)
      await vi.advanceTimersByTimeAsync(5999)
      expect(log).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(log).toHaveBeenCalledTimes(1)
      const evidence = log.mock.calls[0][1]
      expect(evidence).toMatchObject({ outcome: 'error' })
      expect(JSON.stringify(evidence)).not.toContain('SECRET_SENTINEL')
      expect(evidence.stages.map((event: { stage: string }) => event.stage)).not.toContain('listening')
      expect(evidence.stages.map((event: { stage: string }) => event.stage)).not.toContain('listening-received')
    } finally { vi.useRealTimers(); await app.cleanup() }
  })

  test('an early child exit retains the original rejection and records safe exit state', async () => {
    const app = await fixture('exit', true)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      await expect(awaitWebStartup(app)).rejects.toThrow('Web exited before listen:')
      expect(log.mock.calls[0][1]).toMatchObject({ outcome: 'error', exitCode: 7, signal: null })
    } finally { await app.cleanup() }
  })

  test('a missing synthetic marker rejects on child exit and joins the owned child', async () => {
    const app = await fixture('silent-exit', true)
    const messageListeners = app.child.listenerCount('message')
    const errorListeners = app.child.listenerCount('error')
    await expect(waitForSyntheticListeningMarker(app)).rejects.toThrow('Web exited before synthetic listening marker')
    expect(await bounded(app.exit)).toBe(7)
    expect(app.child.listenerCount('message')).toBe(messageListeners)
    expect(app.child.listenerCount('exit')).toBe(0)
    expect(app.child.listenerCount('error')).toBe(errorListeners)
  })

  test('the existing default bound still rejects at 6000 ms', async () => {
    vi.useFakeTimers()
    const waiting = bounded(new Promise<never>(() => {}))
    await vi.advanceTimersByTimeAsync(5999)
    let settled = false
    void waiting.catch(() => { settled = true })
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).rejects.toThrow('Owned process operation exceeded its bound')
  })
})
