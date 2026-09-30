import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import dns from 'node:dns'
import { createServer, type Server } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redacted } from 'effect'
import { createPlunkTransport, classifyPlunkResult } from '../../src/modules/auth/plunk.server'
import type { MailSnapshot } from '../../src/modules/auth/mail-snapshot.server'

const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const key = 'auth-email-delivery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const success = { success: true, data: { emails: [{ contact: { id, email: 'one@example.test' }, email: id }], timestamp: '2026-09-11T00:00:00.000Z' } }
test('only a valid one-recipient 200 or matching prior queued 409 authorizes queued state', () => {
  expect(classifyPlunkResult(200, success, key, 'one@example.test')).toEqual({ state: 'plunk_queued', evidence: 'response_200', emailId: id })
  const duplicate = { success: false, timestamp: '2026-09-11T00:00:00.000Z', error: { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409, message: 'Key reused', details: { key, originalRequest: 'POST /v1/send', originalRequestAt: '2026-09-11T00:00:00.000Z', originalStatusCode: 200 } } }
  expect(classifyPlunkResult(409, duplicate, key, 'one@example.test')).toEqual({ state: 'plunk_queued', evidence: 'duplicate_409', emailId: null })
  expect(classifyPlunkResult(409, { error: duplicate.error }, key, 'one@example.test')).toEqual({ state: 'effect_unknown' })
  for (const value of [null, {}, { ...success, success: false }, { ...success, data: { emails: [] } }]) expect(classifyPlunkResult(200, value, key, 'one@example.test')).toEqual({ state: 'effect_unknown' })
  for (const details of [{}, { ...duplicate.error.details, key: 'other' }, { ...duplicate.error.details, originalStatusCode: null }, { ...duplicate.error.details, originalStatusCode: 500 }, { ...duplicate.error.details, originalRequest: 'POST /other' }]) {
    expect(classifyPlunkResult(409, { ...duplicate, error: { ...duplicate.error, details } }, key, 'one@example.test')).toEqual({ state: 'effect_unknown' })
  }
  expect(classifyPlunkResult(500, success, key, 'one@example.test')).toEqual({ state: 'effect_unknown' })
  expect(classifyPlunkResult(200, success, key, 'different@example.test')).toEqual({ state: 'effect_unknown' })
})

let directory: string, server: Server, origin: string, ca: string
let mode: 'ok' | 'redirect' | 'large' | 'stall' = 'ok'
let requests = 0, closed = 0
let observed: { path?: string; body: string; headers: string[] } | undefined
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'auth-mail-tls-'))
  const openssl = process.platform === 'win32' ? join(process.env.ProgramFiles!, 'Git/usr/bin/openssl.exe') : 'openssl'
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true })
  ca = await readFile(join(directory, 'cert.pem'), 'utf8')
  server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: ca }, async (req, res) => {
    requests++; req.socket.once('close', () => closed++)
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    observed = { path: req.url, body: Buffer.concat(chunks).toString(), headers: Object.keys(req.headers) }
    if (mode === 'stall') return
    if (mode === 'redirect') { res.writeHead(307, { location: origin + '/other' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(mode === 'large' ? 'x'.repeat(20000) : JSON.stringify(success))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('TLS fixture unavailable')
  origin = `https://127.0.0.1:${address.port}`
})
afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (directory) await rm(directory, { recursive: true }) })
const snapshot = (): MailSnapshot => ({ format: 'auth-plunk-v1', apiOrigin: origin, path: '/v1/send', projectId: 'fixture', credentialId: 'key-1', idempotencyKey: key, replayWindowSeconds: null, requestJson: JSON.stringify({ to: 'one@example.test', from: { name: 'Product', email: 'auth@example.test' }, subject: 'Your sign-in link', body: '<p>synthetic</p>', reply: 'support@example.test' }) })
function transport() { return createPlunkTransport({ apiOrigin: origin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_synthetic_fixture_only') }, { ca }) }
test('real TLS transport preserves exact bytes, confines headers and never follows redirects or retries', async () => {
  const client = transport(), payload = snapshot()
  try {
    mode = 'ok'; requests = 0
    expect(await client.send(payload, new AbortController().signal, performance.now() + 1000)).toEqual({ state: 'plunk_queued', evidence: 'response_200', emailId: id })
    expect(observed?.path).toBe('/v1/send'); expect(observed?.body === payload.requestJson).toBe(true)
    expect(observed?.headers.sort()).toEqual(['authorization','connection','content-length','content-type','host','idempotency-key'])
    mode = 'redirect'; expect(await client.send(payload, new AbortController().signal, performance.now() + 1000)).toEqual({ state: 'effect_unknown' })
    expect(requests).toBe(2)
    mode = 'large'; expect(await client.send(payload, new AbortController().signal, performance.now() + 1000)).toEqual({ state: 'effect_unknown' })
    expect(requests).toBe(3)
    expect(await client.send({ ...payload, projectId: 'other' }, new AbortController().signal, performance.now() + 1000)).toEqual({ state: 'held' })
    expect(requests).toBe(3)
    expect(await client.send({ ...payload, requestJson: JSON.stringify({ ...JSON.parse(payload.requestJson), template: id }) }, new AbortController().signal, performance.now() + 1000)).toEqual({ state: 'held' })
    expect(requests).toBe(3)
  } finally { await client.close() }
})
test('timeout and cancellation destroy owned requests and close joins actual transport completion', async () => {
  const client = transport(); mode = 'stall'
  try {
    expect(await client.send(snapshot(), new AbortController().signal, performance.now() + 40)).toEqual({ state: 'effect_unknown' })
    const before = closed, pending = client.send(snapshot(), new AbortController().signal, performance.now() + 1000)
    await new Promise(resolve => setTimeout(resolve, 30)); await client.close()
    expect(await pending).toEqual({ state: 'effect_unknown' })
    await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBeGreaterThan(before)
    expect(await client.send(snapshot(), new AbortController().signal, performance.now() + 1000)).toEqual({ state: 'held' })
  } finally { await client.close() }
})
test('pre-connect DNS callback remains owned after request timeout and consumes capacity until actual completion', async () => {
  const original = dns.lookup
  let release!: () => void, callbackReady!: () => void
  const ready = new Promise<void>(resolve => { callbackReady = resolve })
  const spy = vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
    const callback = args[2]
    if (typeof callback !== 'function') throw new Error('Expected request lookup callback')
    original('localhost', { all: true }, (error, addresses) => {
      release = () => callback(error, addresses)
      callbackReady()
    })
  })
  const apiOrigin = origin.replace('127.0.0.1', 'held.example.test')
  const client = createPlunkTransport({ apiOrigin, projectId: 'fixture', credentialId: 'key-1', secret: Redacted.make('sk_synthetic_fixture_only') }, { ca })
  let finished = false, drained = false
  const before = requests
  const pending = client.send({ ...snapshot(), apiOrigin }, new AbortController().signal, performance.now() + 40).then(result => { finished = true; return result })
  try {
    await ready; await new Promise(resolve => setTimeout(resolve, 70))
    expect(finished).toBe(false)
    expect(await client.send({ ...snapshot(), apiOrigin }, new AbortController().signal, performance.now() + 100)).toEqual({ state: 'held' })
    const closing = client.close().then(() => { drained = true })
    await new Promise(resolve => setTimeout(resolve, 10)); expect(drained).toBe(false)
    release(); expect(await pending).toEqual({ state: 'effect_unknown' }); await closing
    expect(requests).toBe(before)
  } finally { release?.(); await client.close(); spy.mockRestore() }
})
