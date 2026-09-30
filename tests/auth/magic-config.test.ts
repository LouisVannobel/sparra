import { randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import { readAuthConfig } from '../../src/modules/auth/auth.server'
import { readAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { validateMagicConsume } from '../../src/modules/auth/magic.server'
import { readMailWorkerConfig } from '../../src/platform/mail-runtime.server'

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
const env = () => ({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'), AUTH_MAIL_KEY_ID: 'fixture',
  AUTH_MAIL_KEYS_JSON: JSON.stringify({ fixture: randomBytes(32).toString('base64') }), AUTH_MAIL_PROFILE_JSON: JSON.stringify(profile) })
test('magic config enables a concrete web producer with no Google or worker credentials', () => {
  const config = readAuthConfig(env())
  expect(config?.google === null && !!config.magic).toBe(true)
  expect(config?.magic?.profile.appOrigin === origin).toBe(true)
})
test.each(['AUTH_SECRET', 'AUTH_MAIL_KEY_ID', 'AUTH_MAIL_KEYS_JSON', 'AUTH_MAIL_PROFILE_JSON'] as const)('partial magic configuration missing %s fails safely', key => {
  const value: Record<string, string | undefined> = env(); delete value[key]
  expect(() => readAuthConfig(value)).toThrow(/Invalid configuration keys:/)
})
test.each(['http://localhost:3000', 'https://other.example.test'])('magic profile rejects unqualified or mismatched application origin %s', appOrigin => {
  expect(() => readAuthConfig({ ...env(), AUTH_MAIL_PROFILE_JSON: JSON.stringify({ ...profile, appOrigin }) })).toThrow(/Invalid configuration keys:/)
})
test('shared key parser is a real compatible AEAD encoder/decoder and rejects missing current key', () => {
  const keys = { fixture: randomBytes(32).toString('base64') }
  const values = { AUTH_MAIL_KEY_ID: 'fixture', AUTH_MAIL_KEYS_JSON: JSON.stringify(keys) }
  const producer = readAuthEmailEnvelope(values), consumer = readAuthEmailEnvelope(values)
  const now = new Date(), binding = { deliveryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', purpose: 'magic-link' as const, generation: 1, expiresAt: new Date(now.getTime() + 60000) }
  const sealed = producer.seal(Buffer.from('owned fixture'), binding, now)
  const plaintext = consumer.open(sealed, binding, now)
  try { expect(plaintext.toString() === 'owned fixture').toBe(true) } finally { plaintext.fill(0) }
  expect(() => readAuthEmailEnvelope({ ...values, AUTH_MAIL_KEY_ID: 'missing' })).toThrow('Auth email envelope rejected')
})
test('web and worker configuration consume the same envelope parser without constructing worker resources', () => {
  const value = { ...env(), NODE_ENV: 'test', AUTH_MAIL_PROJECT_ID: 'fixture', AUTH_MAIL_CREDENTIAL_ID: 'fixture',
    AUTH_MAIL_API_ORIGIN: profile.apiOrigin, AUTH_MAIL_PLUNK_SECRET: 'sk_synthetic', HATCHET_CLIENT_TOKEN: 'synthetic',
    HATCHET_CLIENT_HOST_PORT: '127.0.0.1:1', HATCHET_CLIENT_API_URL: 'http://127.0.0.1:1', HATCHET_CLIENT_TLS_STRATEGY: 'none',
    AUTH_MAIL_RELAY_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/fixture', AUTH_MAIL_WORKER_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/fixture' }
  const producer = readAuthConfig(value)!.magic!.envelope, consumer = readMailWorkerConfig(value).envelope
  const now = new Date(), binding = { deliveryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', purpose: 'magic-link' as const, generation: 1, expiresAt: new Date(now.getTime() + 60000) }
  const plaintext = consumer.open(producer.seal(Buffer.from('config fixture'), binding, now), binding, now)
  try { expect(plaintext.toString() === 'config fixture').toBe(true) } finally { plaintext.fill(0) }
  const malformed = { ...value, AUTH_MAIL_KEYS_JSON: '{malformed' }
  expect(() => readAuthConfig(malformed)).toThrow(/Invalid configuration keys:/)
  expect(() => readMailWorkerConfig(malformed)).toThrow('Auth mail worker configuration rejected')
})
test('magic token validation rejects padding, incorrect byte length and noncanonical final bits', () => {
  for (const token of ['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(43) + '=', 'A'.repeat(42) + 'B', '+'.repeat(43), '/'.repeat(43)]) {
    expect(() => validateMagicConsume({ token, intendedEmail: 'owned@example.test' })).toThrow('Authentication rejected')
  }
  expect(validateMagicConsume({ token: 'A'.repeat(43), intendedEmail: ' Owned@Example.Test ' }).intendedEmail === 'owned@example.test').toBe(true)
})
