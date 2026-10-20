import { createCipheriv, randomBytes } from 'node:crypto'
import { Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { readCalendarConfig } from '../../src/modules/calendar/config.server'
import { decryptCalendarTokens, encryptCalendarTokens } from '../../src/modules/calendar/token-crypto.server'

const config = readCalendarConfig({ APP_ORIGIN: 'https://sparra.example', SPARRA_GOOGLE_CALENDAR_CLIENT_ID: 'client', SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', SPARRA_CALENDAR_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64url') })!
const binding = { workspaceId: 'workspace-a', connectionId: 'connection-a' }
const tokens = { accessToken: 'access-sensitive', refreshToken: 'refresh-sensitive', expiresAt: 1800000000000, grantedScopes: ['https://www.googleapis.com/auth/calendar.events'] }

describe('Calendar token protection', () => {
  it('round trips complete tokens with fresh authenticated encryption', () => {
    const first = encryptCalendarTokens(config, binding, tokens)
    const second = encryptCalendarTokens(config, binding, tokens)
    expect(first).not.toBe(second)
    expect(first).not.toContain(tokens.accessToken)
    expect(decryptCalendarTokens(config, binding, first)).toEqual(tokens)
  })
  it('can decrypt every accepted bounded token shape including large UTF-8 values', () => {
    const large = { ...tokens, accessToken: 'é'.repeat(16384), refreshToken: 'é'.repeat(16384), grantedScopes: Array.from({ length: 32 }, () => 's'.repeat(2048)) }
    expect(decryptCalendarTokens(config, binding, encryptCalendarTokens(config, binding, large))).toEqual(large)
  })
  it.each([
    { workspaceId: 'workspace-b', connectionId: binding.connectionId },
    { workspaceId: binding.workspaceId, connectionId: 'connection-b' },
    { workspaceId: 'workspace-a:connection-a', connectionId: '' },
  ])('rejects a different workspace/connection binding', other => {
    const encrypted = encryptCalendarTokens(config, binding, tokens)
    expect(() => decryptCalendarTokens(config, other, encrypted)).toThrow('Invalid Calendar token envelope')
  })
  it('rejects tampering and unsupported versions without token-bearing causes', () => {
    const encrypted = encryptCalendarTokens(config, binding, tokens)
    for (const bad of ['v2.' + encrypted.slice(3), encrypted.slice(0, -3) + 'xxx', '', tokens.accessToken]) {
      try { decryptCalendarTokens(config, binding, bad); expect.fail('accepted invalid envelope') } catch (error) {
        expect(String(error)).toContain('Invalid Calendar token envelope')
        expect(String(error)).not.toContain(tokens.accessToken)
        expect(error).not.toHaveProperty('cause')
      }
    }
  })
  it('validates complete shape at encryption, including bounded expiry and scopes', () => {
    expect(() => encryptCalendarTokens(config, binding, { ...tokens, refreshToken: '' })).toThrow()
    expect(() => encryptCalendarTokens(config, binding, { ...tokens, expiresAt: NaN })).toThrow()
    expect(() => encryptCalendarTokens(config, binding, { ...tokens, grantedScopes: ['bad scope'] })).toThrow()
  })
  it('rejects authenticated but incomplete or excess plaintext fields on decrypt', () => {
    for (const invalid of [{ accessToken: 'access' }, { ...tokens, extraSecret: 'unexpected' }]) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(Redacted.value(config.tokenKey), 'base64url'), nonce)
      cipher.setAAD(Buffer.from(JSON.stringify(['sparra-calendar', 1, binding.workspaceId, binding.connectionId])))
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(invalid)), cipher.final()])
      const envelope = 'v1.' + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')
      expect(() => decryptCalendarTokens(config, binding, envelope)).toThrow('Invalid Calendar token envelope')
    }
  })
})
