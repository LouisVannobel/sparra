import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'

const binding = () => ({ deliveryId: randomUUID(), purpose: 'magic-link' as const, generation: 1, expiresAt: new Date(Date.now() + 600000) })
const keys = () => ({ currentKeyId: 'v1', keys: { v1: randomBytes(32) } })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('native envelope preserves exactly the same bytes after recreation and uses fresh nonces', () => {
  const config = keys(), aad = binding(), bytes = randomBytes(32)
  const first = createAuthEmailEnvelope(config).seal(bytes, aad, new Date())
  const second = createAuthEmailEnvelope(config).seal(bytes, aad, new Date())
  expect(first.nonce === second.nonce).toBe(false)
  expect(digest(createAuthEmailEnvelope(config).open(first, aad, new Date()))).toBe(digest(bytes))
  expect(first.tag.length).toBe(32)
  expect(first.nonce.length).toBe(24)
})

test('rotation seals with current key and admits old key only while present and unexpired', () => {
  const config = keys(), aad = binding(), bytes = randomBytes(32)
  const old = createAuthEmailEnvelope(config).seal(bytes, aad, new Date())
  const rotated = createAuthEmailEnvelope({ currentKeyId: 'v2', keys: { ...config.keys, v2: randomBytes(32) } })
  expect(rotated.seal(bytes, aad, new Date()).keyId).toBe('v2')
  expect(digest(rotated.open(old, aad, new Date()))).toBe(digest(bytes))
  expect(() => createAuthEmailEnvelope({ currentKeyId: 'v2', keys: { v2: randomBytes(32) } }).open(old, aad, new Date())).toThrow('Auth email envelope rejected')
})

test.each(['ciphertext', 'tag', 'nonce', 'keyId', 'deliveryId', 'generation', 'purpose', 'expiresAt', 'shortTag', 'wrongKey', 'expired'])(
  'rejects %s before returning plaintext', kind => {
    const config = keys(), aad = binding(), codec = createAuthEmailEnvelope(config)
    const sealed = codec.seal(randomBytes(32), aad, new Date())
    const changed = { ...sealed }, context = { ...aad }
    if (kind === 'ciphertext' || kind === 'tag' || kind === 'nonce') changed[kind] = (changed[kind][0] === 'a' ? 'b' : 'a') + changed[kind].slice(1)
    if (kind === 'shortTag') changed.tag = changed.tag.slice(2)
    if (kind === 'keyId') changed.keyId = 'absent'
    if (kind === 'deliveryId') context.deliveryId = randomUUID()
    if (kind === 'generation') context.generation++
    if (kind === 'purpose') Object.assign(context, { purpose: 'security-notification' })
    if (kind === 'expiresAt') context.expiresAt = new Date(aad.expiresAt.getTime() - 1)
    if (kind === 'expired') context.expiresAt = new Date(Date.now() - 1)
    const reader = kind === 'wrongKey' ? createAuthEmailEnvelope(keys()) : codec
    expect(() => reader.open(changed, context, new Date())).toThrow('Auth email envelope rejected')
  },
)

test('rejects missing current key and non-256-bit keys without exposing material', () => {
  expect(() => createAuthEmailEnvelope({ currentKeyId: 'absent', keys: {} })).toThrow('Auth email envelope rejected')
  expect(() => createAuthEmailEnvelope({ currentKeyId: 'v1', keys: { v1: randomBytes(31) } })).toThrow('Auth email envelope rejected')
})

test('envelope uses supplied authoritative time despite application clock skew and rejects its expiry', () => {
  const authoritativeNow = new Date(), aad = { ...binding(), expiresAt: new Date(authoritativeNow.getTime() + 600000) }
  const codec = createAuthEmailEnvelope(keys()), bytes = randomBytes(32)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(authoritativeNow.getTime() - 60000)
  try {
    const sealed = codec.seal(bytes, aad, authoritativeNow)
    expect(digest(codec.open(sealed, aad, authoritativeNow))).toBe(digest(bytes))
    expect(() => codec.open(sealed, aad, aad.expiresAt)).toThrow('Auth email envelope rejected')
  } finally { clock.mockRestore() }
})
