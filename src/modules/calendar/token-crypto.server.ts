import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Redacted, Schema } from 'effect'
import type { CalendarConfig } from './config.server'

const secret = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384))
const scope = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048), Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/))
const tokenShape = Schema.Struct({
  accessToken: secret,
  refreshToken: secret,
  expiresAt: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  grantedScopes: Schema.Array(scope).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export type CalendarTokens = typeof tokenShape.Type
export type CalendarTokenBinding = { readonly workspaceId: string; readonly connectionId: string }

class CalendarTokenError extends Error {
  constructor() { super('Invalid Calendar token envelope'); this.name = 'CalendarTokenError' }
}

function aad(binding: CalendarTokenBinding): Buffer {
  if (!binding.workspaceId || !binding.connectionId || binding.workspaceId.length > 256 || binding.connectionId.length > 256) throw new CalendarTokenError()
  return Buffer.from(JSON.stringify(['sparra-calendar', 1, binding.workspaceId, binding.connectionId]))
}

export function encryptCalendarTokens(config: CalendarConfig, binding: CalendarTokenBinding, tokens: CalendarTokens): string {
  try {
    const value = Schema.decodeUnknownSync(tokenShape, { onExcessProperty: 'error' })(tokens)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(Redacted.value(config.tokenKey), 'base64url'), nonce)
    cipher.setAAD(aad(binding))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')}`
  } catch { throw new CalendarTokenError() }
}

export function decryptCalendarTokens(config: CalendarConfig, binding: CalendarTokenBinding, envelope: string): CalendarTokens {
  try {
    // Covers worst-case JSON escaping of the bounded token shape before base64url encoding.
    if (envelope.length > 524288 || !/^v1\.[A-Za-z0-9_-]+$/.test(envelope)) throw new CalendarTokenError()
    const encoded = envelope.slice(3)
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.length < 29 || bytes.toString('base64url') !== encoded) throw new CalendarTokenError()
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(Redacted.value(config.tokenKey), 'base64url'), bytes.subarray(0, 12))
    decipher.setAAD(aad(binding))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
    return Schema.decodeUnknownSync(tokenShape, { onExcessProperty: 'error' })(value)
  } catch { throw new CalendarTokenError() }
}
