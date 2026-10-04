import { Schema } from 'effect'

export type WebConfig = Readonly<{
  environment: 'development' | 'test' | 'production'
  origin: string
  hostname: '127.0.0.1' | '::1' | '0.0.0.0'
  port: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  ingressProfile: 'direct-serve' | null
}>

export class ConfigurationError extends Error {
  readonly invalidKeys: readonly string[]

  constructor(invalidKeys: readonly string[]) {
    super(`Invalid configuration keys: ${invalidKeys.join(', ')}`)
    this.name = 'ConfigurationError'
    this.invalidKeys = Object.freeze([...invalidKeys])
  }
}

const EnvironmentSchema = Schema.Literals(['development', 'test', 'production'])
const HostSchema = Schema.Literals(['127.0.0.1', '::1', '0.0.0.0'])
const CanonicalDecimalSchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/),
)
const BareOriginSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^https?:\/\/[^/?#\\\s]+\/?$/i),
)
const HttpLoopbackAuthoritySchema = Schema.String.check(
  Schema.isPattern(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i),
)

export function readWebConfig(
  env: Readonly<Record<string, string | undefined>>,
): WebConfig {
  const invalidKeys: string[] = []
  const { environment, origin, ingressProfile } = readOriginSettings(env, invalidKeys)
  const { hostname, port, requestTimeoutMs, shutdownTimeoutMs } = readListenerSettings(env, invalidKeys)

  if (invalidKeys.length > 0) {
    throw new ConfigurationError(invalidKeys)
  }

  return Object.freeze({
    environment,
    origin,
    hostname,
    port,
    requestTimeoutMs,
    shutdownTimeoutMs,
    ingressProfile,
  })
}

function readOriginSettings(
  env: Readonly<Record<string, string | undefined>>,
  invalidKeys: string[],
): Pick<WebConfig, 'environment' | 'origin' | 'ingressProfile'> {
  const ingressProfile = env.SPARRA_INGRESS_PROFILE === undefined ? null : env.SPARRA_INGRESS_PROFILE
  if (ingressProfile !== null && ingressProfile !== 'direct-serve') invalidKeys.push('SPARRA_INGRESS_PROFILE')

  let environment: WebConfig['environment'] = 'development'
  try {
    environment = Schema.decodeUnknownSync(EnvironmentSchema)(
      env.NODE_ENV === undefined ? 'development' : env.NODE_ENV,
    )
  } catch {
    invalidKeys.push('NODE_ENV')
  }

  let origin = ''
  try {
    origin = decodeOrigin(env.APP_ORIGIN, invalidKeys.includes('NODE_ENV') ? undefined : environment)
    if (ingressProfile === 'direct-serve' && !origin.startsWith('https://')) throw new Error('invalid origin')
  } catch {
    invalidKeys.push('APP_ORIGIN')
  }

  return {
    environment,
    origin,
    ingressProfile: ingressProfile === 'direct-serve' ? ingressProfile : null,
  }
}

function readListenerSettings(
  env: Readonly<Record<string, string | undefined>>,
  invalidKeys: string[],
): Pick<WebConfig, 'hostname' | 'port' | 'requestTimeoutMs' | 'shutdownTimeoutMs'> {
  let hostname: WebConfig['hostname'] = '127.0.0.1'
  try {
    hostname = Schema.decodeUnknownSync(HostSchema)(
      env.HOST === undefined ? '127.0.0.1' : env.HOST,
    )
  } catch {
    invalidKeys.push('HOST')
  }

  let port = 3000
  try {
    port = decodeCanonicalInteger(env.PORT === undefined ? '3000' : env.PORT, 0, 65535)
  } catch {
    invalidKeys.push('PORT')
  }

  let requestTimeoutMs = 10000
  try {
    requestTimeoutMs = decodeCanonicalInteger(
      env.REQUEST_TIMEOUT_MS === undefined ? '10000' : env.REQUEST_TIMEOUT_MS,
      1,
      30000,
    )
  } catch {
    invalidKeys.push('REQUEST_TIMEOUT_MS')
  }

  let shutdownTimeoutMs = 5000
  try {
    shutdownTimeoutMs = decodeCanonicalInteger(
      env.SHUTDOWN_TIMEOUT_MS === undefined ? '5000' : env.SHUTDOWN_TIMEOUT_MS,
      1000,
      30000,
      1000,
    )
  } catch {
    invalidKeys.push('SHUTDOWN_TIMEOUT_MS')
  }

  return {
    hostname,
    port,
    requestTimeoutMs,
    shutdownTimeoutMs,
  }
}

function decodeCanonicalInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  multipleOf?: number,
): number {
  const lexical = Schema.decodeUnknownSync(CanonicalDecimalSchema)(input)
  const integerSchema = multipleOf === undefined
    ? Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum, maximum }),
      )
    : Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum, maximum }),
        Schema.isMultipleOf(multipleOf),
      )

  return Schema.decodeUnknownSync(integerSchema)(Number(lexical))
}

function decodeOrigin(
  input: unknown,
  environment: WebConfig['environment'] | undefined,
): string {
  const lexical = Schema.decodeUnknownSync(BareOriginSchema)(input)
  const authority = lexical.slice(lexical.indexOf('//') + 2).replace(/\/$/, '')

  if (authority.includes('@') || authority.endsWith(':')) {
    throw new Error('invalid origin')
  }

  if (lexical.slice(0, lexical.indexOf(':')).toLowerCase() === 'http') {
    Schema.decodeUnknownSync(HttpLoopbackAuthoritySchema)(authority)
  }

  const url = new URL(lexical)

  if (url.username !== '' || url.password !== '') {
    throw new Error('invalid origin')
  }

  if (url.protocol === 'https:') {
    return url.origin
  }

  if (url.protocol !== 'http:' || environment === 'production') {
    throw new Error('invalid origin')
  }

  return url.origin
}
