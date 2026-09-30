import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Schema } from 'effect'

export type AuthEmailBinding = Readonly<{ deliveryId: string; purpose: 'magic-link'; generation: number; expiresAt: Date }>
export type AuthEmailSealed = Readonly<{ keyId: string; ciphertext: string; nonce: string; tag: string }>
export type AuthEmailKeys = Readonly<{ currentKeyId: string; keys: Readonly<Record<string, Uint8Array>> }>
const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const bindingSchema = Schema.Struct({
  deliveryId: Schema.String.check(Schema.isUUID()), purpose: Schema.Literal('magic-link'),
  generation: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  expiresAt: Schema.Date,
})
const sealedSchema = Schema.Struct({
  keyId: identifier,
  ciphertext: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2})+$/)),
  nonce: Schema.String.check(Schema.isPattern(/^[0-9a-f]{24}$/)),
  tag: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
})
const rejected = () => new Error('Auth email envelope rejected')

// Internal crypto primitive; worker admission belongs to the auth store.
export function createAuthEmailEnvelope(config: AuthEmailKeys) {
  const keys = new Map<string, Buffer>()
  try {
    Schema.decodeUnknownSync(identifier)(config.currentKeyId)
    for (const [id, bytes] of Object.entries(config.keys)) {
      Schema.decodeUnknownSync(identifier)(id)
      if (bytes.byteLength !== 32) throw rejected()
      keys.set(id, Buffer.from(bytes))
    }
    if (!keys.has(config.currentKeyId)) throw rejected()
  } catch { throw rejected() }
  const currentKeyId = config.currentKeyId
  function aad(input: AuthEmailBinding, keyId: string, databaseTime: Date) {
    const value = Schema.decodeUnknownSync(bindingSchema)(input)
    const now = Schema.decodeUnknownSync(Schema.Date)(databaseTime).getTime()
    if (value.expiresAt.getTime() <= now || value.expiresAt.getTime() > now + 600000) throw rejected()
    return Buffer.from(JSON.stringify(['auth-email-v1', keyId, value.deliveryId, value.purpose, value.generation, value.expiresAt.toISOString()]))
  }
  function seal(payload: Uint8Array, binding: AuthEmailBinding, databaseTime: Date): AuthEmailSealed {
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', keys.get(currentKeyId)!, nonce, { authTagLength: 16 })
      cipher.setAAD(aad(binding, currentKeyId, databaseTime))
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
      const tag = cipher.getAuthTag()
      if (tag.byteLength !== 16) throw rejected()
      return { keyId: currentKeyId, ciphertext: ciphertext.toString('hex'), nonce: nonce.toString('hex'), tag: tag.toString('hex') }
    } catch { throw rejected() }
  }
  function open(envelope: AuthEmailSealed, binding: AuthEmailBinding, databaseTime: Date): Buffer {
    try {
      const value = Schema.decodeUnknownSync(sealedSchema)(envelope), key = keys.get(value.keyId)
      if (!key) throw rejected()
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'hex'), { authTagLength: 16 })
      decipher.setAAD(aad(binding, value.keyId, databaseTime))
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'))
      const pending = decipher.update(Buffer.from(value.ciphertext, 'hex'))
      try { return Buffer.concat([pending, decipher.final()]) }
      finally { pending.fill(0) }
    } catch { throw rejected() }
  }
  return Object.freeze({ seal, open })
}
export type AuthEmailEnvelope = ReturnType<typeof createAuthEmailEnvelope>

export function readAuthEmailEnvelope(env: Readonly<Record<string, string | undefined>>) {
  try {
    const keyId = Schema.decodeUnknownSync(identifier)(env.AUTH_MAIL_KEY_ID)
    const encoded = Schema.decodeUnknownSync(Schema.Record(identifier, Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/))))(JSON.parse(env.AUTH_MAIL_KEYS_JSON ?? ''))
    const keys = Object.fromEntries(Object.entries(encoded).map(([id, value]) => [id, Buffer.from(value, 'base64')]))
    try { return createAuthEmailEnvelope({ currentKeyId: keyId, keys }) }
    finally { for (const key of Object.values(keys)) key.fill(0) }
  } catch { throw rejected() }
}
