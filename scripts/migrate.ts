import { Client } from 'pg'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Redacted, Schema } from 'effect'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { readMigrationConfig } from '../src/platform/db/config.server.ts'
import { ConfigurationError } from '../src/platform/config.server.ts'
import { normalizeAuthEmail } from '../src/modules/auth/auth-email-normalization.server.ts'

// Explicit one-shot process: migration credentials never enter the web graph.
let commitAttempted = false
let committed = false
const retirementSchema = Schema.Struct({ schema_version: Schema.Literal(1),
  incarnation: Schema.String.check(Schema.isUUID()),
  container_id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  deployment_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  restart_policy: Schema.Literal('no'), container_state: Schema.Literal('removed'),
  proof_id: Schema.String.check(Schema.isUUID()),
  finished_at: Schema.String.check(Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{3}Z$/),
    Schema.makeFilter(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value)),
  exit_code: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0),Schema.isLessThanOrEqualTo(255)),
  exclusivity_reference: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)) })
async function readReaderRetirementProof() {
  const path='/run/sparra/audio-retirement-proof.json',before=await lstat(path)
  if(!before.isFile()||before.isSymbolicLink()||before.size>4096||before.mode&0o022||await realpath(path)!==path)throw new Error('Reader proof unavailable')
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{
    const opened=await file.stat(),buffer=Buffer.alloc(4097)
    if(opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('Reader proof unavailable')
    const {bytesRead}=await file.read(buffer,0,buffer.length,0)
    if(bytesRead!==before.size||bytesRead>4096)throw new Error('Reader proof unavailable')
    return Schema.decodeUnknownSync(retirementSchema,{onExcessProperty:'error'})(JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')))
  }finally{await file.close()}
}
try {
  const args=process.argv.slice(2)
  if(args.length>1||args.length===1&&args[0]!=='retire-audio-readers')throw new Error('Migration command unavailable')
  const retirement=args.length===1?await readReaderRetirementProof():null
  const config = readMigrationConfig(process.env)
  const migrations = retirement?[]:readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) })
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
    if(retirement){
      await client.query('SELECT public.sparra_audio_retire_readers_v1($1::uuid,$2::text,$3::text)',
        [retirement.incarnation,retirement.container_id,retirement.deployment_id])
    }else{
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
    }
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
  process.stdout.write(retirement?'Audio reader retirement applied\n':'Database migrations applied\n')
} catch (error) {
  process.stderr.write(error instanceof ConfigurationError ? `${error.message}\n` : committed ? 'Database migrations committed; cleanup failed\n'
    : commitAttempted ? 'Database migration failed; commit was not acknowledged\n' : 'Database migration failed\n')
  process.exitCode = 1
}
