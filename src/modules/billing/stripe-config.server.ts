import { Redacted, Schema } from 'effect'
import { ConfigurationError, readWebConfig } from '../../platform/config.server'

type Environment = Readonly<Record<string, string | undefined>>
export type StripeConfig = Readonly<{
  apiKey: Redacted.Redacted<string>
  webhookSecret: Redacted.Redacted<string>
  accountId: string
  monthlyPriceId: string
  onboardingPriceId: string | null
  environment: 'sandbox' | 'live'
  origin: string
  apiVersion: '2026-09-30.endive'
}>

const apiKey = Schema.String.check(Schema.isPattern(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/))
const webhookSecret = Schema.String.check(Schema.isPattern(/^whsec_[A-Za-z0-9_]+$/))
const accountId = Schema.String.check(Schema.isPattern(/^acct_[A-Za-z0-9]+$/))
const priceId = Schema.String.check(Schema.isPattern(/^price_[A-Za-z0-9]+$/))
const stripeEnvironment = Schema.Literals(['sandbox', 'live'])
const stripeKeys = [
  'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_ACCOUNT_ID',
  'STRIPE_MONTHLY_PRICE_ID', 'STRIPE_ENVIRONMENT', 'STRIPE_ONBOARDING_PRICE_ID',
] as const

export function readStripeConfig(env: Environment): StripeConfig | null {
  if (stripeKeys.every(key => env[key] === undefined)) return null

  const invalid: string[] = []
  const decode = <A>(key: string, schema: Schema.ConstraintDecoder<A, never>): A | undefined => {
    try { return Schema.decodeUnknownSync(schema)(env[key]) }
    catch { invalid.push(key); return undefined }
  }
  const key = decode('STRIPE_API_KEY', apiKey)
  const secret = decode('STRIPE_WEBHOOK_SECRET', webhookSecret)
  const account = decode('STRIPE_ACCOUNT_ID', accountId)
  const monthly = decode('STRIPE_MONTHLY_PRICE_ID', priceId)
  const environment = decode('STRIPE_ENVIRONMENT', stripeEnvironment)
  const onboarding = env.STRIPE_ONBOARDING_PRICE_ID === undefined
    ? null : decode('STRIPE_ONBOARDING_PRICE_ID', priceId)

  if (key && environment && (environment === 'sandbox') !== /^(?:sk|rk)_test_/.test(key)) {
    invalid.push('STRIPE_API_KEY', 'STRIPE_ENVIRONMENT')
  }

  let origin: string | undefined
  try { origin = readWebConfig({ APP_ORIGIN: env.APP_ORIGIN, NODE_ENV: env.NODE_ENV }).origin }
  catch (error) {
    if (error instanceof ConfigurationError) invalid.push(...error.invalidKeys)
    else invalid.push('APP_ORIGIN')
  }

  if (invalid.length) throw new ConfigurationError([...new Set(invalid)])
  if (!key || !secret || !account || !monthly || !environment || !origin || onboarding === undefined) {
    throw new ConfigurationError(['STRIPE_API_KEY'])
  }

  return Object.freeze({
    apiKey: Redacted.make(key),
    webhookSecret: Redacted.make(secret),
    accountId: account,
    monthlyPriceId: monthly,
    onboardingPriceId: onboarding,
    environment,
    origin,
    apiVersion: '2026-09-30.endive',
  })
}
