import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { Redacted } from 'effect'
import type { CalendarConfig } from '../../src/modules/calendar/config.server'
import { GOOGLE_CALENDAR_SCOPES, type GoogleTokenResponse } from '../../src/modules/calendar/google.server'
export const calendarFixtureConfig: CalendarConfig = { origin: 'http://localhost:3000', clientId: Redacted.make('fixture-calendar-client'), clientSecret: Redacted.make('fixture-only'), tokenKey: Redacted.make(randomBytes(32).toString('base64url')) }
export const calendarFixturePolicy = () => ({ version: 1 as const, timeZone: 'Europe/Paris', services: [{ id: 'oil-change', name: 'Vidange', durationMinutes: 30 }], weeklyHours: [{ day: 1, ranges: [{ start: '09:00', end: '12:00' }] }], bufferMinutes: 10, noticeMinutes: 60 })
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = publicKey.export({ format: 'jwk' })
export function calendarPeer() {
  const state = { sub: randomBytes(16).toString('hex'), nonce: '', scopes: ['openid','email',...GOOGLE_CALENDAR_SCOPES], refresh: true, writable: true, expired: false, exchanges: 0, refreshes: 0, revocations: 0,
    exchangeGate: async () => {}, refreshGate: async () => {}, revokeGate: async () => {}, listGate:async()=>{} }
  function tokens(): GoogleTokenResponse {
    const body = [JSON.stringify({ alg: 'RS256', kid: 'fixture-key' }), JSON.stringify({ iss: 'https://accounts.google.com', aud: 'fixture-calendar-client', sub: state.sub, nonce: state.nonce, exp: Math.floor(Date.now()/1000)+300 })].map(value => Buffer.from(value).toString('base64url')).join('.')
    return { accessToken: 'secret-access', ...(state.refresh ? { refreshToken: 'secret-refresh' } : {}), idToken: body+'.'+sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url'), grantedScopes: state.scopes, tokenType: 'Bearer', expiresIn: state.expired ? 1 : 3600 }
  }
  const provider = {
    async exchangeCode(_input: { code: string; codeVerifier: string; redirectUri: string }) { state.exchanges++; const result=tokens(); await state.exchangeGate(); return result },
    async refreshTokens(_token: string) { state.refreshes++; const result=tokens(); await state.refreshGate(); return result },
    async revokeToken(_token: string) { state.revocations++; await state.revokeGate() },
    async signingKeys() { return [{ kty:'RSA' as const, alg:'RS256' as const, use:'sig' as const, kid:'fixture-key', n:key.n!, e:key.e! }] },
    async userInfo(_access: string) { return { sub:state.sub, email:'owner@example.test', emailVerified:true } },
    async listCalendars(_access: string) { await state.listGate();return [{ id:'primary-calendar', summary:'Mon agenda', timeZone:'Europe/Paris', accessRole:state.writable ? 'writerWithoutPrivateAccess' as const : 'reader' as const }] },
    async close() {},
  }
  return { state, provider }
}
export function latch() { let release = () => {}; const wait = new Promise<void>(resolve => { release=resolve }); return { wait, release } }
