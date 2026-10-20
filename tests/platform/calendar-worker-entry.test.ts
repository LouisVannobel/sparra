import { expect, test, vi } from 'vitest'
const events = vi.hoisted((): string[] => [])
const state = vi.hoisted(() => ({ mailFails: true, shutdownFailure: false }))
vi.mock('../../src/platform/mail-runtime.server', () => ({
  createMailWorkerResources: () => ({
    async ready() {
      events.push('mail-start')
      if (state.mailFails) throw new Error('Private Hatchet failure')
      return { failure: new Promise<void>(() => {}) }
    },
    async dispose() {
      events.push('mail-stop')
    },
    hasFailed: () => state.mailFails,
  }),
}))
vi.mock('../../src/platform/calendar-runtime.server', () => ({
  createCalendarWorkerResources: () => ({
    async ready() {
      events.push('calendar-start')
      if (state.shutdownFailure) {
        process.emit('SIGTERM')
        return { enabled: true, failure: new Promise<void>(() => {}), isReady: () => true }
      }
      return { enabled: true, failure: Promise.resolve(), isReady: () => true }
    },
    async dispose() {
      events.push('calendar-stop')
      if (state.shutdownFailure) throw new Error('Private transport cleanup failed')
    },
    hasFailed: () => true,
  }),
}))
test('Calendar starts and joins independently when Hatchet initialization fails', async () => {
  const previous = process.exitCode,
    output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await import('../../src/worker')
    expect(events).toContain('calendar-start')
    expect(events).toContain('calendar-stop')
    expect(events).toContain('mail-stop')
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = previous
    output.mockRestore()
    error.mockRestore()
  }
})

test('a Calendar cleanup rejection during requested shutdown cannot produce a clean entry result', async () => {
  vi.resetModules()
  events.length = 0
  state.mailFails = false
  state.shutdownFailure = true
  const previous = process.exitCode
  let stdout = '',
    stderr = ''
  const output = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    stdout += String(value)
    return true
  })
  const error = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    stderr += String(value)
    return true
  })
  try {
    process.exitCode = undefined
    await import('../../src/worker')
    expect(process.exitCode).toBe(1)
    expect(events).toContain('mail-stop')
    expect(events).toContain('calendar-stop')
    expect(stdout).not.toContain('Application worker stopped')
    expect(stderr).toBe('Application worker cleanup unavailable\n')
    expect(stdout + stderr).not.toContain('Private transport')
  } finally {
    process.exitCode = previous
    state.mailFails = true
    state.shutdownFailure = false
    output.mockRestore()
    error.mockRestore()
  }
})
