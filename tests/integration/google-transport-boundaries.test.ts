import { afterEach, expect, test, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import type { createGoogleTransport } from '../../src/modules/auth/google-transport.server'

const headers = vi.hoisted(() => ({ padding: undefined as number | undefined, bodyDigits: 0 }))
// Public builder is always delegated. Only the header-bound case adds a
// synthetic returned header, because today's Google form auth has fixed headers.
vi.mock('better-auth/oauth2', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth/oauth2')>()
  return { ...actual, authorizationCodeRequest: async (...args: Parameters<typeof actual.authorizationCodeRequest>) => {
    const result = await actual.authorizationCodeRequest(...args)
    headers.bodyDigits = String(Buffer.byteLength(result.body.toString())).length
    return headers.padding === undefined ? result : { ...result, headers: { ...result.headers, 'x-fixture-header': 'x'.repeat(headers.padding) } }
  } }
})
let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
let transport: ReturnType<typeof createGoogleTransport> | undefined
afterEach(async () => {
  const failures: unknown[] = []
  try { await transport?.close() } catch (error) { failures.push(error) }
  finally {
    try { await peer?.close() } catch (error) { failures.push(error) }
    finally { peer = undefined; transport = undefined; headers.padding = undefined }
  }
  if (failures.length) throw new AggregateError(failures, 'Boundary fixture cleanup failed')
})
async function setup() {
  peer = await startGoogleProtocolPeer({ nativeDns: true })
  const { createGoogleTransport } = await import('../../src/modules/auth/google-transport.server')
  transport = createGoogleTransport()
}
function input() {
  const codeVerifier = randomUUID()+randomUUID(), redirectURI = 'http://localhost:3000/api/auth/callback/google'
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('nonce', randomUUID()); url.searchParams.set('code_challenge_method','S256')
  url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url')); url.searchParams.set('redirect_uri', redirectURI)
  return { code: peer!.register(url.href), codeVerifier, redirectURI, options: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' } }
}
function lifetime(controller = new AbortController()) {
  const deadlineAtMs = Date.now()+5000
  return { deadlineAtMs, cleanupTimeoutMs: 1000, signal: controller.signal, assert() { if (controller.signal.aborted || Date.now() >= deadlineAtMs) throw new Error('Fixture invocation ended') } }
}

test('resolved original DNS handoff remains revocable before connection and cannot connect after release', async () => {
  await setup(); peer!.holdHandoff()
  const control = transport!.exchange(input(), lifetime()); void control.catch(() => {})
  await expect.poll(() => peer!.evidence().pendingHandoffs, { timeout: 1000 }).toBe(1)
  expect(peer!.evidence()).toMatchObject({ dnsSettled: 2, posts: 0, attemptedFamilies: [] })
  peer!.releaseHandoff()
  expect(typeof await control === 'object').toBe(true)

  peer!.holdHandoff()
  const controller = new AbortController(), work = transport!.exchange(input(), lifetime(controller))
  const rejected = work.then(() => false, () => true)
  await expect.poll(() => peer!.evidence().pendingHandoffs, { timeout: 1000 }).toBe(1)
  expect(peer!.evidence()).toMatchObject({ dnsStarted: 4, dnsSettled: 4, posts: 1 })
  const attempts = peer!.evidence().attemptedFamilies.length
  controller.abort()
  let settled = false; void rejected.then(() => { settled = true })
  await expect.poll(() => settled, { timeout: 500 }).toBe(true)
  expect(await rejected).toBe(true)
  expect(peer!.evidence()).toMatchObject({ requests: 2, requestCloses: 2, clientSockets: 2, clientCloses: 2, activeRequests: 0, activeClientSockets: 0, posts: 1 })
  peer!.releaseHandoff()
  await new Promise(resolve => setImmediate(resolve))
  expect(peer!.evidence().attemptedFamilies.length).toBe(attempts)
  expect(peer!.evidence()).toMatchObject({ posts: 1, disallowed: 0, activeClientSockets: 0 })
})

test('client cancellation before real ClientRequest socket assignment still joins returned TLS socket', async () => {
  await setup()
  const controller = new AbortController()
  let unassigned = false
  peer!.onRequestCreated(request => { unassigned = request.socket === null; controller.abort() })
  const rejected = transport!.exchange(input(), lifetime(controller)).then(() => false, () => true)
  expect(await rejected).toBe(true)
  expect(unassigned).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 0, requests: 1, requestCloses: 1, clientSockets: 1, clientCloses: 1, activeRequests: 0, activeClientSockets: 0,
    dnsStarted: 2, dnsSettled: 2, attemptedFamilies: [], disallowed: 0, emergencyCleanup: false })
})

test('outgoing serialized headers accept 16384 bytes and refuse 16385 before native request or DNS', async () => {
  await setup()
  // Independent wire-field accounting: three decimal Content-Length digits.
  // HTTP request line and terminal CRLF are the separate fixed 24-byte framing.
  const fixedFields = 'content-type: application/x-www-form-urlencoded\r\naccept: application/json\r\nx-fixture-header: \r\nhost: oauth2.googleapis.com\r\naccept-encoding: identity\r\ncontent-length: 000\r\nconnection: close\r\n'
  headers.padding = 16384 - Buffer.byteLength(fixedFields)
  expect(typeof await transport!.exchange(input(), lifetime()) === 'object').toBe(true)
  expect(headers.bodyDigits).toBe(3)
  expect(peer!.evidence()).toMatchObject({ requestHeaderBytes: [16384], posts: 1, requests: 1, requestCloses: 1, clientCloses: 1, activeRequests: 0, activeClientSockets: 0 })
  headers.padding++
  expect(await transport!.exchange(input(), lifetime()).then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 1, requests: 1, dnsStarted: 2, dnsSettled: 2, activeRequests: 0, activeClientSockets: 0, disallowed: 0 })
})
