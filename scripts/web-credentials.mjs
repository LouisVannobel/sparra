import { readFixedCredentialFile } from './fixed-credential-file.mjs'

const inputs = [['DATABASE_URL', 'app_database_url'], ['REDIS_URL', 'app_redis_url'], ['RATE_LIMIT_HMAC_SECRET', 'app_rate_limit_hmac_secret'],
  ['AUTH_SECRET', 'app_auth_secret'], ['GOOGLE_CLIENT_ID', 'app_google_client_id'], ['GOOGLE_CLIENT_SECRET', 'app_google_client_secret']]
function validatePostgresCredential(value) {
  if (!/^postgres(?:ql)?:\/\/[^\s\\]+$/.test(value)) throw new Error('Credential unavailable')
  const url = new URL(value)
  if (!url.hostname || !url.username || !url.password || url.pathname.length < 2 || url.hash
    || [...url.searchParams].some(([name, item]) => name !== 'sslmode' || !['disable', 'verify-full'].includes(item))
    || url.searchParams.getAll('sslmode').length > 1) throw new Error('Credential unavailable')
}
export async function loadWebCredentials() {
  if (inputs.some(([key]) => Object.hasOwn(process.env, key)) || Object.keys(process.env).some(key => key === 'MIGRATION_DATABASE_URL' || key.startsWith('AUTH_MAIL_') || key.startsWith('HATCHET_CLIENT_'))) throw new Error('Credential unavailable')
  const values = []
  for (const [key, file] of inputs) {
    const value = await readFixedCredentialFile(file)
    if (key === 'DATABASE_URL') validatePostgresCredential(value)
    if (key === 'REDIS_URL') {
      const url = new URL(value)
      if (!/^rediss?:\/\/[^\s\\]+$/.test(value) || !url.hostname || !url.password || !['', '/', '/0'].includes(url.pathname) || url.search || url.hash) throw new Error('Credential unavailable')
    }
    if (['RATE_LIMIT_HMAC_SECRET', 'AUTH_SECRET'].includes(key) && value.length < 32) throw new Error('Credential unavailable')
    values.push([key, value])
  }
  for (const [key, value] of values) process.env[key] = value
}
