import { createHash } from 'node:crypto'
import { Schema } from 'effect'
import { readWebConfig, type WebConfig } from '../../platform/config.server'

const label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const address = Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@<>"&]+@[^\s@<>"&]+\.[^\s@<>"&]+$/))
const sender = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100), Schema.isPattern(/^[^\r\n\x00-\x1f]+$/)), email: address })
const replayWindow = Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })))
const profileSchema = Schema.Struct({ appOrigin: Schema.String, apiOrigin: Schema.String, projectId: label, credentialId: label, from: sender, reply: address, replayWindowSeconds: replayWindow })
const requestSchema = Schema.Struct({ to: address, from: sender, subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(998), Schema.isPattern(/^[^\r\n]+$/)), body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)), reply: address })
const snapshotSchema = Schema.Struct({ format: Schema.Literal('auth-plunk-v1'), apiOrigin: Schema.String, path: Schema.Literal('/v1/send'), projectId: label, credentialId: label, idempotencyKey: Schema.String.check(Schema.isPattern(/^auth-email-delivery:[0-9a-f-]{36}$/)), requestJson: Schema.String.check(Schema.isMaxLength(16384)), replayWindowSeconds: replayWindow })
export type MailProfile = typeof profileSchema.Type
export type MailSnapshot = typeof snapshotSchema.Type
export function validatePlunkRequestJson(requestJson: string) {
  try { return Schema.decodeUnknownSync(requestSchema)(JSON.parse(requestJson), { onExcessProperty: 'error' }) }
  catch { throw new Error('Auth mail snapshot rejected') }
}
export function validateMailProfile(input: unknown, environment: WebConfig['environment'] = 'production'): MailProfile {
  try {
    const value = Schema.decodeUnknownSync(profileSchema)(input, { onExcessProperty: 'error' })
    const appOrigin = readWebConfig({ NODE_ENV: environment, APP_ORIGIN: value.appOrigin }).origin
    const apiOrigin = readWebConfig({ NODE_ENV: 'production', APP_ORIGIN: value.apiOrigin }).origin
    return Object.freeze({ ...value, appOrigin, apiOrigin, from: Object.freeze({ ...value.from }) })
  } catch { throw new Error('Auth mail profile rejected') }
}
export function createMailSnapshot(profile: MailProfile, command: { recipient: string; locale: 'fr' | 'en' }, outboxId: string, token: Buffer) {
  try {
    const value = validateMailProfile(profile)
    Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(outboxId)
    if (token.length !== 32) throw new Error()
    const locale = Schema.decodeUnknownSync(Schema.Literals(['fr', 'en']))(command.locale)
    const link = `${value.appOrigin}/auth/magic/confirm?lang=${locale}#token=${token.toString('base64url')}`
    const request = Schema.decodeUnknownSync(requestSchema)({ to: command.recipient, from: value.from,
      subject: locale === 'fr' ? 'Votre lien de connexion' : 'Your sign-in link',
      body: locale === 'fr' ? `<p><a href="${link}">Se connecter</a></p><p>Ce lien expire dans dix minutes au maximum.</p>` : `<p><a href="${link}">Sign in</a></p><p>This link expires in at most ten minutes.</p>`, reply: value.reply })
    const snapshot: MailSnapshot = { format: 'auth-plunk-v1', apiOrigin: value.apiOrigin, path: '/v1/send', projectId: value.projectId, credentialId: value.credentialId, idempotencyKey: `auth-email-delivery:${outboxId}`, requestJson: JSON.stringify(request), replayWindowSeconds: value.replayWindowSeconds }
    const bytes = Buffer.from(JSON.stringify(snapshot))
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex'), format: snapshot.format }
  } catch { throw new Error('Auth mail snapshot rejected') }
}
export function decodeMailSnapshot(bytes: Buffer, hash: string): MailSnapshot {
  try {
    if (bytes.length > 24576 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error()
    const value = Schema.decodeUnknownSync(snapshotSchema)(JSON.parse(bytes.toString('utf8')), { onExcessProperty: 'error' })
    if (readWebConfig({ NODE_ENV: 'production', APP_ORIGIN: value.apiOrigin }).origin !== value.apiOrigin) throw new Error()
    validatePlunkRequestJson(value.requestJson)
    return value
  } catch { throw new Error('Auth mail snapshot rejected') }
}
