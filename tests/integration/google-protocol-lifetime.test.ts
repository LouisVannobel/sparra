import { afterAll, afterEach, expect, test } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { google } from 'better-auth/social-providers'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import type { createGoogleTransport } from '../../src/modules/auth/google-transport.server'

let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
let transport: ReturnType<typeof createGoogleTransport> | undefined
const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
afterAll(() => pool.end())
afterEach(async () => {
  const failures: unknown[] = []
  try { await transport?.close() } catch (error) { failures.push(error) }
  finally {
    try { await peer?.close() } catch (error) { failures.push(error) }
    finally { peer = undefined; transport = undefined }
  }
  if (failures.length) throw new AggregateError(failures, 'Google lifetime cleanup failed')
})

test.each(['valid','hosted-domain','foreign-token','wrong-nonce','closed','repeated-profile','second-exchange'] as const)('trusted direct exchange preserves native profile ownership: %s', async mode => {
  peer = await startGoogleProtocolPeer()
  const { createGoogleTransport } = await import('../../src/modules/auth/google-transport.server')
  const { createGoogleProtocol } = await import('../../src/modules/auth/google-protocol.server')
  const { createTransactions } = await import('../../src/platform/db/transactions.server')
  transport = createGoogleTransport()
  const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const protocol = createGoogleProtocol(owner, transport, 'fixture.apps.googleusercontent.com')
  let mappings = 0
  const native = google({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only', hd: 'allowed.example.test', mapProfileToUser: () => { mappings++; return {} } })
  await owner.runAuthInvocation({ deadlineAtMs: Date.now()+2000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() }, async () => {
    const cell = protocol.lifetime(), wrapped = cell.decorate(native)
    try {
      const codeVerifier = randomUUID()+randomUUID(), expectedIdTokenNonce = randomUUID(), redirectURI = 'http://localhost:3000/api/auth/callback/google'
      const url = await wrapped.createAuthorizationURL({ state: randomUUID(), codeVerifier, redirectURI, idTokenNonce: expectedIdTokenNonce })
      const code = peer!.register(url.href, randomUUID(), { claims: { hd: mode === 'hosted-domain' ? 'other.example.test' : 'allowed.example.test' } })
      const tokens = await wrapped.validateAuthorizationCode({ code, codeVerifier, redirectURI })
      expect(peer!.evidence()).toMatchObject({ posts: 1, clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
      if (mode === 'closed') await transport!.close()
      if (mode === 'second-exchange') {
        expect(await wrapped.validateAuthorizationCode({ code, codeVerifier, redirectURI }).then(() => false, () => true)).toBe(true)
        expect(peer!.evidence().posts).toBe(1)
      }
      const operation = wrapped.getUserInfo({ ...tokens, expectedIdTokenNonce: mode === 'wrong-nonce' ? 'foreign-nonce' : expectedIdTokenNonce,
        ...(mode === 'foreign-token' ? { idToken: 'foreign-token' } : {}) })
      if (['foreign-token','wrong-nonce','closed'].includes(mode)) { expect(await operation.then(() => false, () => true)).toBe(true); expect(mappings).toBe(0) }
      else if (mode === 'hosted-domain') { expect(await operation === null).toBe(true); expect(mappings).toBe(0) }
      else { expect((await operation)?.user).toBeDefined(); expect(mappings).toBe(1) }
      if (mode === 'repeated-profile') { expect(await wrapped.getUserInfo({ ...tokens, expectedIdTokenNonce }).then(() => false, () => true)).toBe(true); expect(mappings).toBe(1) }
    } finally { cell.revoke(); await cell.join() }
  })
})

test('instance close refuses the result of an already-entered native profile continuation', async () => {
  peer = await startGoogleProtocolPeer()
  const { createGoogleTransport } = await import('../../src/modules/auth/google-transport.server')
  const { createGoogleProtocol } = await import('../../src/modules/auth/google-protocol.server')
  const { createTransactions } = await import('../../src/platform/db/transactions.server')
  transport = createGoogleTransport()
  const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const protocol = createGoogleProtocol(owner, transport, 'fixture.apps.googleusercontent.com')
  let entered!: () => void, release!: () => void
  const inProfile = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const native = google({ clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only', mapProfileToUser: async () => { entered(); await gate; return {} } })
  await owner.runAuthInvocation({ deadlineAtMs: Date.now()+2000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() }, async () => {
    const cell = protocol.lifetime(), wrapped = cell.decorate(native)
    try {
      const codeVerifier = randomUUID()+randomUUID(), expectedIdTokenNonce = randomUUID(), redirectURI = 'http://localhost:3000/api/auth/callback/google'
      const url = await wrapped.createAuthorizationURL({ state: randomUUID(), codeVerifier, redirectURI, idTokenNonce: expectedIdTokenNonce })
      const tokens = await wrapped.validateAuthorizationCode({ code: peer!.register(url.href), codeVerifier, redirectURI })
      const profile = wrapped.getUserInfo({ ...tokens, expectedIdTokenNonce }); void profile.catch(() => {})
      await inProfile; await transport!.close(); release()
      expect(await profile.then(() => false, () => true)).toBe(true)
      expect(peer!.evidence()).toMatchObject({ activeClientSockets: 0, activeRequests: 0 })
    } finally { release(); cell.revoke(); await cell.join() }
  })
})
