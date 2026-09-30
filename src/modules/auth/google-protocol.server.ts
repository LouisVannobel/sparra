import { Schema } from 'effect'
import { APIError } from 'better-auth/api'
import { getOAuth2Tokens, type OAuthProvider } from 'better-auth/oauth2'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { createGoogleTransport } from './google-transport.server'

function rejected(): never { throw new APIError('UNAUTHORIZED', { message: 'Authentication rejected' }) }
const text = Schema.String.check(Schema.isMinLength(1))
const expiry = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const tokenResponse = Schema.Struct({
  id_token: text, access_token: text, token_type: text,
  refresh_token: Schema.optionalKey(text), expires_in: Schema.optionalKey(expiry), refresh_token_expires_in: Schema.optionalKey(expiry),
  scope: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  error: Schema.optionalKey(Schema.Unknown),
})
const epoch = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }))
const claimsSchema = Schema.Struct({
  iss: Schema.Literals(['accounts.google.com', 'https://accounts.google.com']),
  sub: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255), Schema.isPattern(/^[\x00-\x7f]+$/)),
  aud: Schema.Union([text, Schema.Array(text)]), azp: Schema.optionalKey(text),
  exp: epoch, iat: epoch, nbf: Schema.optionalKey(Schema.Number.check(Schema.isFinite())), nonce: text,
})
function decodePart(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return rejected()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) return rejected()
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export function createGoogleProtocol(owner: AuthTransactions, transport: ReturnType<typeof createGoogleTransport>, clientId: string) {
  function lifetime() {
    const options = owner.invocationOptions(), controller = new AbortController()
    let revoked = false, attempted = false, profiled = false, idToken: string | undefined, work: Promise<unknown> | undefined
    const inheritedAbort = () => controller.abort()
    options.signal?.addEventListener('abort', inheritedAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
    function assert() {
      transport.assertOpen(); owner.assertNoActiveAuthTransaction()
      if (revoked || controller.signal.aborted || owner.invocationOptions() !== options || Date.now() >= options.deadlineAtMs) return rejected()
    }
    const cell = {
      assert,
      revoke() { revoked = true; controller.abort(); options.signal?.removeEventListener('abort', inheritedAbort) },
      async join() { if (work) await work.then(() => {}, () => {}) },
      decorate(provider: OAuthProvider): OAuthProvider {
        assert()
        const effectiveOptions = provider.options
        if (!effectiveOptions) return rejected()
        return {
          ...provider, requiresIdTokenNonce: true,
          async createAuthorizationURL(input) {
            assert()
            if (!input.idTokenNonce) return rejected()
            const url = await provider.createAuthorizationURL(input)
            assert(); url.searchParams.set('nonce', input.idTokenNonce); return url
          },
          async validateAuthorizationCode(input) {
            assert(); if (attempted) return rejected(); attempted = true
            work = transport.exchange({ code: input.code, codeVerifier: input.codeVerifier, redirectURI: input.redirectURI, options: effectiveOptions },
              { deadlineAtMs: options.deadlineAtMs, cleanupTimeoutMs: options.cleanupTimeoutMs, signal: controller.signal, assert })
            const raw = await work
            assert()
            try {
              const data = Schema.decodeUnknownSync(tokenResponse)(raw)
              if (Object.hasOwn(data, 'error')) return rejected()
              for (const seconds of [data.expires_in, data.refresh_token_expires_in]) {
                if (seconds !== undefined && !Number.isFinite(new Date(Date.now() + seconds * 1000).getTime())) return rejected()
              }
              const result = getOAuth2Tokens(data)
              idToken = data.id_token
              return result
            } catch { return rejected() }
          },
          async getUserInfo(tokens) {
            assert()
            if (profiled || !idToken || tokens.idToken !== idToken || !tokens.expectedIdTokenNonce) return rejected()
            profiled = true
            try {
              if (idToken.length > 65536) return rejected()
              const parts = idToken.split('.')
              if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2]) || parts[2].length % 4 === 1 || Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2]) return rejected()
              Schema.decodeUnknownSync(Schema.Struct({ alg: Schema.Literal('RS256') }))(decodePart(parts[0]))
              const claims = Schema.decodeUnknownSync(claimsSchema)(decodePart(parts[1]))
              const audience = typeof claims.aud === 'string' ? claims.aud : claims.aud.length === 1 ? claims.aud[0] : undefined
              const now = Date.now() / 1000
              if (audience !== clientId || claims.azp !== undefined && claims.azp !== clientId || claims.exp <= now || claims.iat >= claims.exp
                || claims.nbf !== undefined && claims.nbf > now || claims.nonce !== tokens.expectedIdTokenNonce) return rejected()
            } catch { return rejected() }
            assert()
            const result = await provider.getUserInfo(tokens)
            assert(); return result
          },
          async accountSubject(input) {
            assert(); const subject = await provider.accountSubject(input); assert(); return subject
          },
        }
      },
    }
    return cell
  }
  return { lifetime }
}
export type GoogleProtocolLifetime = ReturnType<ReturnType<typeof createGoogleProtocol>['lifetime']>
