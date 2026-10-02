import { loadMigrationCredential } from './migration-credentials.mjs'
try { await loadMigrationCredential() }
catch { process.stderr.write('Migration credential loading failed\n'); process.exit(1) }
try { await import('./migrate.ts') }
catch { process.stderr.write('Migration startup failed\n'); process.exitCode = 1 }
