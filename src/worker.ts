import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createMailWorkerResources } from './platform/mail-runtime.server'
import { createCalendarWorkerResources } from './platform/calendar-runtime.server'

type OwnedWorker = { dispose(): Promise<void>; hasFailed(): boolean }
const resources: OwnedWorker[] = []
let stop!: () => void,
  shutdownRequested = false,
  workerReady = false
const stopped = new Promise<void>((resolve) => {
  stop = resolve
})
const shutdown = () => {
  shutdownRequested = true
  stop()
  for (const resource of resources) void resource.dispose().catch(() => {})
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
try {
  const [mail, calendar] = await Promise.allSettled([
    Promise.resolve().then(async () => {
      const resource = createMailWorkerResources(
        process.env,
        join(dirname(fileURLToPath(import.meta.url)), 'hatchet-empty.yaml'),
        (event) => process.stdout.write(`Application worker lifecycle ${event}\n`),
      )
      resources.push(resource)
      if (shutdownRequested) await resource.dispose()
      return resource.ready()
    }),
    Promise.resolve().then(async () => {
      const resource = createCalendarWorkerResources(process.env)
      resources.push(resource)
      if (shutdownRequested) await resource.dispose()
      return resource.ready()
    }),
  ])
  const failures: Promise<void>[] = []
  if (mail.status === 'fulfilled') {
    workerReady = true
    failures.push(mail.value.failure)
    process.stdout.write('Application worker ready\n')
  } else if (!shutdownRequested) {
    process.exitCode = 1
    process.stderr.write('Application worker unavailable\n')
  }
  if (calendar.status === 'fulfilled' && calendar.value.enabled) {
    workerReady = true
    failures.push(calendar.value.failure)
    process.stdout.write('Calendar worker ready\n')
  } else if (calendar.status === 'rejected' && !shutdownRequested) {
    process.exitCode = 1
    process.stderr.write('Calendar worker unavailable\n')
  }
  if (failures.length) {
    const reason = await Promise.race([
      stopped.then(() => 'shutdown'),
      ...failures.map((failure) => failure.then(() => 'failure')),
    ])
    if (reason === 'failure') process.exitCode = 1
  }
} catch {
  if (!shutdownRequested) {
    process.stderr.write('Application worker unavailable\n')
    process.exitCode = 1
  }
} finally {
  try {
    const outcomes = await Promise.allSettled(resources.map((resource) => resource.dispose()))
    if (resources.some((resource) => resource.hasFailed())) process.exitCode = 1
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      process.exitCode = 1
      process.stderr.write('Application worker cleanup unavailable\n')
    } else if (workerReady) process.stdout.write('Application worker stopped\n')
  } finally {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }
}
