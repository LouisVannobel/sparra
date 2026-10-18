// Test-only TLS boundary. The real Stripe SDK, HTTP parser and native sockets run.
import https, { type Server } from 'node:https'
import tls, { type TLSSocket } from 'node:tls'
import net, { type Socket } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'

type Reply = { status?: number; body?: unknown; hold?: 'headers' | 'body'; closeBeforeHeaders?: boolean; location?: string }
export type FinancialRequest = Readonly<{ method: string; path: string; body: string; authorized: boolean;
  apiVersion: string | undefined; accountHeader: boolean; contextHeader: boolean; idempotencyKey: string | undefined }>

export async function startStripeFinancialPeer(options: { holdTls?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sparra-stripe-financial-'))
  const sockets = new Set<Socket>(), clients = new Set<TLSSocket>()
  const requests = new Set<IncomingMessage>(), responses = new Set<ServerResponse>()
  const observed: FinancialRequest[] = [], replies = new Map<string, Reply>()
  let server: Server | net.Server | undefined, restore = () => {}, closing: Promise<void> | undefined
  const forbidden = () => new Error('Owned Stripe fixture refused an external transport')
  const evidence = () => ({ clientSockets: clients.size, serverSockets: sockets.size, requests: requests.size, responses: responses.size })
  function close() {
    return closing ??= (async () => {
      const unsafe = clients.size > 0 || requests.size > 0 || responses.size > 0
      // A test must assert closure before retirement. Emergency destruction is
      // only teardown after failure and can never manufacture a passing receipt.
      if (unsafe) {
        for (const response of responses) response.destroy()
        for (const request of requests) request.destroy()
        for (const socket of [...clients, ...sockets]) socket.destroy()
      }
      try {
        if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
      } finally {
        restore()
        const target = await realpath(directory), parent = await realpath(tmpdir())
        if (dirname(target) !== parent || !basename(target).startsWith('sparra-stripe-financial-')) throw new Error('Owned TLS cleanup target rejected')
        await rm(target, { recursive: true })
      }
      if (unsafe) throw new Error('Stripe application transport was still active before fixture retirement')
    })()
  }
  try {
    const executable = process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl'
    await promisify(execFile)(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1',
      '-subj', '/CN=api.stripe.com', '-addext', 'subjectAltName=DNS:api.stripe.com'], { windowsHide: true, timeout: 15000 })
    const certificate = await readFile(join(directory, 'cert.pem'))
    const key = await readFile(join(directory, 'key.pem'))
    server = options.holdTls ? net.createServer(socket => socket.resume()) : https.createServer({ cert: certificate, key }, (request, response) => {
      requests.add(request); responses.add(response)
      response.once('close', () => { requests.delete(request); responses.delete(response) })
      request.on('error', () => {})
      void (async () => {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 65536) throw forbidden()
          chunks.push(Buffer.from(chunk))
        }
        const path = request.url ?? ''
        observed.push({ method: request.method ?? '', path, body: Buffer.concat(chunks).toString('utf8'),
          authorized: request.headers.authorization === 'Bearer sk_test_fixture', apiVersion: request.headers['stripe-version']?.toString(),
          accountHeader: request.headers['stripe-account'] !== undefined, contextHeader: request.headers['stripe-context'] !== undefined,
          idempotencyKey: request.headers['idempotency-key']?.toString() })
        const reply = replies.get(path) ?? { body: path === '/v1/account' ? { id: 'acct_fixture', object: 'account' }
          : path === '/v1/customers' ? { id: 'cus_fixture', object: 'customer', livemode: false } : {} }
        if (reply.closeBeforeHeaders) { request.socket.destroy(); return }
        if (reply.hold === 'headers') return
        response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.location ? { location: reply.location } : {}) })
        if (reply.hold === 'body') { response.write('{'); return }
        response.end(JSON.stringify(reply.body ?? {}))
      })().catch(() => response.destroy())
    })
    server.on('connection', (socket: Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw forbidden()
    const realConnect = tls.connect
    const connect = (selected: tls.ConnectionOptions | number, listener?: (() => void) | tls.ConnectionOptions | string): TLSSocket => {
      if (typeof selected === 'number' || listener !== undefined && typeof listener !== 'function'
        || selected.host !== 'api.stripe.com' || selected.servername !== 'api.stripe.com' || Number(selected.port) !== 443
        || selected.socket !== undefined || selected.rejectUnauthorized === false) throw forbidden()
      const socket = realConnect({ ...selected, host: '127.0.0.1', port: address.port, ca: certificate }, listener)
      clients.add(socket); socket.once('close', () => clients.delete(socket))
      return socket
    }
    const redirect = vi.spyOn(tls, 'connect').mockImplementation(connect)
    // The old unowned financial NodeHttpClient must fail locally during RED;
    // it is never allowed to fall through to api.stripe.com on this fixture.
    const blockUnowned = vi.spyOn(https, 'request').mockImplementation(() => { throw forbidden() })
    restore = () => { blockUnowned.mockRestore(); redirect.mockRestore() }
    return { setReply: (path: string, reply: Reply) => replies.set(path, reply), requests: () => [...observed], evidence, close }
  } catch (error) { await close(); throw error }
}
