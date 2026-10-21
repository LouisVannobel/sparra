import { Redacted } from 'effect'

export type CalendarConfig = {
  readonly origin: string
  readonly clientId: Redacted.Redacted<string>
  readonly clientSecret: Redacted.Redacted<string>
  readonly tokenKey: Redacted.Redacted<string>
}

class CalendarConfigurationError extends Error {
  constructor() { super('Invalid Calendar configuration'); this.name = 'CalendarConfigurationError' }
}

/** Caller composition contains this error to Calendar; core auth has separate configuration. */
export function readCalendarConfig(env: Readonly<Record<string, string | undefined>>): CalendarConfig | null {
  const id = env.SPARRA_GOOGLE_CALENDAR_CLIENT_ID
  const secret = env.SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET
  const key = env.SPARRA_CALENDAR_TOKEN_KEY
  if (id === undefined && secret === undefined && key === undefined) return null
  try {
    const credentials = calendarCredentials(id, secret, key)
    return { origin: calendarOrigin(env.APP_ORIGIN), ...credentials }
  } catch { throw new CalendarConfigurationError() }
}

function calendarCredentials(id:string|undefined,secret:string|undefined,key:string|undefined):Pick<CalendarConfig,'clientId'|'clientSecret'|'tokenKey'> {
  if (!id || !secret || !key || id.length > 2048 || secret.length > 4096 || /\s/.test(id) || secret.trim() !== secret) throw new CalendarConfigurationError()
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').length !== 32 || Buffer.from(key, 'base64url').toString('base64url') !== key) throw new CalendarConfigurationError()
  return {clientId:Redacted.make(id),clientSecret:Redacted.make(secret),tokenKey:Redacted.make(key)}
}

function calendarOrigin(value:string|undefined):string {
  const url=new URL(value??'')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new CalendarConfigurationError()
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new CalendarConfigurationError()
  return url.origin
}
