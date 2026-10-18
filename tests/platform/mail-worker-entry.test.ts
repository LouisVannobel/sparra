import { beforeEach, expect, test, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ failed: true, disposed: 0, rejectDispose: false }))
vi.mock('../../src/platform/mail-runtime.server', () => ({ createMailWorkerResources: () => ({
  async ready() {
    // Shutdown wins the race, but the native failure remains latched until join.
    process.emit('SIGTERM')
    return { failure: Promise.resolve() }
  },
  async dispose() {
    lifecycle.disposed++
    if (lifecycle.rejectDispose) throw Object.assign(new Error('private-cleanup-sentinel'), {
      config: { headers: { Authorization: 'Bearer private-cleanup-sentinel' } },
    })
  },
  hasFailed: () => lifecycle.failed,
}) }))

beforeEach(() => {
  vi.resetModules()
  lifecycle.failed = true; lifecycle.disposed = 0; lifecycle.rejectDispose = false
})

test('entrypoint does not accept exit zero for ordinary native failure racing requested shutdown', async () => {
  const previous = process.exitCode
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    process.exitCode = undefined
    await import('../../src/worker')
    expect(process.exitCode).toBe(1)
    expect(lifecycle.disposed).toBeGreaterThan(0)
  } finally { process.exitCode = previous; output.mockRestore() }
})

test('entrypoint reports only constant cleanup failure after requested shutdown and removes its listeners', async () => {
  const previous = process.exitCode
  const before = { SIGINT: process.rawListeners('SIGINT'), SIGTERM: process.rawListeners('SIGTERM') }
  let stdout = '', stderr = ''
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  lifecycle.failed = false; lifecycle.rejectDispose = true
  try {
    process.exitCode = undefined
    const imported = await import('../../src/worker').then(() => 'fulfilled', () => 'rejected')
    expect(imported).toBe('fulfilled')
    expect(process.exitCode).toBe(1)
    expect(stderr).toBe('Application worker cleanup unavailable\n')
    expect(stdout.includes('Application worker stopped')).toBe(false)
    expect((stdout + stderr).includes('private-cleanup-sentinel')).toBe(false)
    expect(process.rawListeners('SIGINT')).toEqual(before.SIGINT)
    expect(process.rawListeners('SIGTERM')).toEqual(before.SIGTERM)
  } finally {
    // A RED must not leave this import's once-listener in the shared test process.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.rawListeners(signal)) if (!before[signal].includes(listener)) process.removeListener(signal, listener)
    }
    process.exitCode = previous; output.mockRestore(); error.mockRestore()
  }
})
