import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { createMailSnapshot, decodeMailSnapshot, validateMailProfile } from '../../src/modules/auth/mail-snapshot.server'

const profile = { appOrigin: 'https://app.example.test', apiOrigin: 'https://mail.example.test', projectId: 'auth-project', credentialId: 'key-1', from: { name: 'Product', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
const outboxId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
test('snapshot freezes one inline Plunk request with a direct fragment and an outbox key', () => {
  const result = createMailSnapshot(profile, { recipient: 'one@example.test', locale: 'en' }, outboxId, Buffer.alloc(32, 1))
  const value = decodeMailSnapshot(result.bytes, result.hash)
  const body = JSON.parse(value.requestJson)
  expect(Object.keys(body)).toEqual(['to', 'from', 'subject', 'body', 'reply'])
  expect(body.to).toBe('one@example.test')
  expect(body.subject).toBe('Your sign-in link')
  expect(body.body.includes('href="https://app.example.test/auth/magic/confirm?lang=en#token=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"')).toBe(true)
  expect(value.idempotencyKey).toBe('auth-email-delivery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  expect(value.path).toBe('/v1/send')
  expect(result.hash).toBe(createHash('sha256').update(result.bytes).digest('hex'))
  expect(() => decodeMailSnapshot(result.bytes, '0'.repeat(64))).toThrow('Auth mail snapshot rejected')
})
test.each([
  { apiOrigin: 'https://mail.example.test/anything' }, { appOrigin: 'https://attacker@app.example.test' },
  { from: { name: 'Header\r\ninjection', email: 'auth@example.test' } }, { replayWindowSeconds: 601 },
  { reply: 'bad\r\n@example.test' }, { apiOrigin: 'http://remote.example.test' },
])('profile refuses uncontrolled destinations and unbounded content %#', changes => {
  expect(() => validateMailProfile({ ...profile, ...changes })).toThrow('Auth mail profile rejected')
})
test('French content is fixed and profile mutation cannot change serialized replay bytes', () => {
  const input = structuredClone(profile)
  const result = createMailSnapshot(input, { recipient: 'one@example.test', locale: 'fr' }, outboxId, Buffer.alloc(32, 2))
  input.from.name = 'Changed'
  const value = decodeMailSnapshot(result.bytes, result.hash)
  expect(JSON.parse(value.requestJson).subject).toBe('Votre lien de connexion')
  expect(JSON.parse(value.requestJson).body.includes('/auth/magic/confirm?lang=fr#token=')).toBe(true)
  expect(JSON.parse(value.requestJson).from.name).toBe('Product')
  expect(value.replayWindowSeconds).toBeNull()
})
