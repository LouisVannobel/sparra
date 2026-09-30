import { Client } from 'pg'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Redacted } from 'effect'
import { fileURLToPath } from 'node:url'
import { readMigrationConfig } from '../src/platform/db/config.server.ts'
import { ConfigurationError } from '../src/platform/config.server.ts'
import { normalizeAuthEmail } from '../src/modules/auth/auth-email-normalization.server.ts'

// Explicit one-shot process: migration credentials never enter the web graph.
let commitAttempted = false
let committed = false
try {
  const config = readMigrationConfig(process.env)
  const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) })
  const client = new Client({
    connectionString: Redacted.value(config.url),
    connectionTimeoutMillis: config.connectTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs + config.cleanupTimeoutMs,
  })
  client.on('error', () => {})
  let transactionStarted = false
  async function assertCanonicalUsers() {
    await client.query('LOCK TABLE public."user" IN SHARE ROW EXCLUSIVE MODE')
    // This refuses an RLS-filtered scan; it does not bypass row security.
    await client.query('SET LOCAL row_security = off')
    const result = await client.query<{ email: unknown }>('SELECT email FROM public."user"')
    for (const row of result.rows) if (normalizeAuthEmail(row.email) !== row.email) throw new Error('Noncanonical stored User email')
  }
  try {
    await client.connect()
    const version = await client.query("SELECT current_setting('server_version_num') AS version")
    if (version.rows[0]?.version !== '160015') throw new Error('Unsupported database')
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    transactionStarted = true
    // Drizzle0.45.2-compatible journal and public reader; this CLI alone owns
    // the transaction so its exact JS preflight shares the final commit.
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
    await client.query('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)')
    await client.query('LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE')
    const latest = (await client.query<{ created_at: string }>('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0]
    const existingUser = (await client.query<{ present: boolean }>(`SELECT to_regclass('public."user"') IS NOT NULL AS present`)).rows[0].present
    if (existingUser) await assertCanonicalUsers()
    for (const migration of migrations) {
      if (!latest || Number(latest.created_at) < migration.folderMillis) {
        for (const statement of migration.sql) await client.query(statement)
        await client.query('INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES($1,$2)', [migration.hash, migration.folderMillis])
      }
    }
    // Initial absence is not validation. Fresh schema/data/journal are still
    // provisional here; the fixed User relation must exist and pass the scan.
    if (!existingUser) await assertCanonicalUsers()
    commitAttempted = true
    const result = await client.query('COMMIT')
    if (result.command !== 'COMMIT') throw new Error('Migration commit was not acknowledged')
    committed = true
  } finally {
    // One cleanup budget covers rollback AND shutdown. No uncertain COMMIT is
    // retried or described as a rollback; only this owned transport is closed.
    const timer = setTimeout(() => client.connection.stream.destroy(), config.cleanupTimeoutMs)
    try {
      if (commitAttempted && !committed) client.connection.stream.destroy()
      try { if (transactionStarted && !commitAttempted) await client.query('ROLLBACK') }
      finally { await client.end() }
    } finally { clearTimeout(timer) }
  }
  process.stdout.write('Database migrations applied\n')
} catch (error) {
  process.stderr.write(error instanceof ConfigurationError ? `${error.message}\n` : committed ? 'Database migrations committed; cleanup failed\n'
    : commitAttempted ? 'Database migration failed; commit was not acknowledged\n' : 'Database migration failed\n')
  process.exitCode = 1
}
