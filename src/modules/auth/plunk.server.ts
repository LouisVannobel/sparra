import { request } from 'node:https'
import type { ClientRequest } from 'node:http'
import dns from 'node:dns'
import type { LookupFunction } from 'node:net'
import { Redacted, Schema } from 'effect'
import { readWebConfig } from '../../platform/config.server'
import { validatePlunkRequestJson, type MailSnapshot } from './mail-snapshot.server'

export type PlunkResult = { state: 'effect_unknown' | 'held' } | { state: 'plunk_queued'; evidence: 'response_200' | 'duplicate_409'; emailId: string | null }
export type PlunkBinding = Readonly<{ apiOrigin: string; projectId: string; credentialId: string; secret: Redacted.Redacted<string> }>
const uuid = Schema.String.check(Schema.isUUID())
const timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/))
const queued = Schema.Struct({ success: Schema.Literal(true), data: Schema.Struct({ emails: Schema.Array(Schema.Struct({ contact: Schema.Struct({ id: uuid, email: Schema.String }), email: uuid })).check(Schema.isMinLength(1), Schema.isMaxLength(1)), timestamp }) })
const duplicate = Schema.Struct({ success: Schema.Literal(false), timestamp, error: Schema.Struct({ code: Schema.Literal('IDEMPOTENCY_KEY_REUSED'), statusCode: Schema.Literal(409), message: Schema.String, details: Schema.Struct({ key: Schema.String, originalRequest: Schema.Literal('POST /v1/send'), originalRequestAt: timestamp, originalStatusCode: Schema.Literal(200) }) }) })
export function classifyPlunkResult(status: number, input: unknown, idempotencyKey: string, recipient: string): PlunkResult {
  try {
    if (status === 200) {
      const result = Schema.decodeUnknownSync(queued)(input)
      if (result.data.emails[0].contact.email === recipient) return { state: 'plunk_queued', evidence: 'response_200', emailId: result.data.emails[0].email }
    }
    if (status === 409 && Schema.decodeUnknownSync(duplicate)(input).error.details.key === idempotencyKey) return { state: 'plunk_queued', evidence: 'duplicate_409', emailId: null }
  } catch {}
  return { state: 'effect_unknown' }
}

// Own the Node request and its close receipt. No agent pooling, redirects,
// implicit retries, fetch globals or ambient tracing/headers are involved.
export function createPlunkTransport(binding: PlunkBinding, tls: { ca?: string } = {}) {
  const config = { ...binding }
  try {
    if (readWebConfig({ NODE_ENV: 'production', APP_ORIGIN: config.apiOrigin }).origin !== config.apiOrigin) throw new Error()
    Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^sk_[A-Za-z0-9_-]{1,256}$/)))(Redacted.value(config.secret))
  } catch { throw new Error('Auth mail provider configuration rejected') }
  let stopping = false
  const requests = new Map<ClientRequest, Promise<PlunkResult>>()
  async function send(snapshot: MailSnapshot, signal: AbortSignal, deadlineAt: number): Promise<PlunkResult> {
    const timeoutMs = Math.floor(deadlineAt - performance.now())
    if (stopping || requests.size >= 1 || signal.aborted || snapshot.apiOrigin !== config.apiOrigin || snapshot.projectId !== config.projectId || snapshot.credentialId !== config.credentialId
      || snapshot.path !== '/v1/send' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || Buffer.byteLength(snapshot.requestJson) > 16384 || !/^auth-email-delivery:[0-9a-f-]{36}$/.test(snapshot.idempotencyKey)) return { state: 'held' }
    let recipient: string
    try { recipient = validatePlunkRequestJson(snapshot.requestJson).to }
    catch { return { state: 'held' } }
    let req: ClientRequest
    let result: PlunkResult = { state: 'effect_unknown' }
    let finish!: (value: PlunkResult) => void
    const done = new Promise<PlunkResult>(resolve => { finish = resolve })
    const owned: Promise<void>[] = []
    const expired = () => signal.aborted || stopping || performance.now() >= deadlineAt
    const lookup: LookupFunction = (hostname, options, callback) => {
      let complete!: () => void
      owned.push(new Promise<void>(resolve => { complete = resolve }))
      // dns.lookup has no cancellation API. Keep the native callback owned even
      // after a deadline destroys its socket; never treat request close as DNS drain.
      const expiredError = () => new Error('Auth mail request deadline expired')
      if (options.all) dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        try { callback(expired() ? expiredError() : error, addresses) } finally { complete() }
      })
      else dns.lookup(hostname, { ...options, all: false }, (error, address, family) => {
        try { callback(expired() ? expiredError() : error, address, family) } finally { complete() }
      })
    }
    try {
      req = request(config.apiOrigin + '/v1/send', { method: 'POST', agent: false, ca: tls.ca, lookup, maxHeaderSize: 8192,
        headers: { authorization: `Bearer ${Redacted.value(config.secret)}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(snapshot.requestJson), 'idempotency-key': snapshot.idempotencyKey } })
    } catch { return result }
    const abort = () => req.destroy()
    const timer = setTimeout(abort, Math.max(1, deadlineAt - performance.now()))
    signal.addEventListener('abort', abort, { once: true })
    requests.set(req, done)
    req.once('socket', socket => {
      owned.push(new Promise<void>(resolve => { if (socket.closed) resolve(); else socket.once('close', () => resolve()) }))
      // Do not queue auth headers/body while DNS, TCP or TLS can still stall.
      // The absolute deadline is checked again immediately before HTTP writing.
      socket.once('secureConnect', () => {
        if (expired()) abort()
        else req.end(snapshot.requestJson)
      })
    })
    req.on('error', () => {})
    req.once('response', res => {
      let size = 0
      const chunks: Buffer[] = []
      res.on('error', () => {})
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 16384) { res.destroy(); req.destroy(); return }
        chunks.push(chunk)
      })
      res.once('end', () => {
        if (size <= 16384 && /^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) {
          try { result = classifyPlunkResult(res.statusCode ?? 0, JSON.parse(Buffer.concat(chunks).toString('utf8')), snapshot.idempotencyKey, recipient) } catch {}
        }
        for (const chunk of chunks) chunk.fill(0)
      })
    })
    req.once('close', () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      void Promise.all(owned).then(() => { requests.delete(req); finish(result) })
    })
    if (expired()) abort()
    return done
  }
  async function close() {
    stopping = true
    const pending = [...requests.values()]
    for (const req of requests.keys()) req.destroy()
    await Promise.all(pending)
  }
  return { send, close }
}
