import { loadWebCredentials } from './web-credentials.mjs'
try { await loadWebCredentials() }
catch { process.stderr.write('Web credential loading failed\n'); process.exit(1) }
try { await import('../.output/server/index.mjs') }
catch { process.stderr.write('Web startup failed\n'); process.exitCode = 1 }
