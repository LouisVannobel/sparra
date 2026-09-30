import { expect, test, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ failed: true, disposed: 0 }))
vi.mock('../../src/platform/mail-runtime.server', () => ({ createMailWorkerResources: () => ({
  async ready() {
    // Shutdown wins the race, but the native failure remains latched until join.
    process.emit('SIGTERM')
    return { failure: Promise.resolve() }
  },
  async dispose() { lifecycle.disposed++ },
  hasFailed: () => lifecycle.failed,
}) }))

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
