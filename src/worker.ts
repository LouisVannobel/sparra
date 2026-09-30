import { fileURLToPath } from 'node:url'
import { createMailWorkerResources } from './platform/mail-runtime.server'

let resources: ReturnType<typeof createMailWorkerResources> | undefined
let stop!: () => void
let shutdownRequested = false
const stopped = new Promise<void>(resolve => { stop = resolve })
const shutdown = () => { shutdownRequested = true; stop(); void resources?.dispose().catch(() => {}) }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
try {
  resources = createMailWorkerResources(process.env, fileURLToPath(new URL('./hatchet-empty.yaml', import.meta.url)), event => process.stdout.write(`Auth mail lifecycle ${event}\n`))
  const ready = await resources.ready()
  process.stdout.write('Auth mail worker ready\n')
  const reason = await Promise.race([stopped.then(() => 'shutdown'), ready.failure.then(() => 'failure')])
  if (reason === 'failure') process.exitCode = 1
} catch { if (!shutdownRequested) { process.stderr.write('Auth mail worker unavailable\n'); process.exitCode = 1 } }
finally {
  if (resources) {
    await resources.dispose()
    if (resources.hasFailed()) process.exitCode = 1
    process.stdout.write('Auth mail worker stopped\n')
  }
  process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown)
}
