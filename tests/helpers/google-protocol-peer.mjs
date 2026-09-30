// Test-only TLS/dial/DNS instrumentation. Never imported by application code.
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import dns from 'node:dns/promises'
import osDns from 'node:dns'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const hostname = 'oauth2.googleapis.com'
const failure = () => new Error('Google fixture rejected an operation')
const digest = value => createHash('sha256').update(value).digest('base64url')

export async function startGoogleProtocolPeer({ ports = [], wrongHost = false, nativeDns = false, family = 4, holdTls = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'google-protocol-peer-'))
  const config = fileURLToPath(new URL('../fixtures/google-tls.cnf', import.meta.url))
  const openssl = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl'
  const command = async args => { await promisify(execFile)(openssl, args, { windowsHide: true, timeout: 15000 }) }
  const file = name => join(directory, name)
  const sockets = new Set(), clientSockets = new Set(), requests = new Set(), timers = new Set(), handoffs = []
  let server, dnsServer, restore = () => {}, dnsListening = false
  async function removeFiles() {
    const target = await realpath(directory), parent = await realpath(tmpdir())
    if (dirname(target) !== parent || !basename(target).startsWith('google-protocol-peer-')) throw failure()
    await rm(target, { recursive: true })
  }
  async function cleanup(emergency) {
    let timer
    try {
      if (emergency) {
        for (const req of requests) req.destroy()
        for (const socket of [...sockets, ...clientSockets]) socket.destroy()
      }
      for (const deliver of handoffs.splice(0)) deliver()
      for (const timer of timers) clearTimeout(timer)
      const closures = []
      if (server?.listening) closures.push(new Promise(resolve => server.close(resolve)))
      if (dnsListening) closures.push(new Promise(resolve => dnsServer.close(resolve)))
      await Promise.race([Promise.all(closures), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture teardown did not settle')), 1000) })])
    } finally {
      clearTimeout(timer)
      restore()
      await removeFiles()
    }
  }
  try {
  try {
    await command(['req', '-config', config, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '1', '-extensions', 'ca'])
    await command(['req', '-config', config, '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('leaf.key'), '-out', file('leaf.csr')])
    await command(['x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-set_serial', '2', '-out', file('leaf.pem'), '-days', '1', '-extfile', config, '-extensions', wrongHost ? 'wrong' : 'google'])
  } catch { throw new Error('Google fixture certificate setup failed') }
  const ca = await readFile(file('ca.pem'))
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const attempts = new Map()
  const receipts = { tls: 0, posts: 0, pkce: 0, disallowed: 0, dnsStarted: 0, dnsSettled: 0, socketCloses: 0, clientSockets: 0, clientCloses: 0, requests: 0, requestCloses: 0, emergencyCleanup: false, attemptedFamilies: [], requestHeaderBytes: [], requestSocketAssignments: 0 }
  let mode = 'valid', dnsMode = family === 6 ? 'ipv6' : 'ipv4', onPost, onRequestCreated, holdHandoff = false, closing, armed = false
  const delay = (call, ms) => { const timer = setTimeout(() => { timers.delete(timer); call() }, ms); timers.add(timer); return timer }
  const handleRequest = async (request, response) => {
    receipts.posts++
    let headerBytes = 0
    for (let index = 0; index < request.rawHeaders.length; index += 2) headerBytes += Buffer.byteLength(request.rawHeaders[index] + ': ' + request.rawHeaders[index+1] + '\r\n')
    receipts.requestHeaderBytes.push(headerBytes)
    try {
      if (request.method !== 'POST' || request.url !== '/token' || request.headers.host !== hostname || request.headers['accept-encoding'] !== 'identity') throw failure()
      let size = 0; const chunks = []
      for await (const chunk of request) { size += chunk.length; if (size > 65536) throw failure(); chunks.push(chunk) }
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const attempt = attempts.get(body.get('code')); attempts.delete(body.get('code'))
      if (!attempt || body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== attempt.redirectURI
        || digest(body.get('code_verifier') || '') !== attempt.challenge || body.get('client_id') !== 'fixture.apps.googleusercontent.com' || body.get('client_secret') !== 'fixture-only') throw failure()
      receipts.pkce++
      onPost?.()
      const scenario = attempt.scenario ?? mode
      if (scenario === 'headers-held') return
      if (scenario === 'upgrade') { response.writeHead(101, { connection: 'Upgrade', upgrade: 'fixture' }); response.end(); return }
      if (scenario === 'redirect') { response.writeHead(302, { location: 'https://example.test/forbidden' }); response.end(); return }
      if (scenario === 'error-status') { response.writeHead(400); response.end('x'.repeat(65537)); return }
      if (scenario === 'encoding') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end('invalid'); return }
      if (scenario === 'header-excess') { response.writeHead(200, { 'x-excess': 'x'.repeat(16385) }); response.end('{}'); return }
      if (scenario === 'malformed-json') { response.end('{'); return }
      if (scenario === 'error-object') { response.end(JSON.stringify({ error: 'invalid_grant' })); return }
      const claims = { sub: attempt.subject, iss: 'https://accounts.google.com', aud: 'fixture.apps.googleusercontent.com', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), nonce: attempt.nonce, email: attempt.email ?? `${attempt.subject}@example.test`, email_verified: true, name: attempt.name ?? 'Protocol fixture', ...attempt.claims }
      for (const name of attempt.omitClaims ?? []) delete claims[name]
      const header = Buffer.from(JSON.stringify({ alg: attempt.alg ?? 'RS256', typ: 'JWT' })).toString('base64url')
      const unsigned = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
      const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`
      const result = { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, id_token: token, ...attempt.fields }
      let text = JSON.stringify(result)
      if (scenario === 'body-boundary' || scenario === 'body-excess') text += ' '.repeat((scenario === 'body-boundary' ? 65536 : 65537) - Buffer.byteLength(text))
      if (scenario === 'incomplete') { response.writeHead(200, { 'content-length': String(Buffer.byteLength(text)+20) }); response.end(text); return }
      if (scenario === 'body-held') { response.writeHead(200); response.write('{'); return }
      if (scenario === 'trickle') {
        response.writeHead(200); let offset = 0
        const send = () => { if (response.destroyed) return; response.write(text.slice(offset, ++offset)); if (offset < text.length) delay(send, 15); else response.end() }
        send(); return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }); response.end(text)
    } catch { response.writeHead(400); response.end('fixture rejection') }
  }
  server = holdTls ? net.createServer() : https.createServer({ key: await readFile(file('leaf.key')), cert: await readFile(file('leaf.pem')) }, handleRequest)
  server.on('secureConnection', () => { receipts.tls++ })
  server.on('connection', socket => { sockets.add(socket); if (holdTls) socket.resume(); socket.once('close', () => { sockets.delete(socket); receipts.socketCloses++ }) })
  server.on('tlsClientError', () => {})
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, family === 6 ? '::1' : '127.0.0.1', ready) })
  const port = server.address().port
  const allowed = new Set([...ports, port].map(Number))
  dnsServer = nativeDns ? dgram.createSocket('udp4') : undefined
  if (dnsServer) {
    dnsServer.on('message', (query, remote) => {
      let end = 12
      while (end < query.length && query[end] !== 0) end += query[end] + 1
      end += 5
      if (end > query.length) return
      const type = query.readUInt16BE(end-4)
      if (dnsMode === 'held') return
      const status = dnsMode === 'failure' || dnsMode === 'mixed-failure' && type === 28 ? 2 : 0
      const address = type === 1 && dnsMode !== 'absent' && dnsMode !== 'ipv6' ? Buffer.from([127,0,0,1]) : type === 28 && ['ipv6','both'].includes(dnsMode) ? Buffer.from('00000000000000000000000000000001','hex') : null
      const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180 | status, 2); header.writeUInt16BE(address && !status ? 1 : 0, 6); header.writeUInt32BE(0, 8)
      const answer = address && !status ? Buffer.concat([Buffer.from([0xc0,0x0c,0,type,0,1,0,0,0,1,0,address.length]), address]) : Buffer.alloc(0)
      dnsServer.send(Buffer.concat([header, query.subarray(12,end), answer]), remote.port, remote.address)
    })
    await new Promise(resolve => dnsServer.bind(0, '127.0.0.1', () => { dnsListening = true; resolve() }))
  }
  const original = { fetch: globalThis.fetch, tls: tls.connect, request: https.request, lookup: osDns.lookup, connect: net.Socket.prototype.connect, resolve4: dns.Resolver.prototype.resolve4, resolve6: dns.Resolver.prototype.resolve6 }
  const configuredResolvers = new WeakSet()
  const confinedLookups = new WeakSet()
  restore = () => {
    if (!armed) return
    globalThis.fetch = original.fetch; tls.connect = original.tls; https.request = original.request; osDns.lookup = original.lookup; net.Socket.prototype.connect = original.connect
    dns.Resolver.prototype.resolve4 = original.resolve4; dns.Resolver.prototype.resolve6 = original.resolve6; syncBuiltinESMExports(); armed = false
  }
  function arm() {
    if (armed) throw failure(); armed = true
    globalThis.fetch = () => { receipts.disallowed++; throw failure() }
    net.Socket.prototype.connect = function (...args) {
      const normalized = Array.isArray(args[0]) ? args[0] : args
      const first = normalized[0]
      const options = first !== null && typeof first === 'object' ? first : { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' }
      if (options.path || !allowed.has(Number(options.port)) || !['127.0.0.1','::1','localhost',hostname].includes(options.host ?? 'localhost') || options.host === hostname && (Number(options.port) !== port || !confinedLookups.has(options.lookup))) { receipts.disallowed++; throw failure() }
      return Reflect.apply(original.connect, this, args)
    }
    osDns.lookup = function (name, ...args) {
      if (name === hostname || !['127.0.0.1','::1','localhost'].includes(name)) { receipts.disallowed++; throw failure() }
      return Reflect.apply(original.lookup, this, [name, ...args])
    }
    https.request = function (...args) {
      if (String(args[0]) !== `https://${hostname}/token`) { receipts.disallowed++; throw failure() }
      const req = Reflect.apply(original.request, this, args)
      receipts.requests++; requests.add(req)
      req.once('close', () => { requests.delete(req); receipts.requestCloses++ })
      req.once('socket', () => { receipts.requestSocketAssignments++ })
      onRequestCreated?.(req)
      return req
    }
    tls.connect = function (...args) {
      const options = args[0]
      if (args.length !== 1 || !options || typeof options !== 'object' || options.host !== hostname || options.servername !== hostname || Number(options.port) !== 443 || options.rejectUnauthorized !== true || options.socket || options.secureContext || options.checkServerIdentity !== tls.checkServerIdentity || typeof options.lookup !== 'function' || options.family !== 0 || options.autoSelectFamily !== true) { receipts.disallowed++; throw failure() }
      const confinedLookup = (name, settings, callback) => {
        if (name !== hostname || settings.all !== true || settings.family !== 0) { receipts.disallowed++; callback(failure()); return }
        options.lookup(name, settings, (error, addresses) => {
          if (error) { callback(error); return }
          if (!Array.isArray(addresses) || !addresses.length || addresses.some(value => !['127.0.0.1','::1'].includes(value.address) || net.isIP(value.address) !== value.family)) { receipts.disallowed++; callback(failure()); return }
          if (holdHandoff) handoffs.push(() => callback(null, addresses))
          else callback(null, addresses)
        })
      }
      confinedLookups.add(confinedLookup)
      // Preserve logical host and lookup. Only destination port/trust are doubled.
      const socket = original.tls({ ...options, port, ca, lookup: confinedLookup })
      receipts.clientSockets++; clientSockets.add(socket)
      socket.on('connectionAttempt', (_address, _port, family) => { receipts.attemptedFamilies.push(family) })
      socket.once('close', () => { clientSockets.delete(socket); receipts.clientCloses++ })
      return socket
    }
    for (const [name, family] of [['resolve4',4],['resolve6',6]]) {
      dns.Resolver.prototype[name] = async function (nameToResolve, options) {
        if (nameToResolve !== hostname || options !== undefined) { receipts.disallowed++; throw failure() }
        receipts.dnsStarted++
        try {
          if (dnsServer) {
            if (!configuredResolvers.has(this)) { this.setServers([`127.0.0.1:${dnsServer.address().port}`]); configuredResolvers.add(this) }
            return await Reflect.apply(family === 4 ? original.resolve4 : original.resolve6, this, [nameToResolve])
          }
          if (family === 4) return ['127.0.0.1']
          throw Object.assign(failure(), { code: 'ENODATA' })
        } finally { receipts.dnsSettled++ }
      }
    }
    syncBuiltinESMExports()
  }
  arm()
  return {
    register(authorizeURL, subject = randomUUID(), options = {}) {
      if (attempts.size >= 128) throw failure()
      const url = new URL(authorizeURL), nonce = url.searchParams.get('nonce'), challenge = url.searchParams.get('code_challenge'), redirectURI = url.searchParams.get('redirect_uri')
      if (url.origin !== 'https://accounts.google.com' || !nonce || !challenge || !redirectURI || url.searchParams.get('code_challenge_method') !== 'S256') throw failure()
      const code = randomUUID(); attempts.set(code, { subject, nonce, challenge, redirectURI, ...options }); return code
    },
    allowPort(value) { allowed.add(Number(value)) },
    holdHandoff() { holdHandoff = true },
    releaseHandoff() { holdHandoff = false; for (const deliver of handoffs.splice(0)) deliver() },
    onRequestCreated(call) { onRequestCreated = call },
    setMode(value) { mode = value }, setDnsMode(value) { dnsMode = value }, onPost(call) { onPost = call },
    evidence() { return { ...receipts, activeSockets: sockets.size, activeClientSockets: clientSockets.size, activeRequests: requests.size, pendingAttempts: attempts.size, pendingHandoffs: handoffs.length, nativeDns } },
    close() {
      return closing ??= (async () => {
        // Never rescue missing application cleanup by destroying peer sockets.
        let cleanupFailure
        try {
        if (clientSockets.size || requests.size) throw new Error('Application client ownership has not settled')
        if (sockets.size) {
          let timer
          try {
            await Promise.race([
              Promise.all([...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)))),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Google application sockets have not closed')), 1000) }),
            ])
          } finally { clearTimeout(timer) }
        }
        } catch (error) { cleanupFailure = error; receipts.emergencyCleanup = true }
        finally { attempts.clear(); await cleanup(Boolean(cleanupFailure)) }
        if (cleanupFailure) throw cleanupFailure
      })()
    },
  }
  } catch (error) { await cleanup(true); throw error }
}
