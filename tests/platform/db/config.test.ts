import { expect, test } from 'vitest'
import { Redacted } from 'effect'
import { spawnSync } from 'node:child_process'
import { readDatabaseConfig, readMigrationConfig } from '../../../src/platform/db/config.server'

const runtime = { DATABASE_URL: 'postgresql://runtime:private-dsn-marker@127.0.0.1:6432/auth' }

test('runtime config needs only its runtime credentials and bounded positive deadlines', () => {
  const config = readDatabaseConfig(runtime)
  expect(Redacted.value(config.url)).toBe(runtime.DATABASE_URL)
  expect(config.connectTimeoutMs).toBeGreaterThan(0)
  expect(config.statementTimeoutMs).toBeGreaterThan(0)
  expect(config.cleanupTimeoutMs).toBeGreaterThan(0)
  expect(JSON.stringify(config)).not.toContain('private-dsn-marker')
})

test.each([undefined, '', 'private-dsn-marker', 'https://private-dsn-marker',
  'postgresql://user:private-dsn-marker@127.0.0.1/db#fragment',
  'postgresql://user:private-dsn-marker@127.0.0.1/db?options=-c%20role%3Dadmin',
])('rejects invalid runtime DSN without retaining its cause (%s)', value => {
  try { readDatabaseConfig({ DATABASE_URL: value }); expect.fail('accepted invalid DSN') }
  catch (error) {
    expect(error).toMatchObject({ name: 'ConfigurationError', invalidKeys: ['DATABASE_URL'] })
    expect(String(error)).not.toContain('private-dsn-marker')
    expect(error).not.toHaveProperty('cause')
  }
})

test.each(['DB_CONNECT_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS', 'DB_CLEANUP_TIMEOUT_MS', 'DB_POOL_MAX'])(
  'rejects invalid %s', key => {
    for (const value of ['0', '-1', 'NaN', '1.5', 'Infinity', '01', '999999999']) {
      expect(() => readDatabaseConfig({ ...runtime, [key]: value })).toThrow(key)
    }
  },
)

test('the one-shot migration requires its own direct DSN and ignores web credentials', () => {
  expect(() => readMigrationConfig(runtime)).toThrow('MIGRATION_DATABASE_URL')
  const config = readMigrationConfig({ MIGRATION_DATABASE_URL: runtime.DATABASE_URL })
  expect(Redacted.value(config.url)).toBe(runtime.DATABASE_URL)
  expect(JSON.stringify(config)).not.toContain('private-dsn-marker')
})

test('the actual one-shot command rejects missing/invalid direct DSN with only safe key names', () => {
  for (const value of [undefined, 'private-migration-marker']) {
    const child = spawnSync(process.execPath, ['scripts/migrate.ts'], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MIGRATION_DATABASE_URL: value },
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain('MIGRATION_DATABASE_URL')
    expect(child.stderr).not.toContain('private-migration-marker')
  }
})
