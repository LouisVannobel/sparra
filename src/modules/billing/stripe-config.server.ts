import { Redacted, Schema } from 'effect'
import { ConfigurationError, readWebConfig } from '../../platform/config.server.ts'

type Environment = Readonly<Record<string, string | undefined>>
export type StripeAccessConfig = Readonly<{
  apiKey: Redacted.Redacted<string>
  accountId: string
  environment: 'sandbox' | 'live'
  apiVersion: '2026-09-30.endive'
}>
export type StripeConfig = StripeAccessConfig & Readonly<{ webhookSecret: Redacted.Redacted<string>; origin: string }>

const apiKey = Schema.String.check(Schema.isPattern(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/))
const webhookSecret = Schema.String.check(Schema.isPattern(/^whsec_[A-Za-z0-9_]+$/))
const accountId = Schema.String.check(Schema.isPattern(/^acct_[A-Za-z0-9]+$/))
const stripeEnvironment = Schema.Literals(['sandbox', 'live'])
const stripeKeys = [
  'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_ACCOUNT_ID',
  'STRIPE_ENVIRONMENT',
] as const

export function readStripeOperatorConfig(env: Environment): StripeAccessConfig {
  const invalid: string[] = []
  const access = decodeStripeAccess(env, invalid)
  if (invalid.length || !access) throw new ConfigurationError([...new Set(invalid)])
  return access
}
function decodeStripeAccess(env: Environment, invalid: string[]): StripeAccessConfig | null {
  const decode = <A>(key: string, schema: Schema.ConstraintDecoder<A, never>): A | undefined => {
    try { return Schema.decodeUnknownSync(schema)(env[key]) }
    catch { invalid.push(key); return undefined }
  }
  const key = decode('STRIPE_API_KEY', apiKey), account = decode('STRIPE_ACCOUNT_ID', accountId)
  const environment = decode('STRIPE_ENVIRONMENT', stripeEnvironment)
  if (key && environment && (environment === 'sandbox') !== /^(?:sk|rk)_test_/.test(key)) {
    invalid.push('STRIPE_API_KEY', 'STRIPE_ENVIRONMENT')
  }
  return key && account && environment ? Object.freeze({ apiKey: Redacted.make(key), accountId: account,
    environment, apiVersion: '2026-09-30.endive' }) : null
}

export function readStripeConfig(env: Environment): StripeConfig | null {
  if (stripeKeys.every(key => env[key] === undefined)) return null

  const invalid: string[] = []
  const decode = <A>(key: string, schema: Schema.ConstraintDecoder<A, never>): A | undefined => {
    try { return Schema.decodeUnknownSync(schema)(env[key]) }
    catch { invalid.push(key); return undefined }
  }
  const access = decodeStripeAccess(env, invalid)
  const secret = decode('STRIPE_WEBHOOK_SECRET', webhookSecret)

  let origin: string | undefined
  try { origin = readWebConfig({ APP_ORIGIN: env.APP_ORIGIN, NODE_ENV: env.NODE_ENV }).origin }
  catch (error) {
    if (error instanceof ConfigurationError) invalid.push(...error.invalidKeys)
    else invalid.push('APP_ORIGIN')
  }

  if (invalid.length) throw new ConfigurationError([...new Set(invalid)])
  if (!access || !secret || !origin) {
    throw new ConfigurationError(['STRIPE_API_KEY'])
  }

  return Object.freeze({
    ...access,
    webhookSecret: Redacted.make(secret),
    origin,
  })
}
