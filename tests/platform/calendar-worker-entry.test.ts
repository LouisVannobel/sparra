import { expect, test, vi } from 'vitest'
const events = vi.hoisted((): string[] => [])
vi.mock('../../src/platform/mail-runtime.server', () => ({
  createMailWorkerResources: () => ({
    async ready() {
      events.push('mail-start')
      throw new Error('Private Hatchet failure')
    },
    async dispose() {
      events.push('mail-stop')
    },
    hasFailed: () => true,
  }),
}))
vi.mock('../../src/platform/calendar-runtime.server', () => ({
  createCalendarWorkerResources: () => ({
    async ready() {
      events.push('calendar-start')
      return { enabled: true, failure: Promise.resolve(), isReady: () => true }
    },
    async dispose() {
      events.push('calendar-stop')
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
