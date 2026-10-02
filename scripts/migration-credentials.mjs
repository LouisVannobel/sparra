import { readFixedCredentialFile } from './fixed-credential-file.mjs'

export async function loadMigrationCredential() {
  const denied = new Set(['MIGRATION_DATABASE_URL', 'DATABASE_URL', 'REDIS_URL', 'RATE_LIMIT_HMAC_SECRET', 'AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SPARRA_AEAD_KEYRING_PATH',
    'TELNYX_API_KEY', 'OPENROUTER_API_KEY', 'DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'VOICE_DATABASE_URL', 'VOICE_DB_URL', 'VOICE_INGEST_DATABASE_URL', 'VOICE_CONTROL_DATABASE_URL', 'VOICE_RETENTION_DATABASE_URL',
    'VOICE_TELNYX_API_KEY', 'VOICE_TELNYX_PUBLIC_KEY', 'VOICE_OPENROUTER_API_KEY', 'VOICE_POSTGRES_DSN', 'VOICE_AEAD_KEYRING'])
  if (Object.keys(process.env).some(key => denied.has(key) || key.startsWith('AUTH_MAIL_') || key.startsWith('HATCHET_CLIENT_'))) throw new Error('Credential unavailable')
  const value = await readFixedCredentialFile('migration_database_url')
  if (!/^postgres(?:ql)?:\/\/[^\s\\]+$/.test(value)) throw new Error('Credential unavailable')
  const url = new URL(value)
  if (!url.hostname || !url.username || !url.password || url.pathname.length < 2 || url.hash
    || [...url.searchParams].some(([name, item]) => name !== 'sslmode' || !['disable', 'verify-full'].includes(item))
    || url.searchParams.getAll('sslmode').length > 1) throw new Error('Credential unavailable')
  process.env.MIGRATION_DATABASE_URL = value
}
