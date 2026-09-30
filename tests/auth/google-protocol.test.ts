import { afterAll, expect, test } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { google } from 'better-auth/social-providers'
import type { OAuthProvider } from 'better-auth/oauth2'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createGoogleProtocol } from '../../src/modules/auth/google-protocol.server'
import { createGoogleTransport } from '../../src/modules/auth/google-transport.server'

// No connection is opened: these exercise actual invocation ownership before I/O.
const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
afterAll(() => pool.end())
const options = () => ({ deadlineAtMs: Date.now()+1000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
const provider = () => google({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' })
const authorize = { state: 'state-fixture', codeVerifier: 'v'.repeat(64), redirectURI: 'http://localhost:3000/api/auth/callback/google', idTokenNonce: 'native-nonce-fixture' }

test('local Google copy preserves native URL parameters and forwards only the supplied native nonce', async () => {
  const transport = createGoogleTransport(), protocol = createGoogleProtocol(owner, transport, 'fixture.apps.googleusercontent.com')
  try {
    await owner.runAuthInvocation(options(), async () => {
      const original = provider(), cell = protocol.lifetime(), wrapped = cell.decorate(original)
      const url = await wrapped.createAuthorizationURL(authorize)
      expect(url.searchParams.get('nonce')).toBe('native-nonce-fixture')
      expect(url.searchParams.get('state')).toBe('state-fixture')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(wrapped.options).toBe(original.options)
      expect('requiresIdTokenNonce' in original).toBe(false)
      cell.revoke(); await cell.join()
    })
  } finally { await transport.close() }
})

test.each(['normal','error'] as const)('captured provider closure cannot start work after %s lifetime exit', async exit => {
  const transport = createGoogleTransport(), protocol = createGoogleProtocol(owner, transport, 'fixture.apps.googleusercontent.com')
  await owner.runAuthInvocation(options(), async () => {
    const cell = protocol.lifetime(), wrapped = cell.decorate(provider())
    try { if (exit === 'error') throw new Error('Fixture exit'); await wrapped.createAuthorizationURL(authorize) }
    catch {} finally { cell.revoke(); await cell.join() }
    await expect(wrapped.validateAuthorizationCode({ code: 'never-sent', redirectURI: authorize.redirectURI })).rejects.toThrow()
  })
  await transport.close()
})

test('a live closure rejects a different admitted invocation-options identity', async () => {
  const transport = createGoogleTransport(), protocol = createGoogleProtocol(owner, transport, 'fixture.apps.googleusercontent.com')
  let cell!: ReturnType<typeof protocol.lifetime>, wrapped!: OAuthProvider
  await owner.runAuthInvocation(options(), async () => { cell = protocol.lifetime(); wrapped = cell.decorate(provider()); await wrapped.createAuthorizationURL(authorize) })
  try {
    await owner.runAuthInvocation(options(), async () => {
      await expect(wrapped.createAuthorizationURL(authorize)).rejects.toThrow()
      await expect(wrapped.validateAuthorizationCode({ code: 'never-sent', redirectURI: authorize.redirectURI })).rejects.toThrow()
    })
  } finally { cell.revoke(); await cell.join(); await transport.close() }
})

test('closing an instance with no exchange refuses later profile and authorization continuations', async () => {
  const transport = createGoogleTransport(), protocol = createGoogleProtocol(owner, transport, 'fixture.apps.googleusercontent.com')
  await owner.runAuthInvocation(options(), async () => {
    const cell = protocol.lifetime(), wrapped = cell.decorate(provider())
    await wrapped.createAuthorizationURL(authorize)
    await transport.close()
    await expect(wrapped.createAuthorizationURL(authorize)).rejects.toThrow()
    await expect(wrapped.getUserInfo({ idToken: 'never-trusted', expectedIdTokenNonce: authorize.idTokenNonce })).rejects.toThrow()
    cell.revoke(); await cell.join()
  })
})
