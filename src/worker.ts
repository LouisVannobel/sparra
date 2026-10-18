import { fileURLToPath } from 'node:url'
import { createMailWorkerResources } from './platform/mail-runtime.server'

let resources: ReturnType<typeof createMailWorkerResources> | undefined
let stop!: () => void
let shutdownRequested = false
const stopped = new Promise<void>(resolve => { stop = resolve })
const shutdown = () => { shutdownRequested = true; stop(); void resources?.dispose().catch(() => {}) }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
try {
  resources = createMailWorkerResources(process.env, fileURLToPath(new URL('./hatchet-empty.yaml', import.meta.url)), event => process.stdout.write(`Application worker lifecycle ${event}\n`))
  const ready = await resources.ready()
  process.stdout.write('Application worker ready\n')
  const reason = await Promise.race([stopped.then(() => 'shutdown'), ready.failure.then(() => 'failure')])
  if (reason === 'failure') process.exitCode = 1
} catch { if (!shutdownRequested) { process.stderr.write('Application worker unavailable\n'); process.exitCode = 1 } }
finally {
  try {
    if (resources) {
      try {
        await resources.dispose()
        if (resources.hasFailed()) process.exitCode = 1
        process.stdout.write('Application worker stopped\n')
      } catch {
        process.exitCode = 1
        process.stderr.write('Application worker cleanup unavailable\n')
      }
    }
  } finally {
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown)
  }
}
