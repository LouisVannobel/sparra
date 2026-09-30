import { afterEach, expect, test } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import type { createGoogleTransport } from '../../src/modules/auth/google-transport.server'

let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
let transport: ReturnType<typeof createGoogleTransport> | undefined
afterEach(async () => {
  const failures: unknown[] = []
  try { await transport?.close() } catch (error) { failures.push(error) }
  finally {
    try { await peer?.close() } catch (error) { failures.push(error) }
    finally { transport = undefined; peer = undefined }
  }
  if (failures.length) throw new AggregateError(failures, 'Google fixture cleanup failed')
})
async function setup(options: { nativeDns?: boolean; wrongHost?: boolean; family?: 4 | 6; holdTls?: boolean } = {}) {
  peer = await startGoogleProtocolPeer(options)
  const { createGoogleTransport } = await import('../../src/modules/auth/google-transport.server')
  transport = createGoogleTransport()
}
function input(padding = 0) {
  // Transport-only fixture: no claim of a native OAuth-state ceremony here.
  const codeVerifier = randomUUID()+randomUUID(), url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('nonce', randomUUID()); url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'))
  url.searchParams.set('redirect_uri', 'http://localhost:3000/api/auth/callback/google?pad='+'x'.repeat(padding))
  return { code: peer!.register(url.href), codeVerifier, redirectURI: url.searchParams.get('redirect_uri')!, options: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' } }
}
function lifetime(controller = new AbortController(), duration = 1000) {
  const deadlineAtMs = Date.now()+duration
  return { deadlineAtMs, cleanupTimeoutMs: 1000, signal: controller.signal,
    assert() { if (controller.signal.aborted || Date.now() >= deadlineAtMs) throw new Error('Fixture lifetime closed') } }
}
async function until(predicate: () => boolean) {
  const end = Date.now()+2000
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

test('fixed Google exchange traverses original Resolver queries and real verified TLS, HTTP, PKCE and close', async () => {
  await setup({ nativeDns: true })
  const result = await transport!.exchange(input(), lifetime())
  expect(Boolean(result && typeof result === 'object' && 'id_token' in result)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 1, tls: 1, pkce: 1, dnsStarted: 2, dnsSettled: 2, disallowed: 0, nativeDns: true,
    clientSockets: 1, clientCloses: 1, requests: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0, emergencyCleanup: false })
})
test('fixture CA does not authorize a wrong-host certificate', async () => {
  await setup({ wrongHost: true })
  expect(await transport!.exchange(input(), lifetime()).then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 0, disallowed: 0, clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
})
test.each(['redirect','error-status','encoding','header-excess','malformed-json','incomplete','body-excess','upgrade'])('owned transport rejects %s and joins actual operations', async mode => {
  await setup(); peer!.setMode(mode)
  expect(await transport!.exchange(input(), lifetime()).then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 1, disallowed: 0, dnsStarted: 2, dnsSettled: 2, clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
})
test('exact response body bound succeeds without retaining an excess byte', async () => {
  await setup(); peer!.setMode('body-boundary')
  expect(typeof await transport!.exchange(input(), lifetime()) === 'object').toBe(true)
})
test.each(['headers-held','body-held','trickle'])('ingress deadline cancels %s without a fresh per-stage budget', async mode => {
  await setup(); peer!.setMode(mode)
  const started = Date.now()
  expect(await transport!.exchange(input(), lifetime(undefined, 150)).then(() => false, () => true)).toBe(true)
  expect(Date.now()-started).toBeLessThan(1200)
  expect(peer!.evidence().posts).toBe(1)
  expect(peer!.evidence()).toMatchObject({ clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
})
test.each(['absent','failure','mixed-failure'])('original DNS %s fails closed and settles both queries before HTTP', async mode => {
  await setup({ nativeDns: true }); peer!.setDnsMode(mode)
  expect(await transport!.exchange(input(), lifetime()).then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ dnsStarted: 2, dnsSettled: 2, posts: 0, disallowed: 0, clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
})
test('original held DNS cancellation joins both original queries and the pending socket', async () => {
  await setup({ nativeDns: true }); peer!.setDnsMode('held')
  const controller = new AbortController(), work = transport!.exchange(input(), lifetime(controller))
  void work.catch(() => {})
  await until(() => peer!.evidence().dnsStarted === 2); controller.abort()
  expect(await work.then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ dnsStarted: 2, dnsSettled: 2, posts: 0, disallowed: 0, clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
})
test('four held exchanges reject a fifth without network and joined cancellation restores capacity', async () => {
  await setup(); peer!.setMode('body-held')
  const controller = new AbortController(), work = Array.from({ length: 4 }, () => transport!.exchange(input(), lifetime(controller, 3000)))
  for (const promise of work) void promise.catch(() => {})
  await until(() => peer!.evidence().posts === 4)
  expect(() => transport!.exchange(input(), lifetime())).toThrow()
  expect(peer!.evidence().posts).toBe(4)
  controller.abort(); await Promise.allSettled(work)
  peer!.setMode('valid')
  expect(typeof await transport!.exchange(input(), lifetime()) === 'object').toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 5, disallowed: 0 })
})
test('close joins every held exchange once and synchronously refuses new admission', async () => {
  await setup(); peer!.setMode('headers-held')
  const work = transport!.exchange(input(), lifetime(undefined, 3000)); void work.catch(() => {})
  await until(() => peer!.evidence().posts === 1)
  const closing = transport!.close()
  expect(transport!.close()).toBe(closing)
  expect(() => transport!.exchange(input(), lifetime())).toThrow()
  await closing; expect(await work.then(() => false, () => true)).toBe(true)
  expect(peer!.evidence().posts).toBe(1)
})

test('original DNS supports IPv6 alone with verified native TLS', async () => {
  await setup({ nativeDns: true, family: 6 })
  expect(typeof await transport!.exchange(input(), lifetime()) === 'object').toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 1, dnsStarted: 2, dnsSettled: 2, clientCloses: 1, requestCloses: 1, activeClientSockets: 0 })
})
test('original family order is IPv6 then IPv4 with Node connection fallback and one POST', async () => {
  await setup({ nativeDns: true }); peer!.setDnsMode('both')
  expect(typeof await transport!.exchange(input(), lifetime()) === 'object').toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 1, attemptedFamilies: [6,4], dnsStarted: 2, dnsSettled: 2, clientCloses: 1 })
})
test('native form accepts exactly 65536 bytes and refuses one excess byte before DNS or HTTP', async () => {
  await setup()
  const sample = input()
  const encoded = new URLSearchParams({ code: sample.code, code_verifier: sample.codeVerifier, redirect_uri: sample.redirectURI, grant_type: 'authorization_code', client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-only' })
  const padding = 65536 - Buffer.byteLength(encoded.toString())
  expect(typeof await transport!.exchange(input(padding), lifetime()) === 'object').toBe(true)
  const before = peer!.evidence()
  expect(await transport!.exchange(input(padding+1), lifetime()).then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: before.posts, dnsStarted: before.dnsStarted, activeClientSockets: 0, activeRequests: 0 })
})
test('capacity charges pending native builders and close cannot release their handles before settlement', async () => {
  await setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const work = Array.from({ length: 4 }, () => transport!.exchange({ ...input(), options: async () => { await gate; return { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' } } }, lifetime(undefined, 3000)))
  for (const promise of work) void promise.catch(() => {})
  expect(() => transport!.exchange(input(), lifetime())).toThrow()
  const closing = transport!.close(); let settled = false
  void closing.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(settled).toBe(false)
  expect(peer!.evidence()).toMatchObject({ posts: 0, dnsStarted: 0 })
  release(); await closing; await Promise.allSettled(work)
  expect(settled).toBe(true)
  expect(peer!.evidence()).toMatchObject({ posts: 0, dnsStarted: 0 })
})

test('TLS handshake stall retains the same ingress deadline and joins client request and socket', async () => {
  await setup({ holdTls: true })
  expect(await transport!.exchange(input(), lifetime(undefined, 150)).then(() => false, () => true)).toBe(true)
  expect(peer!.evidence()).toMatchObject({ tls: 0, posts: 0, clientCloses: 1, requestCloses: 1, activeClientSockets: 0, activeRequests: 0 })
})
