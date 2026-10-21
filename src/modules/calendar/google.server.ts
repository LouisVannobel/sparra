import { Redacted, Schema } from 'effect'
import { Agent, request, type Dispatcher } from 'undici'
import type { CalendarConfig } from './config.server'
import { validCalendarInstant } from './time'

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
] as const

/** Google may return either spelling for the requested OIDC email scope. */
export function hasRequiredCalendarGrants(scopes:readonly string[]):boolean {
  return scopes.includes('openid')
    && (scopes.includes('email')||scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
    && GOOGLE_CALENDAR_SCOPES.every(scope=>scopes.includes(scope))
}

export type CalendarProviderErrorCode = 'unavailable' | 'unauthorized' | 'rate_limited' | 'not_found' | 'conflict' | 'rejected' | 'unknown'
export class CalendarProviderError extends Error {
  constructor(readonly code: CalendarProviderErrorCode) { super(`Calendar provider ${code}`); this.name = 'CalendarProviderError' }
}
type GoogleRevocationResult = 'revoked' | 'invalid_token'
export class CalendarRevocationError extends CalendarProviderError {
  constructor(readonly outcome:'not_sent'|'unknown') { super(outcome==='not_sent'?'unavailable':'unknown'); this.name='CalendarRevocationError' }
}

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const identifier = text(1024).check(Schema.makeFilter(value => value !== '.' && value !== '..'))
const dateTime = text(64).check(Schema.makeFilter(validCalendarInstant))
const time = Schema.Struct({ dateTime, timeZone: Schema.optionalKey(text(128)) })
const date = text(10).check(Schema.isPattern(/^\d{4}-\d\d-\d\d$/), Schema.makeFilter(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value))
const day = Schema.Struct({ date, timeZone: Schema.optionalKey(text(128)) })
const privateProperties = Schema.Record(text(128), text(1024)).check(Schema.makeFilter(value => Object.keys(value).length <= 16))
const correlation = Schema.Struct({ private: privateProperties })
const eventMetadata = {
  id: text(1024),
  htmlLink: Schema.optionalKey(text(4096)),
  extendedProperties: Schema.optionalKey(correlation),
}
const orderedTime=Schema.makeFilter((value:{start:{dateTime:string};end:{dateTime:string}})=>Date.parse(value.start.dateTime)<Date.parse(value.end.dateTime))
const createdEventShape = Schema.Struct({ ...eventMetadata, status: Schema.Literal('confirmed'), start: time, end: time }).check(orderedTime)
const eventShape = Schema.Union([
  Schema.Struct({ ...eventMetadata, status: Schema.Literals(['confirmed', 'tentative']), start: time, end: time }).check(orderedTime),
  Schema.Struct({ ...eventMetadata, status: Schema.Literals(['confirmed', 'tentative']), start: day, end: day }).check(Schema.makeFilter(value=>value.start.date<value.end.date)),
  Schema.Struct({ ...eventMetadata, status: Schema.Literal('cancelled') }),
])
export type GoogleEvent = typeof eventShape.Type
const calendarShape = Schema.Struct({ id: text(1024), summary: text(1024), timeZone: text(128), accessRole: Schema.Literals(['freeBusyReader', 'reader', 'writerWithoutPrivateAccess', 'writer', 'owner']) })
export type GoogleCalendar = typeof calendarShape.Type
const calendarPage = Schema.Struct({ items: Schema.optionalKey(Schema.Array(calendarShape).check(Schema.isMaxLength(250))), nextPageToken: Schema.optionalKey(text(4096)) })
const tokenShape = Schema.Struct({
  access_token: text(16384), token_type: Schema.Literals(['Bearer', 'bearer']),
  refresh_token: Schema.optionalKey(text(16384)),
  id_token: Schema.optionalKey(text(16384)),
  expires_in: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 31536000 }))),
  scope: text(32768).check(Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/)),
})
export type GoogleTokenResponse = { readonly accessToken: string; readonly tokenType: 'Bearer'; readonly refreshToken?: string; readonly idToken?: string; readonly expiresIn?: number; readonly grantedScopes: readonly string[] }
type GoogleEventInput = {
  readonly id: string; readonly summary: string; readonly description?: string
  readonly start: { readonly dateTime: string; readonly timeZone?: string }
  readonly end: { readonly dateTime: string; readonly timeZone?: string }
  readonly extendedProperties: { readonly private: Readonly<Record<string, string>> }
}
const eventInput = Schema.Struct({ id: text(1024).check(Schema.isPattern(/^[0-9a-v]{5,1024}$/)), summary: text(1024), description: Schema.optionalKey(text(8192)), start: time, end: time, extendedProperties: correlation }).check(orderedTime)
const identity = Schema.Struct({ sub: text(255), email: text(320), email_verified: Schema.Boolean })
const signingKeyShape = Schema.Struct({
  kid: text(256), kty: Schema.Literal('RSA'), alg: Schema.Literal('RS256'), use: Schema.Literal('sig'),
  n: text(2048).check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.makeFilter(value => {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.toString('base64url') === value && bytes.length >= 256 && bytes.length <= 1024 && (bytes.length > 256 ? bytes[0] !== 0 : (bytes[0] ?? 0) >= 128)
  })),
  e: text(8).check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.makeFilter(value => {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.length < 1 || bytes.length > 4 || bytes[0] === 0) return false
    const exponent = bytes.readUIntBE(0, bytes.length)
    return exponent > 1 && exponent % 2 === 1
  })),
})
const signingKeysShape = Schema.Struct({ keys: Schema.Array(signingKeyShape).check(Schema.isMinLength(1), Schema.isMaxLength(16), Schema.makeFilter(keys => new Set(keys.map(key => key.kid)).size === keys.length)) })
const interval = Schema.Struct({ start: dateTime, end: dateTime })
const freeBusyShape = Schema.Struct({ calendars: Schema.Record(text(1024), Schema.Struct({ busy: Schema.optionalKey(Schema.Array(interval).check(Schema.isMaxLength(10000))), errors: Schema.optionalKey(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100))) })) })

const API = 'https://www.googleapis.com/calendar/v3'
const TOKEN = 'https://oauth2.googleapis.com'
const MAX_BYTES = 1024 * 1024

function pathId(value: string): string {
  try { return encodeURIComponent(Schema.decodeUnknownSync(identifier)(value)) } catch { throw new CalendarProviderError('rejected') }
}

function httpError(status: number, write: boolean): CalendarProviderError {
  if (status === 401) return new CalendarProviderError('unauthorized')
  if (status === 404) return new CalendarProviderError('not_found')
  if (status === 409) return new CalendarProviderError('conflict')
  if (status === 429) return new CalendarProviderError('rate_limited')
  if (status >= 400 && status < 500) return new CalendarProviderError('rejected')
  return new CalendarProviderError(write ? 'unknown' : 'unavailable')
}

async function readBoundedBody(body:Dispatcher.ResponseData['body'],write:boolean):Promise<Buffer> {
  const chunks:Buffer[]=[]
  let bytes=0
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array) && typeof chunk !== 'string') throw new CalendarProviderError(write?'unknown':'rejected')
    const buffer=Buffer.from(chunk)
    bytes+=buffer.length
    if(bytes>MAX_BYTES)throw new CalendarProviderError(write?'unknown':'rejected')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function decodeRevocation(status:number,body:Buffer):GoogleRevocationResult {
  if(status===200)return 'revoked'
  const value:unknown=JSON.parse(body.toString('utf8'))
  Schema.decodeUnknownSync(Schema.Struct({error:Schema.Literal('invalid_token')}))(value)
  return 'invalid_token'
}

function tokenFailure(value:unknown):CalendarProviderError {
  const failure=Schema.decodeUnknownSync(Schema.Struct({error:text(128)}))(value)
  return new CalendarProviderError(failure.error==='invalid_grant'?'unauthorized':'rejected')
}
function admissionForResponse(url:string,status:number,options:{write?:boolean;revoke?:boolean}):boolean {
  const oauthFailure=(url===`${TOKEN}/token`||options.revoke===true)&&status===400
  if(options.revoke&&status!==200&&status!==400)throw new CalendarRevocationError('unknown')
  if(!oauthFailure&&(status<200||status>=300))throw httpError(status,options.write??false)
  return oauthFailure
}
function decodeCalendarResponse<T>(body:Buffer,status:number,oauthFailure:boolean,revoke:boolean,decode:(value:unknown)=>T):T {
  if(revoke)return decode(decodeRevocation(status,body))
  const value:unknown=JSON.parse(body.toString('utf8'))
  if(oauthFailure)throw tokenFailure(value)
  return decode(value)
}

/** No retry/redirect interceptor is installed. An injected dispatcher remains caller-owned. */
export function createGoogleCalendarClient(config: CalendarConfig, signal: AbortSignal, deadlineAtMs: number, suppliedDispatcher?: Dispatcher) {
  const dispatcher = suppliedDispatcher ?? new Agent({ connections: 2, pipelining: 1, maxOrigins: 3, maxHeaderSize: 16384, maxResponseSize: MAX_BYTES, connectTimeout: 10000, headersTimeout: 10000, bodyTimeout: 10000 })
  const shutdown = new AbortController()
  const active = new Set<Promise<unknown>>()
  let closed = false
  let closing: Promise<void> | undefined

  function invoke<T>(write: boolean, operation: (invocationSignal: AbortSignal) => Promise<T>): Promise<T> {
    if (closed || signal.aborted || shutdown.signal.aborted || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) return Promise.reject(new CalendarProviderError('unavailable'))
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), Math.max(1, Math.min(10000, deadlineAtMs - Date.now())))
    const invocationSignal = AbortSignal.any([signal, shutdown.signal, timeout.signal])
    const pending = (async () => {
      try { return await operation(invocationSignal) } catch (error) {
        if (error instanceof CalendarProviderError) throw error
        throw new CalendarProviderError(write ? 'unknown' : invocationSignal.aborted ? 'unavailable' : 'rejected')
      } finally { clearTimeout(timer) }
    })()
    active.add(pending)
    void pending.then(() => active.delete(pending), () => active.delete(pending))
    return pending
  }

  async function send<T>(url: string, method: 'GET' | 'POST', invocationSignal: AbortSignal, decode: (value: unknown) => T, options: { accessToken?: string; body?: string; form?: boolean; write?: boolean; revoke?: boolean } = {}): Promise<T> {
    if(options.revoke&&invocationSignal.aborted)throw new CalendarRevocationError('not_sent')
    let response: Dispatcher.ResponseData
    try {
      response = await request(url, {
        dispatcher, method, signal: invocationSignal, idempotent: false,
        headersTimeout: 10000, bodyTimeout: 10000,
        headers: { accept: 'application/json', ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}), ...(options.body !== undefined ? { 'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
        ...(options.body !== undefined ? { body: options.body } : {}),
      })
    } catch { throw new CalendarProviderError(options.write ? 'unknown' : 'unavailable') }
    try {
      const oauthFailure=admissionForResponse(url,response.statusCode,options)
      const body=await readBoundedBody(response.body,options.write??false)
      return decodeCalendarResponse(body,response.statusCode,oauthFailure,options.revoke??false,decode)
    } finally { if (!response.body.readableEnded) response.body.destroy() }
  }

  async function tokenRequest(fields: Readonly<Record<string, string>>, invocationSignal: AbortSignal): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({ client_id: Redacted.value(config.clientId), client_secret: Redacted.value(config.clientSecret), ...fields }).toString()
    const parsed = await send(`${TOKEN}/token`, 'POST', invocationSignal, Schema.decodeUnknownSync(tokenShape), { body, form: true })
    const grantedScopes = [...new Set(parsed.scope.split(' '))]
    if (grantedScopes.length > 32) throw new CalendarProviderError('rejected')
    return { accessToken: parsed.access_token, tokenType: 'Bearer', grantedScopes, ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}), ...(parsed.id_token ? { idToken: parsed.id_token } : {}), ...(parsed.expires_in ? { expiresIn: parsed.expires_in } : {}) }
  }

  return {
    exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
      return invoke(false, s => tokenRequest({ grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri }, s))
    },
    refreshTokens(refreshToken: string) { return invoke(false, s => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, s)) },
    revokeToken(token: string):Promise<GoogleRevocationResult> {
      if(closed||signal.aborted||shutdown.signal.aborted||!Number.isFinite(deadlineAtMs)||deadlineAtMs<=Date.now()||typeof token!=='string'||!token||token.length>16384)return Promise.reject(new CalendarRevocationError('not_sent'))
      return invoke(true,s=>send(`${TOKEN}/revoke`,'POST',s,Schema.decodeUnknownSync(Schema.Literals(['revoked','invalid_token'])),{body:new URLSearchParams({token}).toString(),form:true,write:true,revoke:true}))
        .catch(error=>{throw error instanceof CalendarRevocationError?error:new CalendarRevocationError('unknown')})
    },
    userInfo(accessToken: string) {
      return invoke(false, async s => {
        const value = await send('https://openidconnect.googleapis.com/v1/userinfo', 'GET', s, Schema.decodeUnknownSync(identity), { accessToken })
        return { sub: value.sub, email: value.email, emailVerified: value.email_verified }
      })
    },
    signingKeys() {
      return invoke(false, async s => (await send('https://www.googleapis.com/oauth2/v3/certs', 'GET', s, Schema.decodeUnknownSync(signingKeysShape))).keys)
    },
    listCalendars(accessToken: string) {
      return invoke(false, async s => {
        const result: GoogleCalendar[] = []
        const seen = new Set<string>()
        let pageToken: string | undefined
        for (let page = 0; page < 10; page++) {
          const query = new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) })
          const value = await send(`${API}/users/me/calendarList?${query}`, 'GET', s, Schema.decodeUnknownSync(calendarPage), { accessToken })
          result.push(...value.items ?? [])
          if (!value.nextPageToken) return result
          if (seen.has(value.nextPageToken)) throw new CalendarProviderError('rejected')
          pageToken = value.nextPageToken
          seen.add(pageToken)
        }
        throw new CalendarProviderError('rejected')
      })
    },
    freeBusy(accessToken: string, input: { calendarId: string; timeMin: string; timeMax: string }) {
      return invoke(false, async s => {
        Schema.decodeUnknownSync(Schema.Struct({ calendarId: identifier, timeMin: dateTime, timeMax: dateTime }))(input)
        if (Date.parse(input.timeMax) <= Date.parse(input.timeMin)) throw new CalendarProviderError('rejected')
        const value = await send(`${API}/freeBusy`, 'POST', s, Schema.decodeUnknownSync(freeBusyShape), { accessToken, body: JSON.stringify({ timeMin: input.timeMin, timeMax: input.timeMax, items: [{ id: input.calendarId }] }) })
        const calendar = Object.hasOwn(value.calendars, input.calendarId) ? value.calendars[input.calendarId] : undefined
        if (!calendar || calendar.errors?.length || !calendar.busy || calendar.busy.some(busy => Date.parse(busy.end) <= Date.parse(busy.start))) throw new CalendarProviderError('rejected')
        return calendar.busy
      })
    },
    insertEvent(accessToken: string, input: { calendarId: string; event: GoogleEventInput }) {
      return invoke(true, async s => {
        let event: typeof eventInput.Type
        try { event = Schema.decodeUnknownSync(eventInput, { onExcessProperty: 'error' })(input.event) } catch { throw new CalendarProviderError('rejected') }
        const value = await send(`${API}/calendars/${pathId(input.calendarId)}/events?sendUpdates=none`, 'POST', s, Schema.decodeUnknownSync(createdEventShape), { accessToken, body: JSON.stringify(event), write: true })
        if (value.id !== event.id || value.status !== 'confirmed' || Date.parse(value.start.dateTime) !== Date.parse(event.start.dateTime) || Date.parse(value.end.dateTime) !== Date.parse(event.end.dateTime) || Object.entries(event.extendedProperties.private).some(([key, expected]) => value.extendedProperties?.private[key] !== expected)) throw new CalendarProviderError('unknown')
        return value
      })
    },
    getEvent(accessToken: string, input: { calendarId: string; eventId: string }) {
      return invoke(false, async s => {
        const value = await send(`${API}/calendars/${pathId(input.calendarId)}/events/${pathId(input.eventId)}`, 'GET', s, Schema.decodeUnknownSync(eventShape), { accessToken })
        if (value.id !== input.eventId) throw new CalendarProviderError('rejected')
        return value
      })
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true
        shutdown.abort()
        closing = (async () => { await Promise.allSettled([...active]); if (!suppliedDispatcher) await dispatcher.close() })()
      }
      return closing
    },
  }
}
