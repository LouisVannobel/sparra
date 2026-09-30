import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { Redacted, Schema } from 'effect'
import {
  createClient, AbortError, TimeoutError, ConnectionTimeoutError, SocketTimeoutError,
  ClientOfflineError, SocketClosedUnexpectedlyError, ReconnectStrategyError,
  DisconnectsClientError, ErrorReply,
} from 'redis'
import { ConfigurationError } from '../../platform/config.server'

export class RedisUnavailable extends Error { constructor() { super('Auth limiter unavailable'); this.name = 'RedisUnavailable' } }
export class RedisInvalid extends Error { constructor() { super('Auth limiter invalid'); this.name = 'RedisInvalid' } }
export class AuthAttemptExceeded extends Error {
  constructor(readonly retryAfter: number) { super('Too Many Requests'); this.name = 'AuthAttemptExceeded' }
}
const trustedClient = Symbol('TrustedClientContext')
export type TrustedClientContext = Readonly<{ [trustedClient]: true }>
type IngressRequest = {
  headers: Headers
  runtime?: { node?: { req?: { socket: { remoteAddress?: string } } } }
}

function canonicalIp(ip: string): string {
  if (!isIP(ip) || ip.includes('%')) throw new RedisInvalid()
  if (isIP(ip) === 4) return ip
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized)
  if (!mapped) return normalized
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

const positive = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/))

export function readRateLimitConfig(env: Readonly<Record<string, string | undefined>>) {
  function field<A>(key: string, decode: (value: unknown) => A, fallback?: string): A {
    try { return decode(env[key] ?? fallback) }
    catch { throw new ConfigurationError([key]) }
  }
  function milliseconds(value: unknown) {
    const decimal = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)))(value)
    return Schema.decodeUnknownSync(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 30000 })))(Number(decimal))
  }
  return Object.freeze({
    url: field('REDIS_URL', value => {
      const text = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^rediss?:\/\/[^\s\\]+$/)))(value)
      const url = new URL(text)
      if (!url.hostname || !url.password || url.hash || url.search || !['', '/', '/0'].includes(url.pathname)) throw new Error()
      return Redacted.make(text)
    }),
    environment: field('NODE_ENV', Schema.decodeUnknownSync(Schema.Literals(['development', 'test', 'production'])), 'development'),
    secret: field('RATE_LIMIT_HMAC_SECRET', value => Redacted.make(Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(32), Schema.isTrimmed()))(value))),
    keyId: field('RATE_LIMIT_KEY_ID', Schema.decodeUnknownSync(identifier)),
    trustedProxyIps: field('TRUSTED_PROXY_IPS', value => {
      const ips = Schema.decodeUnknownSync(Schema.String)(value).split(',')
      if (!ips.length) throw new Error()
      return Object.freeze(ips.map(canonicalIp))
    }),
    connectTimeoutMs: field('REDIS_CONNECT_TIMEOUT_MS', milliseconds, '2000'),
    commandTimeoutMs: field('REDIS_COMMAND_TIMEOUT_MS', milliseconds, '1000'),
    cleanupTimeoutMs: field('REDIS_CLEANUP_TIMEOUT_MS', milliseconds, '1000'),
  })
}

type RateLimitConfig = ReturnType<typeof readRateLimitConfig>
const lua = `local count = redis.call('INCR', KEYS[1])
local allowed = count <= tonumber(ARGV[2])
if allowed then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {allowed and 1 or 0, count, ttl}`
const tupleSchema = Schema.Tuple([
  Schema.Literals([0, 1]), positive,
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
])
const transportCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND'])

function normalize(error: unknown): RedisUnavailable | RedisInvalid {
  if (error instanceof RedisUnavailable || error instanceof RedisInvalid) return error
  if (error instanceof ErrorReply) return new RedisInvalid()
  if (error instanceof AbortError || error instanceof TimeoutError || error instanceof ConnectionTimeoutError
    || error instanceof SocketTimeoutError || error instanceof ClientOfflineError
    || error instanceof SocketClosedUnexpectedlyError || error instanceof ReconnectStrategyError
    || error instanceof DisconnectsClientError
    || error instanceof Error && 'code' in error && typeof error.code === 'string' && transportCodes.has(error.code)) return new RedisUnavailable()
  return new RedisInvalid()
}

export function createAuthRateLimiter(config: RateLimitConfig) {
  let stopping = false
  let terminal: RedisUnavailable | RedisInvalid | undefined
  let connected: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  const transport = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const identities = new WeakMap<TrustedClientContext, string>()
  const client = createClient({
    url: Redacted.value(config.url), disableOfflineQueue: true,
    commandOptions: { timeout: 0 },
    socket: {
      signal: transport.signal,
      connectTimeout: config.connectTimeoutMs,
      // Inactivity is not a command deadline. Keep healthy idle sockets;
      // explicit wall deadlines below destroy post-write nonsettling commands.
      socketTimeout: 0,
      reconnectStrategy: retries => stopping || terminal || retries >= 2 ? false : 25 * (retries + 1),
    },
  })
  function clearHandshakeTimer() { clearTimeout(handshakeTimer); handshakeTimer = undefined }
  client.on('connect', () => {
    clearHandshakeTimer()
    // socket.connectTimeout ends at TCP connect; AUTH/HELLO can still stall on
    // automatic reconnect, outside the initial connect() Promise below.
    handshakeTimer = setTimeout(destroy, config.connectTimeoutMs)
  })
  client.on('ready', clearHandshakeTimer)
  client.on('end', clearHandshakeTimer)
  client.on('error', error => {
    clearHandshakeTimer()
    const safe = normalize(error)
    if (safe instanceof RedisInvalid) { terminal ??= safe; destroy() }
    // No raw cause, URL, key, reply or command is sent to logging/tracing.
  })
  function destroy() {
    terminal ??= new RedisUnavailable()
    // Redis assigns its socket only after TCP/TLS connects. The native signal
    // also reaches a transport still waiting for connect/secureConnect.
    transport.abort()
    if (client.isOpen) client.destroy()
  }
  async function bounded<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { destroy(); reject(terminal) }, milliseconds)
      })])
    } finally { clearTimeout(timer) }
  }
  function connect() {
    if (stopping || terminal) return Promise.reject(terminal ?? new RedisUnavailable())
    connected ??= bounded(client.connect(), config.connectTimeoutMs).then(() => {
      if (terminal) throw terminal
    }).catch(error => { terminal ??= normalize(error); destroy(); throw terminal })
    return connected
  }
  async function consume(key: string, rule: { window: number; max: number }) {
    if (terminal) throw terminal
    if (stopping || !client.isReady) throw new RedisUnavailable()
    try {
      Schema.decodeUnknownSync(Schema.Number.check(Schema.isGreaterThan(0)))(rule.window)
      Schema.decodeUnknownSync(positive)(rule.window * 1000)
      Schema.decodeUnknownSync(positive)(rule.max)
      Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)))(key)
    } catch { throw new RedisInvalid() }
    const derived = `rl:v1:${config.environment}:${config.keyId}:` + createHmac('sha256', Redacted.value(config.secret)).update(key).digest('hex')
    const command = client.withAbortSignal(AbortSignal.timeout(config.commandTimeoutMs)).eval(lua, {
      keys: [derived], arguments: [String(rule.window * 1000), String(rule.max)],
    })
    pending.add(command)
    try {
      const reply = await bounded(command, config.commandTimeoutMs)
      let tuple: readonly [0 | 1, number, number]
      try { tuple = Schema.decodeUnknownSync(tupleSchema)(reply) }
      catch { throw new RedisInvalid() }
      const [allowedInt, count, ttlMs] = tuple
      if ((allowedInt === 1) !== (count <= rule.max)) throw new RedisInvalid()
      return { allowed: allowedInt === 1, retryAfter: allowedInt === 1 ? null : Math.ceil(ttlMs / 1000) }
    } catch (error) { throw terminal ?? normalize(error) }
    finally { pending.delete(command) }
  }
  function close() {
    if (closing) return closing
    stopping = true
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.allSettled([...pending, ...(connected ? [connected] : [])]), new Promise<void>(resolve => {
          timer = setTimeout(() => { destroy(); resolve() }, config.cleanupTimeoutMs)
        })])
      } finally { clearTimeout(timer) }
      // An automatic reconnect may own an internal AUTH handshake even after
      // the initial connected Promise and our EVAL set have drained. Never
      // start native close until ready: it disables later public destroy.
      if (client.isOpen) {
        if (client.isReady) await client.close()
        else destroy()
      }
    })()
    return closing
  }
  function trustedClientContext(request: IngressRequest): TrustedClientContext {
    const peer = request.runtime?.node?.req?.socket.remoteAddress
    if (!peer || !config.trustedProxyIps.includes(canonicalIp(peer))) throw new RedisInvalid()
    const header = request.headers.get('x-real-ip')
    if (!header) throw new RedisInvalid()
    const ip = canonicalIp(header)
    // The opaque object cannot be recreated from a browser payload; identity is
    // retained only in this process-owned limiter. Origin ACL/header overwrite
    // remain ingress deployment requirements, not properties of this brand.
    const context = Object.freeze({ [trustedClient]: true as const })
    identities.set(context, ip)
    return context
  }
  const authAttemptRules = Object.freeze({
    beginGoogleSignIn: { window: 10, max: 3 },
    requestMagicLink: { window: 60, max: 5 },
    consumeMagicLink: { window: 60, max: 5 },
    completeMagicEnrollment: { window: 60, max: 5 },
    beginPasskeySignIn: { window: 60, max: 5 },
    finishPasskeySignIn: { window: 60, max: 5 },
    beginAdditionalPasskey: { window: 60, max: 5 },
    authorizeAdditionalPasskey: { window: 60, max: 5 },
    finishAdditionalPasskey: { window: 60, max: 5 },
    beginFirstGooglePasskey: { window: 60, max: 5 },
    completeFirstGooglePasskeyOAuth: { window: 60, max: 5 },
    readFirstGooglePasskey: { window: 60, max: 10 },
    prepareFirstGooglePasskey: { window: 60, max: 5 },
    finishFirstGooglePasskey: { window: 60, max: 5 },
    cancelFirstGooglePasskey: { window: 60, max: 5 },
    beginGoogleAccountLink: { window: 60, max: 5 },
    beginSessionRevocation: { window: 60, max: 5 },
    finishSessionRevocation: { window: 60, max: 5 },
    beginSessionList: { window: 60, max: 5 },
    finishSessionList: { window: 60, max: 5 },
    authorizeGoogleAccountLink: { window: 60, max: 5 },
    completeGoogleAccountLinkOAuth: { window: 60, max: 5 },
    beginGoogleAccountUnlink: { window: 60, max: 5 },
    finishGoogleAccountUnlink: { window: 60, max: 5 },
    readGoogleAccountIntent: { window: 60, max: 10 },
    cancelGoogleAccountIntent: { window: 60, max: 5 },
    beginRecoveryCodeRotation: { window: 60, max: 5 },
    finishRecoveryCodeRotation: { window: 60, max: 5 },
    beginRecoveryGoogleProof: { window: 60, max: 5 },
    completeRecoveryGoogleProof: { window: 60, max: 5 },
  })
  type AuthAttemptOperation = keyof typeof authAttemptRules
  async function consumeAuthAttempt(operation: AuthAttemptOperation, context: TrustedClientContext) {
    const ip = identities.get(context)
    if (!Object.hasOwn(authAttemptRules, operation) || !ip) throw new RedisInvalid()
    // BA 1.7.1 getDefaultSpecialRules: /sign-in window=10s, max=3.
    // Application entries call this once; in-process auth.api bypasses BA's
    // HTTP onRequest hook and must not add a second consume on delegation.
    // Magic uses the installed BA1.7.4 magic plugin's explicit default: 5/60s.
    const rule = authAttemptRules[operation]
    const result = await consume(`application:${operation}:${ip}`, rule)
    if (!result.allowed) throw new AuthAttemptExceeded(result.retryAfter ?? rule.window)
  }
  return {
    connect, close, customStorage: { consume }, trustedClientContext, consumeAuthAttempt,
    errorResponse: rateLimitErrorResponse,
    isReady: () => !stopping && !terminal && client.isReady,
  }
}

export function rateLimitErrorResponse(error: unknown): Response | undefined {
  if (error instanceof AuthAttemptExceeded) return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': String(error.retryAfter) } })
  if (error instanceof RedisUnavailable) return new Response('Service Unavailable', { status: 503 })
  if (error instanceof RedisInvalid) return new Response('Internal Server Error', { status: 500 })
  return undefined
}
