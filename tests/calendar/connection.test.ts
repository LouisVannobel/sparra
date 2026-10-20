import { generateKeyPairSync, sign } from 'node:crypto'
import { Redacted } from 'effect'
import { expect, test } from 'vitest'
import { verifyCalendarIdentity } from '../../src/modules/calendar/connection.server'
import type { CalendarConfig } from '../../src/modules/calendar/config.server'
const config: CalendarConfig = { origin: 'http://localhost:3000', clientId: Redacted.make('calendar-client'), clientSecret: Redacted.make('fixture'), tokenKey: Redacted.make('A'.repeat(43)) }
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256' as const, kty: 'RSA' as const, use: 'sig' as const, kid: 'fixture-key' }
function token(changes: Record<string, string|number|undefined> = {}, header: Record<string, string|number|undefined> = {}) {
  const body = [JSON.stringify({ alg: 'RS256', kid: 'fixture-key', ...header }), JSON.stringify({ iss: 'https://accounts.google.com', aud: 'calendar-client', sub: 'google-subject', nonce: 'nonce', exp: Math.floor(Date.now()/1000)+300, iat: Math.floor(Date.now()/1000), ...changes })].map(value => Buffer.from(value).toString('base64url')).join('.')
  return body+'.'+sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')
}
const provider = { signingKeys: async () => [{ ...jwk, n: jwk.n!, e: jwk.e! }], userInfo: async () => ({ sub: 'google-subject', email: 'owner@example.test', emailVerified: true }) }
test('accepts only the signed Calendar audience with nonce and matching userinfo subject', async () => {
  expect(await verifyCalendarIdentity(config, provider, token(), 'nonce', 'access')).toEqual({ sub: 'google-subject', email: 'owner@example.test' })
})
test.each([{ aud: 'login-client' }, { nonce: 'wrong' }, { iss: 'https://attacker.invalid' }, { exp: 1 }, { exp: undefined }, { sub: '' }])('refuses signed invalid identity claims %j', async claims => {
  await expect(verifyCalendarIdentity(config, provider, token(claims), 'nonce', 'access')).rejects.toThrow('Calendar identity rejected')
})
test('refuses a forged signature, wrong algorithm and userinfo subject substitution', async () => {
  await expect(verifyCalendarIdentity(config, provider, token().slice(0,-20)+'a'.repeat(20), 'nonce', 'access')).rejects.toThrow()
  await expect(verifyCalendarIdentity(config, provider, token({}, { alg: 'HS256' }), 'nonce', 'access')).rejects.toThrow()
  await expect(verifyCalendarIdentity(config, { ...provider, userInfo: async () => ({ sub: 'foreign', email: 'x@example.test', emailVerified: true }) }, token(), 'nonce', 'access')).rejects.toThrow()
})
