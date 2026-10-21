// Offline Google wire peer. The application's own Undici Agent and TLS parser run.
import https from 'node:https'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const hosts = ['oauth2.googleapis.com', 'www.googleapis.com', 'openidconnect.googleapis.com']
const scopes = ['openid', 'email', ...['calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events'].map(value => 'https://www.googleapis.com/auth/' + value)]
export async function startCalendarProtocolPeer() {
  const directory = await mkdtemp(join(tmpdir(), 'sparra-calendar-peer-'))
  const clients = new Set(), sockets = new Set(), pending = new Set(), attempts = new Map(), events = new Map(), observed = []
  const original = tls.connect
  let server, closing, mode = 'normal', refreshMode = 'existing', disallowed = 0, emergencyCleanup = false
  const refuse = () => { disallowed++; return new Error('Calendar peer refused an operation') }
  const evidence = () => ({ posts: observed.filter(value => value.method === 'POST').length, tls: observed.length, disallowed,
    activeClientSockets: clients.size, activeSockets: sockets.size, activeRequests: pending.size, emergencyCleanup })
  async function close() {
    return closing ??= (async () => {
      // Destruction after a failed ownership assertion is never a passing receipt.
      emergencyCleanup = clients.size !== 0 || pending.size !== 0
      if (emergencyCleanup) for (const socket of [...clients, ...sockets]) socket.destroy()
      try { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
      finally {
        tls.connect = original; syncBuiltinESMExports()
        const target = await realpath(directory), parent = await realpath(tmpdir())
        if (dirname(target) !== parent || !basename(target).startsWith('sparra-calendar-peer-')) throw refuse()
        await rm(target, { recursive: true })
      }
      if (emergencyCleanup) throw new Error('Calendar transport still active before peer retirement')
    })()
  }
  try {
    const executable = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl'
    await promisify(execFile)(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=www.googleapis.com', '-addext', 'subjectAltName=' + hosts.map(host => 'DNS:' + host).join(',')], { windowsHide: true, timeout: 15000 })
    const cert = await readFile(join(directory, 'cert.pem')), key = await readFile(join(directory, 'key.pem'))
    const signing = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwk = signing.publicKey.export({ format: 'jwk' })
    let subject = 'calendar-owner'
    const reply = (response, body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    async function acquireRequest(request) {
      const chunks = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw refuse(); chunks.push(chunk) }
      const body = Buffer.concat(chunks).toString('utf8'), path = request.url, host = request.headers.host
      if (!hosts.includes(host) || observed.length >= 256) throw refuse()
      observed.push({ host, path, method: request.method, body })
      return { body, path, host }
    }
    function handleTokenRequest(response,body) {
      const fields=new URLSearchParams(body),attempt=attempts.get(fields.get('code'))
      attempts.delete(fields.get('code'))
      if(fields.get('client_id')!=='fixture-calendar-client'||fields.get('client_secret')!=='fixture-only')throw refuse()
      const refresh=fields.get('grant_type')==='refresh_token'
      if(fields.get('grant_type')==='authorization_code') {
        if(!attempt||fields.get('redirect_uri')!==attempt.redirect||createHash('sha256').update(fields.get('code_verifier')??'').digest('base64url')!==attempt.challenge)throw refuse()
        subject=attempt.subject
      } else if(fields.get('grant_type')!=='refresh_token'||fields.get('refresh_token')!=='fixture-refresh')throw refuse()
      const unsigned=[JSON.stringify({alg:'RS256',kid:'calendar-peer'}),JSON.stringify({iss:'https://accounts.google.com',aud:'fixture-calendar-client',sub:subject,...(attempt?{nonce:attempt.nonce}:{}),exp:Math.floor(Date.now()/1000)+300})].map(value=>Buffer.from(value).toString('base64url')).join('.')
      reply(response,{access_token:'fixture-access',...(refresh&&refreshMode==='retained'?{}:{refresh_token:refresh&&refreshMode==='rotated'?'fixture-refresh-rotated':'fixture-refresh'}),token_type:'Bearer',expires_in:3600,scope:scopes.join(' '),id_token:unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),signing.privateKey).toString('base64url')})
    }
    function handleUserInfo(request,response,host,path) {
      if(request.headers.authorization!=='Bearer fixture-access')throw refuse()
      if(host==='openidconnect.googleapis.com'&&path==='/v1/userinfo'&&request.method==='GET') {reply(response,{sub:subject,email:'calendar-owner@example.test',email_verified:true});return true}
      return false
    }
    function handleOAuth(request, response, { body, path, host }) {
      if (host === 'oauth2.googleapis.com' && path === '/token' && request.method === 'POST') {handleTokenRequest(response,body);return true}
      if (host === 'www.googleapis.com' && path === '/oauth2/v3/certs' && request.method === 'GET') { reply(response, { keys: [{ ...jwk, kid: 'calendar-peer', alg: 'RS256', use: 'sig' }] }); return true }
      if (host === 'oauth2.googleapis.com' && path === '/revoke' && request.method === 'POST') { reply(response, {}); return true }
      return handleUserInfo(request,response,host,path)
    }
    function insertCalendarEvent(request,response,body) {
      const value=JSON.parse(body)
      if(Object.keys(value).sort().join()!=='description,end,extendedProperties,id,start,summary'||!/^sparra[0-9a-f]{32}$/.test(value.id)||events.size>=8)throw refuse()
      if(events.has(value.id))return reply(response,{},409)
      events.set(value.id,{...value,status:'confirmed'})
      if(mode==='hold-insert')return
      if(mode==='lose-insert'){request.socket.destroy();return}
      return reply(response,events.get(value.id))
    }
    function handleCalendarEvents(request,response,path,body) {
      if(path==='/calendar/v3/calendars/fixture-calendar/events?sendUpdates=none'&&request.method==='POST')return insertCalendarEvent(request,response,body)
      const match = /^\/calendar\/v3\/calendars\/fixture-calendar\/events\/(sparra[0-9a-f]{32})$/.exec(path)
      if (match && request.method === 'GET') return reply(response, events.get(match[1]) ?? {}, events.has(match[1]) ? 200 : 404)
      throw refuse()
    }
    function handleCalendar(request, response, { body, path, host }) {
      if (host !== 'www.googleapis.com') throw refuse()
      if (path === '/calendar/v3/users/me/calendarList?maxResults=250' && request.method === 'GET') return reply(response, { items: ['fixture-calendar', 'fixture-calendar-b'].map(id => ({ id, summary: 'Agenda de qualification', timeZone: 'Europe/Paris', accessRole: 'owner' })) })
      if (path === '/calendar/v3/freeBusy' && request.method === 'POST') {
        const value = JSON.parse(body)
        if (JSON.stringify(value.items) !== '[{"id":"fixture-calendar"}]' || Object.keys(value).sort().join() !== 'items,timeMax,timeMin') throw refuse()
        return reply(response, { calendars: { 'fixture-calendar': { busy: [] } } })
      }
      return handleCalendarEvents(request,response,path,body)
    }
    server = https.createServer({ cert, key }, (request, response) => {
      pending.add(response); response.once('close', () => pending.delete(response)); request.on('error', () => {})
      void (async () => {
        const acquired = await acquireRequest(request)
        if (mode === 'hold-headers') return
        if (mode === 'hold-body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return }
        if (!handleOAuth(request, response, acquired)) handleCalendar(request, response, acquired)
      })().catch(() => response.destroy())
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
    server.on('tlsClientError', () => {})
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    tls.connect = function (options, listener) {
      if (!options || typeof options !== 'object' || !hosts.includes(options.host) || options.servername !== options.host || Number(options.port) !== 443 || options.socket || options.rejectUnauthorized === false || options.checkServerIdentity && options.checkServerIdentity !== tls.checkServerIdentity) throw refuse()
      const socket = original({ ...options, host: '127.0.0.1', port, ca: cert }, listener)
      clients.add(socket); socket.once('close', () => clients.delete(socket)); return socket
    }
    syncBuiltinESMExports()
    return { close, evidence, allowPort() {}, requests: () => [...observed], events: () => [...events.values()], setMode(value) { if (!['normal', 'hold-headers', 'hold-body', 'lose-insert', 'hold-insert'].includes(value)) throw refuse(); mode = value },
      setRefreshMode(value) {if(!['retained','rotated'].includes(value))throw refuse();refreshMode=value},
      changeEvent(id, change) {
        const event = events.get(id)
        if (!event || !['cancelled', 'moved'].includes(change)) throw refuse()
        events.set(id, change === 'cancelled' ? { ...event, status: 'cancelled' } : { ...event,
          start: { ...event.start, dateTime: new Date(Date.parse(event.start.dateTime) + 86400000).toISOString() },
          end: { ...event.end, dateTime: new Date(Date.parse(event.end.dateTime) + 86400000).toISOString() } })
      },
      register(authorize, selectedSubject) {
        const url = new URL(authorize), fields = url.searchParams
        if (url.origin !== 'https://accounts.google.com' || fields.get('client_id') !== 'fixture-calendar-client' || fields.get('code_challenge_method') !== 'S256' || !fields.get('nonce') || !fields.get('code_challenge') || attempts.size >= 8) throw refuse()
        const code = randomUUID(); attempts.set(code, { subject: selectedSubject, nonce: fields.get('nonce'), challenge: fields.get('code_challenge'), redirect: fields.get('redirect_uri') }); return code
      } }
  } catch (error) { await close(); throw error }
}
