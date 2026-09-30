// Runs the actual compiled Start handler/H3 converter without opening a listener.
import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { redirect } from '@tanstack/react-router'

const directory = resolve('.output/server/_ssr')
const compiled = await import(pathToFileURL(resolve(directory, 'ssr.mjs')).href)
const { createMiddleware } = compiled
// Nitro may emit its SSR default through a shared-chunk wrapper when the
// middleware/accessor imports create a shared entry. Both are real exports.
const server = compiled.default ?? compiled.server_default
if (!server?.fetch) throw new Error('Compiled SSR fetch entry missing')
const startFile = (await readdir(directory)).find(name => /^start-.*\.mjs$/.test(name))
if (!startFile) throw new Error('Built Start entry not found')
const { startInstance } = await import(pathToFileURL(resolve(directory, startFile)).href)
const getOptions = startInstance.getOptions.bind(startInstance)
const scenario = process.argv[2]
let entered = false
let settled = false

// Append a test-only consumer through the installed middleware API, preserving
// all real application middleware and the real Start/H3 error conversion.
startInstance.getOptions = async () => {
  const options = await getOptions()
  return { ...options, requestMiddleware: [...(options.requestMiddleware ?? []), createMiddleware().server(async ({ request }) => {
    entered = true
    try {
      if (scenario === 'unexpected') throw new Error('private-unexpected-marker')
      if (scenario === 'forbidden') throw new Response('Forbidden', { status: 403, headers: { 'x-consumer': 'preserved' } })
      if (scenario === 'redirect') throw redirect({ href: 'https://template.example/health/live', statusCode: 302 })
      if (scenario === 'deadline' || scenario === 'client-abort') {
        await new Promise((_, reject) => {
          if (request.signal.aborted) reject(request.signal.reason)
          else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
          if (scenario === 'client-abort') queueMicrotask(() => abort.abort(new Error('private-late-abort-marker')))
        })
      }
      return new Response('consumer response', { status: 201, headers: { 'x-consumer': 'preserved' } })
    } finally { settled = true }
  })] }
}

const abort = new AbortController()
if (scenario === 'pre-abort') abort.abort(new Error('private-abort-marker'))
const request = new Request('https://template.example/health/live', { signal: abort.signal })
// Timeout is only a fixture watchdog, never a substitute for successful exit.
const watchdog = setTimeout(() => { throw new Error('Start fixture exceeded bound') }, 3000)
try {
  const response = await server.fetch(request)
  console.log(JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), entered, settled }))
} finally {
  clearTimeout(watchdog)
}
