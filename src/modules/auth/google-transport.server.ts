import { Resolver } from 'node:dns/promises'
import { Agent, request, type RequestOptions } from 'node:https'
import type { ClientRequest } from 'node:http'
import { isIP, type LookupFunction, type Socket, type TcpNetConnectOpts } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { authorizationCodeRequest } from 'better-auth/oauth2'

const hostname = 'oauth2.googleapis.com'
const tokenEndpoint = `https://${hostname}/token`
const unavailable = () => new Error('Google authentication unavailable')
export type GoogleExchangeLifetime = Readonly<{
  deadlineAtMs: number; cleanupTimeoutMs: number; signal: AbortSignal
  assert(): void
}>
type CodeInput = Omit<Parameters<typeof authorizationCodeRequest>[0], 'tokenEndpoint'>
type Exchange = { cancel(): void; joined: Promise<void> }

export function createGoogleTransport() {
  const active = new Set<Exchange>()
  let closed = false, closing: Promise<void> | undefined
  function assertOpen() { if (closed) throw unavailable() }
  function exchange(input: CodeInput, lifetime: GoogleExchangeLifetime): Promise<unknown> {
    assertOpen(); lifetime.assert()
    if (active.size >= 4) throw unavailable()
    const resolver = new Resolver()
    const sockets = new Set<Socket>(), socketJoins: Promise<void>[] = []
    let req: ClientRequest | undefined, requestJoin: Promise<void> | undefined
    let dnsJoin: Promise<void> | undefined, httpJoin: Promise<void> | undefined
    let cancelled = false, cleanupExpired = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    function startCleanup() {
      cleanupTimer ??= setTimeout(() => { cleanupExpired = true }, lifetime.cleanupTimeoutMs)
    }
    function cancel() {
      cancelled = true; startCleanup(); resolver.cancel()
      req?.destroy(unavailable())
      for (const socket of sockets) socket.destroy()
    }
    function assert() {
      assertOpen(); lifetime.assert()
      if (cancelled || lifetime.signal.aborted || Date.now() >= lifetime.deadlineAtMs) throw unavailable()
    }
    const lookup: LookupFunction = (name, options, callback) => {
      // Node adds ADDRCONFIG on non-Windows. This DNS-only bridge deliberately
      // does not implement OS interface filtering or hosts/NSS resolution.
      if (name !== hostname || options.all !== true || options.family !== 0 || dnsJoin) { callback(unavailable(), '', 0); return }
      const resolve = async (family: 4 | 6) => {
        try {
          assert()
          const values = family === 4 ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname)
          if (!values.length || values.some(address => isIP(address) !== family)) throw unavailable()
          return values.map(address => ({ address, family }))
        } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return []
          cancel(); throw unavailable()
        }
      }
      // Both original operations are retained, including cancellation outcomes.
      const queries = [resolve(6), resolve(4)]
      dnsJoin = (async () => {
        const results = await Promise.allSettled(queries)
        try {
          assert()
          if (results.some(result => result.status === 'rejected')) throw unavailable()
          const addresses = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
          if (!addresses.length) throw unavailable()
          callback(null, addresses)
        } catch { callback(unavailable(), '', 0) }
      })()
    }
    const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 })
    const deadlineTimer = setTimeout(cancel, Math.max(0, lifetime.deadlineAtMs - Date.now()))
    lifetime.signal.addEventListener('abort', cancel, { once: true })
    let finishJoin!: () => void, rejectJoin!: (error: Error) => void
    const handle: Exchange = { cancel, joined: new Promise<void>((resolve, reject) => { finishJoin = resolve; rejectJoin = reject }) }
    // Charge before calling the asynchronous public native request builder.
    active.add(handle)
    void handle.joined.catch(() => {})
    return (async () => {
      try {
        assert()
        const native = await authorizationCodeRequest({ code: input.code, codeVerifier: input.codeVerifier, redirectURI: input.redirectURI, options: input.options, tokenEndpoint })
        assert()
        const body = Buffer.from(native.body.toString(), 'utf8')
        if (body.length > 65536) throw unavailable()
        const headers = { ...native.headers, host: hostname, 'accept-encoding': 'identity', 'content-length': String(body.length), connection: 'close' }
        const headerBytes = Object.entries(headers).reduce((total, [key, value]) => total + Buffer.byteLength(`${key}: ${value}\r\n`, 'utf8'), 0)
        // POST /token HTTP/1.1 CRLF and the final CRLF are fixed framing (24B).
        if (headerBytes > 16384) throw unavailable()
        const received = new Promise<Buffer>((resolve, reject) => {
          const options: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'> = { method: 'POST', headers, agent, lookup, family: 0, autoSelectFamily: true,
            servername: hostname, rejectUnauthorized: true, checkServerIdentity, maxHeaderSize: 16384 }
          req = request(tokenEndpoint, options, response => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { reject(unavailable()); cancel(); return }
            let size = 0; const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => {
              try { assert(); if (size + chunk.length > 65536) throw unavailable(); size += chunk.length; chunks.push(chunk) }
              catch { reject(unavailable()); cancel() }
            })
            response.once('error', () => reject(unavailable()))
            response.once('aborted', () => reject(unavailable()))
            response.once('end', () => {
              try { assert(); if (!response.complete) throw unavailable(); resolve(Buffer.concat(chunks, size)) }
              catch { reject(unavailable()); cancel() }
            })
          })
          requestJoin = new Promise<void>(resolve => req!.once('close', resolve))
          req.once('error', () => reject(unavailable()))
          req.once('upgrade', (_response, socket) => { socket.destroy(); reject(unavailable()); cancel() })
          req.on('socket', socket => {
            sockets.add(socket)
            socketJoins.push(new Promise<void>(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
            if (cancelled) socket.destroy()
          })
          req.end(body)
        })
        httpJoin = received.then(() => {}, () => {})
        const bytes = await received
        assert()
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const result: unknown = JSON.parse(text)
        assert()
        return result
      } catch { cancel(); throw unavailable() }
      finally {
        startCleanup(); resolver.cancel(); req?.destroy(); agent.destroy()
        for (const socket of sockets) socket.destroy()
        await Promise.all([dnsJoin, httpJoin, requestJoin, ...socketJoins])
        clearTimeout(deadlineTimer); clearTimeout(cleanupTimer)
        lifetime.signal.removeEventListener('abort', cancel)
        active.delete(handle)
        if (cleanupExpired) { rejectJoin(unavailable()); throw unavailable() }
        finishJoin()
      }
    })().then(result => { assert(); return result })
  }
  function close() {
    if (closing) return closing
    closed = true
    const handles = [...active]
    for (const handle of handles) handle.cancel()
    return closing = Promise.allSettled(handles.map(handle => handle.joined)).then(results => {
      if (results.some(result => result.status === 'rejected')) throw unavailable()
    })
  }
  return { exchange, assertOpen, close }
}
