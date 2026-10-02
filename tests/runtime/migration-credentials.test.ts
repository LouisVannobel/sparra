import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ value: 'postgresql://synthetic:synthetic@pg:5432/auth', reads: 0 }))
vi.mock('../../scripts/fixed-credential-file.mjs', () => ({ readFixedCredentialFile: async () => { state.reads++; return state.value } }))
beforeEach(()=>{vi.stubEnv('MIGRATION_DATABASE_URL',undefined)})
afterEach(() => { vi.unstubAllEnvs(); state.reads = 0 })
test.each(['MIGRATION_DATABASE_URL', 'DATABASE_URL', 'REDIS_URL', 'RATE_LIMIT_HMAC_SECRET', 'AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SPARRA_AEAD_KEYRING_PATH', 'AUTH_MAIL_KEY_ID', 'HATCHET_CLIENT_TOKEN', 'TELNYX_API_KEY', 'VOICE_DATABASE_URL', 'VOICE_TELNYX_API_KEY', 'VOICE_OPENROUTER_API_KEY', 'VOICE_POSTGRES_DSN'])('web_and_migration_scopes_are_disjoint: %s', async key => {
  vi.stubEnv(key, '')
  const { loadMigrationCredential } = await import('../../scripts/migration-credentials.mjs')
  await expect(loadMigrationCredential()).rejects.toThrow(); expect(state.reads).toBe(0)
})
test('single_migration_file_assigns_only_native_key', async () => {
  vi.stubEnv('MIGRATION_DATABASE_URL', undefined)
  const { loadMigrationCredential } = await import('../../scripts/migration-credentials.mjs')
  await loadMigrationCredential(); expect(process.env.MIGRATION_DATABASE_URL).toBe(state.value)
  expect(process.env.DATABASE_URL).toBeUndefined()
})
