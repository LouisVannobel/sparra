import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { canonicalIp } from './canonical-ip.server'
import type { WebConfig } from './config.server'
import { readRateLimitConfig } from '../modules/auth/rate-limit.server'

export type DirectServeConfig = Readonly<{ origin: string; trustedProxyIps: readonly string[] }>
type NodeRequest = Request & { runtime: { node: { req: IncomingMessage } }; _url: URL }

export function readDirectServeConfig(
  env: Readonly<Record<string, string | undefined>>, web: WebConfig,
): DirectServeConfig | null {
  return web.ingressProfile === null ? null : Object.freeze({
    origin: web.origin, trustedProxyIps: readRateLimitConfig(env).trustedProxyIps,
  })
}

function isNodeRequest(request: Request): request is NodeRequest {
  if (!('runtime' in request) || typeof request.runtime !== 'object' || request.runtime === null
    || !('node' in request.runtime) || typeof request.runtime.node !== 'object' || request.runtime.node === null
    || !('req' in request.runtime.node) || !(request.runtime.node.req instanceof IncomingMessage)
    || !(request.runtime.node.req.socket instanceof Socket) || !('_url' in request)) return false
  return true
}

function refusal(): Response {
  return new Response('Bad Request', { status: 400, headers: {
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex',
  } })
}
const needlessPathEscape = /%(?:2[146-9A-E]|3[0-9ABD]|4[0-9A-F]|5[0-9ABDF]|6[1-9A-F]|7[0-9ACE])/i
const alternateIp = /^(?:forwarded|client-ip|true-client-ip|cf-connecting-ip|tailscale-ingress-src|x-vercel-.*)$/i
const callbackPaths = ['/api/auth/callback/google', '/api/auth/account/google/callback']

function validateRawTarget(target: string | undefined, origin: string): URL | null {
  if (!target || !target.startsWith('/') || target.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(target)
    || /%(?![0-9a-f]{2})/i.test(target)) return null
  const path = target.split('?')[0]
  // Path aliases are forbidden; OAuth query escapes remain original octets.
  if (/%(?:25)*(?:2f|5c)/i.test(path) || needlessPathEscape.test(path)
    || callbackPaths.some(callback => path.startsWith(callback + '/'))) return null
  const url = new URL(origin + target)
  return url.origin === origin && url.pathname + url.search === target ? url : null
}

function collectRawHeaders(node: IncomingMessage): Map<string, string[]> | null {
  const raw = new Map<string, string[]>()
  if (node.rawHeaders.length % 2 !== 0) return null
  for (let i = 0; i < node.rawHeaders.length; i += 2) {
    const name = node.rawHeaders[i].toLowerCase()
    const values = raw.get(name) ?? []
    values.push(node.rawHeaders[i + 1]); raw.set(name, values)
  }
  return raw
}

function validateForwardingAuthority(raw: Map<string, string[]>, url: URL): string | null {
  const exact = (name: string, value: string) => raw.get(name)?.length === 1 && raw.get(name)?.[0] === value
  if (!exact('host', url.host) || !exact('x-forwarded-host', url.host) || !exact('x-forwarded-proto', 'https')) return null
  const marker = raw.get('tailscale-funnel-request')
  if (marker && (marker.length !== 1 || marker[0] !== '?1')) return null
  const forwarded = raw.get('x-forwarded-for')
  if (!forwarded || forwarded.length !== 1) return null
  const client = canonicalIp(forwarded[0])
  // Canonical mapped IPv6 is an explicitly supported native equivalence.
  if (forwarded[0] !== client && forwarded[0] !== `::ffff:${client}`
    && !(forwarded[0].startsWith('::ffff:') && new URL(`http://[${forwarded[0]}]/`).hostname.slice(1, -1) === forwarded[0])) return null
  return client
}

function applyCanonicalIngress(request: NodeRequest, node: IncomingMessage, url: URL, client: string): boolean {
  const retained: string[] = []
  for (let i = 0; i < node.rawHeaders.length; i += 2) {
    const name = node.rawHeaders[i]
    if (name.toLowerCase() !== 'x-real-ip' && !alternateIp.test(name)) retained.push(name, node.rawHeaders[i + 1])
  }
  retained.push('X-Real-IP', client)
  node.rawHeaders.splice(0, node.rawHeaders.length, ...retained)
  for (const name of Object.keys(node.headers)) if (name === 'x-real-ip' || alternateIp.test(name)) delete node.headers[name]
  node.headers['x-real-ip'] = client
  const headers = request.headers
  for (const name of [...headers.keys()]) if (name === 'x-real-ip' || alternateIp.test(name)) headers.delete(name)
  headers.set('x-real-ip', client)
  request._url = url
  return request.url === url.href
}

export function normalizeDirectServeIngress(request: Request, config: DirectServeConfig | null): Response | undefined {
  if (config === null) return undefined
  try {
    if (!isNodeRequest(request)) return refusal()
    const node = request.runtime.node.req
    const peer = node.socket.remoteAddress
    if (!peer || !config.trustedProxyIps.includes(canonicalIp(peer))) return refusal()
    const url = validateRawTarget(node.url, config.origin)
    if (!url) return refusal()
    const raw = collectRawHeaders(node)
    if (!raw) return refusal()
    const client = validateForwardingAuthority(raw, url)
    if (!client || !applyCanonicalIngress(request, node, url, client)) return refusal()
    return undefined
  } catch { return refusal() }
}
