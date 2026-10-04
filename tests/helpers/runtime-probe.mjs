// Test-only instrumentation of the actual built Node listener. Never bundled.
import { Server } from 'node:http'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let googlePeer
// Install before importing any emitted application module.
if (process.env.FIXTURE_GOOGLE_PROTOCOL === 'yes') {
  const { startGoogleProtocolPeer } = await import('./google-protocol-peer.mjs')
  googlePeer = await startGoogleProtocolPeer({ ports: [process.env.DATABASE_URL, process.env.REDIS_URL].map(value => Number(new URL(value).port)), wrongHost: process.env.FIXTURE_GOOGLE_WRONG_HOST === 'yes' })
  process.send?.({ type: 'google-ready' })
}

// Test-only consumer appended to the actual emitted Start middleware. Its
// Request arrives through the real Nitro node socket and SSR bundle bridge.
const directory = resolve('.output/server/_ssr')
const compiled = await import(pathToFileURL(resolve(directory, 'ssr.mjs')).href)
const { createMiddleware } = compiled
if (process.env.FIXTURE_INGRESS === 'yes') {
  const entry = compiled.default ?? compiled.server_default
  const originalFetch = entry.fetch
  entry.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (new URL(args[0].url).pathname === '/__fixture_ingress_wait') {
      process.send?.({ type: 'ingress-response', status: response.status })
    }
    return response
  }
}
const startFile = (await readdir(directory)).find(name => /^start-.*\.mjs$/.test(name))
const { startInstance } = await import(pathToFileURL(resolve(directory, startFile)).href)
const originalOptions = startInstance.getOptions.bind(startInstance)
const identities = new WeakMap()
let effects = 0
let nextId = 0
const ingressSnapshots = new WeakMap()
const ingressEvents = new WeakMap()
let ingressEventCount = 0
startInstance.getOptions = async () => {
  const options = await originalOptions()
  return { ...options, requestMiddleware: [...(options.requestMiddleware ?? []), createMiddleware().server(async ({ request, next }) => {
    const path = new URL(request.url).pathname
    if (path.startsWith('/__fixture_ingress')) {
      const node = request.runtime?.node?.req
      const raw = ingressSnapshots.get(node)
      const h3 = ingressEvents.get(node)
      const expected = process.env.APP_ORIGIN + raw?.target
      const beforeBody = !request.bodyUsed
      if (path === '/__fixture_ingress_stream') return ingressStreamResponse()
      if (path === '/__fixture_ingress_wait') return waitForIngressCancellation(request)
      return observeIngressRequest(request, node, raw, h3, expected, beforeBody)
    }
    if (path === '/' && process.env.FIXTURE_ROOT_RESPONSE) return controlledRootResponse()
    if (path !== '/__fixture_resources' && path !== '/__fixture_auth') return next()
    const resources = request.context?.appResources
    if (!resources) return new Response('Missing request carrier', { status: 500 })
    if (!identities.has(resources)) identities.set(resources, ++nextId)
    if (path === '/__fixture_resources') return observeResources(resources)
    return consumeFixtureAuthAttempt(request, resources)
  })] }
}

function ingressStreamResponse() {
  let timer
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('started'))
      timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('finished')); controller.close() }, 250)
    },
    cancel() { clearTimeout(timer) },
  })
  const headers = new Headers({ 'content-type': 'text/plain' })
  headers.append('set-cookie', 'fixture_a=1'); headers.append('set-cookie', 'fixture_b=2')
  return new Response(body, { headers })
}

async function waitForIngressCancellation(request) {
  await new Promise(resolve => request.signal.aborted ? resolve() : request.signal.addEventListener('abort', resolve, { once: true }))
  process.send?.({ type: 'ingress-cancelled' })
  return new Response('cancelled')
}

async function observeIngressRequest(request, node, raw, h3, expected, beforeBody) {
  const inner = request._request
  const text = request.method === 'POST' ? await inner.text() : ''
  const real = node?.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'x-real-ip').length
  return Response.json({
    carrier: h3?.request === request, socket: raw?.socket === node?.socket,
    rawTarget: node?.url === raw?.target, urls: request.url === expected && request._url.href === expected && h3?.url === expected && inner.url === expected,
    realIp: real === 1 && node.headers['x-real-ip'] === request.headers.get('x-real-ip') && inner.headers.get('x-real-ip') === request.headers.get('x-real-ip'),
    clientIp: request.headers.get('x-real-ip'),
    hintsGone: ![...request.headers.keys(), ...inner.headers.keys(), ...Object.keys(node.headers), ...node.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase())].some(name => /^(forwarded|client-ip|true-client-ip|cf-connecting-ip|tailscale-ingress-src|x-vercel-)/.test(name)),
    browserMetadata: ['origin','referer','sec-fetch-site'].every(name => request.headers.get(name) === (raw?.headers[name] ?? null)),
    beforeBody, afterBody: request.method !== 'POST' || request.bodyUsed, method: request.method, text,
    deadline: typeof request.appAuthDeadlineAtMs === 'number', nonce: typeof request.appCspNonce === 'string',
  })
}

function controlledRootResponse() {
  if (process.env.FIXTURE_ROOT_RESPONSE === 'error') return new Response('<h1>Controlled error</h1>', { status: 500, headers: { 'content-type': 'text/html' } })
  if (process.env.FIXTURE_ROOT_RESPONSE === 'json') return Response.json({ fixture: true })
  if (process.env.FIXTURE_ROOT_RESPONSE === 'redirect') return new Response(null, { status: 302, headers: { location: '/login', 'content-type': 'text/html' } })
  throw new Error('Unknown root response fixture')
}

function observeResources(resources) {
  return Response.json({ resourceId: identities.get(resources), ready: resources.isReady(), effects, ...(process.env.FIXTURE_INGRESS === 'yes' ? { ingressEventCount } : {}) })
}

async function consumeFixtureAuthAttempt(request, resources) {
  const client = resources.limiter.trustedClientContext(request)
  await resources.limiter.consumeAuthAttempt('beginGoogleSignIn', client)
  effects++
  return new Response('effect reached', { status: 201 })
}

const originalEmit = Server.prototype.emit
let googleCloseRegistered = false
function observeListening(server) {
  globalThis.__nitro__?.default?.hooks.hook('request', event => {
    ingressEventCount++
    ingressEvents.set(event.req.runtime.node.req, { request: event.req, url: event.url.href })
  })
  if (googlePeer && server.address()?.port) googlePeer.allowPort(server.address().port)
  if (googlePeer && !googleCloseRegistered) {
    // The pinned Nitro app publishes this same instance before serve/listen.
    // Its application resource close hook is already registered first.
    const hooks = globalThis.__nitro__?.default?.hooks
    if (!hooks) throw new Error('Google fixture could not register native cleanup')
    googleCloseRegistered = true
    hooks.hook('close', retireGooglePeer)
  }
  process.send?.({ type: 'listening', address: server.address() })
}

async function retireGooglePeer() {
  try { await googlePeer.close() }
  catch { process.exitCode = 1; throw new Error('Google fixture cleanup failed') }
  finally {
    if (process.connected) {
      await new Promise(resolve => process.send({ type: 'google-closed', evidence: googlePeer.evidence() }, resolve))
      process.disconnect()
    }
  }
}

function writeFixtureStream(response) {
  response.writeHead(200, {
    'content-type': 'text/plain',
    'content-length': '15',
    connection: process.env.FIXTURE_KEEP_ALIVE === 'yes' ? 'keep-alive' : 'close',
  })
  response.write('started')
  const timer = setTimeout(() => response.end('finished'), Number(process.env.FIXTURE_STREAM_MS))
  response.on('close', () => clearTimeout(timer))
  return true
}

Server.prototype.emit = function (event, ...args) {
  if (event === 'listening') observeListening(this)
  if (event === 'request' && process.env.FIXTURE_INGRESS === 'yes') {
    const req = args[0]
    ingressSnapshots.set(req, { target: req.url, socket: req.socket, headers: { ...req.headers }, rawHeaders: [...req.rawHeaders] })
  }
  if (event === 'request' && args[0].url === '/__fixture_stream') {
    const response = args[1]
    return writeFixtureStream(response)
  }
  return originalEmit.call(this, event, ...args)
}

process.on('message', (message) => {
  if (googlePeer && message?.type === 'google-register' && typeof message.id === 'string') {
    try {
      const code = googlePeer.register(message.url, message.subject, { name: 'Browser protocol fixture', ...message.options })
      process.send?.({ type: 'google-registered', id: message.id, code })
    } catch { process.send?.({ type: 'google-registered', id: message.id, failed: true }) }
  }
  if (googlePeer && message?.type === 'google-evidence') process.send?.({ type: 'google-evidence', id: message.id, evidence: googlePeer.evidence() })
  if (message === 'shutdown') {
    const handlers = process.listenerCount('SIGTERM')
    process.send?.({ type: 'shutdown', handlers })
    process.removeAllListeners('message')
    if (!googlePeer) process.disconnect()
    // Windows kill(SIGTERM) is hard termination. Invoke the real registered
    // runtime handler; Linux OS delivery is separate acceptance.
    process.emit('SIGTERM')
  }
})
