import { Redacted, Schema } from 'effect'
import { ConfigurationError } from '../config.server.ts'

type Environment = Readonly<Record<string, string | undefined>>
const decimal = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))
const dsn = Schema.String.check(Schema.isPattern(/^postgres(?:ql)?:\/\/[^\s\\]+$/))

function url(env: Environment, key: string) {
  try {
    const value = Schema.decodeUnknownSync(dsn)(env[key])
    const parsed = new URL(value)
    if (!parsed.hostname || !parsed.username || !parsed.password || parsed.pathname.length < 2 || parsed.hash
      || [...parsed.searchParams].some(([name, value]) => name !== 'sslmode' || !['disable', 'verify-full'].includes(value))
      || parsed.searchParams.getAll('sslmode').length > 1) throw new Error()
    return Redacted.make(value)
  } catch { throw new ConfigurationError([key]) }
}

function integer(env: Environment, key: string, fallback: number, maximum = 30000) {
  try {
    const value = Schema.decodeUnknownSync(decimal)(env[key] ?? String(fallback))
    return Schema.decodeUnknownSync(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum })))(Number(value))
  } catch { throw new ConfigurationError([key]) }
}

export function readDatabaseConfig(env: Environment) {
  return Object.freeze({
    url: url(env, 'DATABASE_URL'),
    connectTimeoutMs: integer(env, 'DB_CONNECT_TIMEOUT_MS', 2000),
    statementTimeoutMs: integer(env, 'DB_STATEMENT_TIMEOUT_MS', 3000),
    cleanupTimeoutMs: integer(env, 'DB_CLEANUP_TIMEOUT_MS', 1000),
    max: integer(env, 'DB_POOL_MAX', 10, 100),
  })
}

export function readMigrationConfig(env: Environment) {
  return Object.freeze({
    url: url(env, 'MIGRATION_DATABASE_URL'),
    connectTimeoutMs: integer(env, 'DB_CONNECT_TIMEOUT_MS', 2000),
    statementTimeoutMs: integer(env, 'DB_STATEMENT_TIMEOUT_MS', 3000),
    cleanupTimeoutMs: integer(env, 'DB_CLEANUP_TIMEOUT_MS', 1000),
  })
}
