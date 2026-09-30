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
const { createMiddleware } = await import(pathToFileURL(resolve(directory, 'ssr.mjs')).href)
const startFile = (await readdir(directory)).find(name => /^start-.*\.mjs$/.test(name))
const { startInstance } = await import(pathToFileURL(resolve(directory, startFile)).href)
const originalOptions = startInstance.getOptions.bind(startInstance)
const identities = new WeakMap()
let effects = 0
let nextId = 0
startInstance.getOptions = async () => {
  const options = await originalOptions()
  return { ...options, requestMiddleware: [...(options.requestMiddleware ?? []), createMiddleware().server(async ({ request, next }) => {
    const path = new URL(request.url).pathname
    if (path === '/' && process.env.FIXTURE_ROOT_RESPONSE) {
      if (process.env.FIXTURE_ROOT_RESPONSE === 'error') return new Response('<h1>Controlled error</h1>', { status: 500, headers: { 'content-type': 'text/html' } })
      if (process.env.FIXTURE_ROOT_RESPONSE === 'json') return Response.json({ fixture: true })
      if (process.env.FIXTURE_ROOT_RESPONSE === 'redirect') return new Response(null, { status: 302, headers: { location: '/login', 'content-type': 'text/html' } })
      throw new Error('Unknown root response fixture')
    }
    if (path !== '/__fixture_resources' && path !== '/__fixture_auth') return next()
    const resources = request.context?.appResources
    if (!resources) return new Response('Missing request carrier', { status: 500 })
    if (!identities.has(resources)) identities.set(resources, ++nextId)
    if (path === '/__fixture_resources') return Response.json({ resourceId: identities.get(resources), ready: resources.isReady(), effects })
    const client = resources.limiter.trustedClientContext(request)
    await resources.limiter.consumeAuthAttempt('beginGoogleSignIn', client)
    effects++
    return new Response('effect reached', { status: 201 })
  })] }
}

const originalEmit = Server.prototype.emit
let googleCloseRegistered = false
Server.prototype.emit = function (event, ...args) {
  if (event === 'listening') {
    if (googlePeer && this.address()?.port) googlePeer.allowPort(this.address().port)
    if (googlePeer && !googleCloseRegistered) {
      // The pinned Nitro app publishes this same instance before serve/listen.
      // Its application resource close hook is already registered first.
      const hooks = globalThis.__nitro__?.default?.hooks
      if (!hooks) throw new Error('Google fixture could not register native cleanup')
      googleCloseRegistered = true
      hooks.hook('close', async () => {
        try { await googlePeer.close() }
        catch { process.exitCode = 1; throw new Error('Google fixture cleanup failed') }
        finally {
          if (process.connected) {
            await new Promise(resolve => process.send({ type: 'google-closed', evidence: googlePeer.evidence() }, resolve))
            process.disconnect()
          }
        }
      })
    }
    process.send?.({ type: 'listening', address: this.address() })
  }
  if (event === 'request' && args[0].url === '/__fixture_stream') {
    const response = args[1]
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
