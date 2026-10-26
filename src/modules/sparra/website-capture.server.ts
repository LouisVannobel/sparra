import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import type { LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import { extractWebsiteText } from './website-text.server'

export type WebsiteCapture = Readonly<{
  url: string
  capturedAt: string
  title: string
  sha256: string
  passages: ReadonlyArray<Readonly<{ id: string; text: string }>>
}>

type Address = Readonly<{ address: string; family: 4 | 6 }>
type Page = { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; close(): void }

export type CaptureBoundaries = {
  resolve(hostname: string): Promise<readonly Address[]>
  open(url: URL, address: string, signal: AbortSignal): Promise<Page>
}

export class WebsiteCaptureError extends Error {
  constructor(readonly code: string) {
    super(`Website capture failed: ${code}`)
    this.name = 'WebsiteCaptureError'
  }
}

function fail(code: string): never { throw new WebsiteCaptureError(code) }

function parseUrl(input: string, blockedHosts: readonly string[]): URL {
  let url: URL
  try { url = new URL(input) } catch { return fail('INVALID_URL') }
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (url.username || url.password || url.search) return fail('UNSUPPORTED_URL')
  if (url.protocol !== 'https:' || url.port || !host || ipaddr.isValid(host.replace(/^\[|\]$/g, ''))) return fail('INVALID_URL')
  if (blockedHosts.some(blocked => blocked.toLowerCase().replace(/\.+$/, '') === host)) return fail('BLOCKED_HOST')
  url.hash = ''
  return url
}

function publicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  const parsed = ipaddr.parse(address)
  return parsed.range() === 'unicast' && (parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3))
}

function header(headers: Page['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value.join(',') : value
}

function isHtmlUtf8(contentType: string): boolean {
  const [mediaType, ...parameters] = contentType.split(';')
  if (mediaType.trim().toLowerCase() !== 'text/html') return false
  let charsetSeen = false
  for (const parameter of parameters) {
    const match = /^([a-z0-9-]+)\s*=\s*(?:"([a-z0-9-]+)"|([a-z0-9-]+))$/i.exec(parameter.trim())
    if (!match) return false
    if (match[1].toLowerCase() === 'charset') {
      if (charsetSeen || (match[2] ?? match[3]).toLowerCase() !== 'utf-8') return false
      charsetSeen = true
    }
  }
  return true
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WebsiteCaptureError('ABORTED'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new WebsiteCaptureError('ABORTED'))
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

async function readPage(page: Page, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  const iterator = page.body[Symbol.asyncIterator]()
  for (;;) {
    const next = await abortable(iterator.next(), signal)
    if (next.done) break
    length += next.value.byteLength
    if (length > 2_097_152) return fail('TOO_LARGE')
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export function pinnedAddressLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4
  return (_hostname, options, done) => {
    if (options.all) done(null, [{ address, family }])
    else done(null, address, family)
  }
}

const nativeBoundaries: CaptureBoundaries = {
  resolve: async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(result => {
    if (result.family !== 4 && result.family !== 6) return fail('UNSAFE_DESTINATION')
    return { address: result.address, family: result.family }
  }),
  open: (url, address, signal) => new Promise((resolve, reject) => {
    const outgoing = request({
      protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: 'GET', agent: false, signal, servername: url.hostname,
      headers: { accept: 'text/html', 'accept-encoding': 'identity' },
      lookup: pinnedAddressLookup(address),
    }, incoming => {
      resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming, close: () => { incoming.destroy(); outgoing.destroy() } })
    })
    outgoing.once('error', reject)
    outgoing.end()
  }),
}

export function captureWebsite(input: string, options: { signal?: AbortSignal; blockedHosts?: readonly string[] } = {}): Promise<WebsiteCapture> {
  return captureWebsiteWithBoundaries(input, options, nativeBoundaries)
}

export async function captureWebsiteWithBoundaries(input: string, options: { signal?: AbortSignal; blockedHosts?: readonly string[] }, boundaries: CaptureBoundaries): Promise<WebsiteCapture> {
  const url = parseUrl(input, options.blockedHosts ?? [])
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    let current = url
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (controller.signal.aborted) return fail('ABORTED')
      const answers = await abortable(boundaries.resolve(current.hostname), controller.signal)
      if (answers.length === 0 || answers.some(answer => !publicAddress(answer.address) || (answer.family === 4 ? answer.address.includes(':') : !answer.address.includes(':')))) return fail('UNSAFE_DESTINATION')
      const page = await abortable(boundaries.open(current, answers[0].address, controller.signal), controller.signal)
      try {
        if (page.status >= 300 && page.status < 400) {
          const location = header(page.headers, 'location')
          if (!location || redirects === 3) return fail('REDIRECT')
          let next: URL
          try { next = new URL(location, current) } catch { return fail('REDIRECT') }
          if (next.origin !== url.origin) return fail('REDIRECT')
          current = parseUrl(next.href, options.blockedHosts ?? [])
          continue
        }
        if (page.status !== 200) return fail('HTTP_STATUS')
        const encoding = header(page.headers, 'content-encoding')?.toLowerCase()
        if (encoding && encoding !== 'identity') return fail('ENCODING')
        const contentType = header(page.headers, 'content-type') ?? ''
        if (!isHtmlUtf8(contentType)) return fail('CONTENT_TYPE')
        const bytes = await readPage(page, controller.signal)
        let html: string
        try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('ENCODING') }
        if (html.length > 50_000) return fail('TOO_LARGE')
        if (controller.signal.aborted) return fail('ABORTED')
        const extracted = extractWebsiteText(html)
        if (controller.signal.aborted) return fail('ABORTED')
        return { url: current.href, capturedAt: new Date().toISOString(), title: extracted.title, sha256: createHash('sha256').update(bytes).digest('hex'), passages: extracted.passages }
      } finally { page.close() }
    }
    return fail('REDIRECT')
  } catch (error) {
    if (error instanceof WebsiteCaptureError) throw error
    throw new WebsiteCaptureError(controller.signal.aborted ? 'ABORTED' : 'TRANSPORT')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
