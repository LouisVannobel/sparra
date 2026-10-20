import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAgent, request } from 'undici'
import { readCalendarConfig } from '../../src/modules/calendar/config.server'
import { createGoogleCalendarClient, GOOGLE_CALENDAR_SCOPES } from '../../src/modules/calendar/google.server'

const config = readCalendarConfig({ APP_ORIGIN: 'https://sparra.example', SPARRA_GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client', SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET: 'test-sensitive-secret', SPARRA_CALENDAR_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64url') })!
const event = { id: 'sparra123', summary: 'Entretien', start: { dateTime: '2026-10-21T10:00:00+02:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-10-21T10:30:00+02:00', timeZone: 'Europe/Paris' }, extendedProperties: { private: { sparraOperationId: 'operation-a' } } }
const signingKey = { ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid: 'google-key-a', alg: 'RS256', use: 'sig' }
const cleanups: Array<() => Promise<void>> = []
function setup(deadline = Date.now() + 10000) {
  const agent = new MockAgent({ enableCallHistory: true })
  agent.disableNetConnect()
  const controller = new AbortController()
  const client = createGoogleCalendarClient(config, controller.signal, deadline, agent)
  cleanups.push(async () => { await client.close(); await agent.close() })
  return { agent, client, controller, google: agent.get('https://www.googleapis.com'), oauth: agent.get('https://oauth2.googleapis.com') }
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('native Google boundary', () => {
  it('uses the exact shared-calendar event and freebusy scopes', () => {
    expect(GOOGLE_CALENDAR_SCOPES).toEqual(['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.events'])
  })
  it('exchanges code and PKCE only at the fixed token endpoint; validates token fields/scopes', async () => {
    const { client, oauth, agent } = setup()
    oauth.intercept({ path: '/token', method: 'POST', body: body => {
      const form = new URLSearchParams(body)
      return form.get('code_verifier') === 'verifier' && form.get('client_secret') === 'test-sensitive-secret' && form.get('grant_type') === 'authorization_code'
    } }).reply(200, { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' ') })
    expect(await client.exchangeCode({ code: 'code', codeVerifier: 'verifier', redirectUri: 'https://sparra.example/api/calendar/callback' })).toEqual({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', expiresIn: 3600, grantedScopes: GOOGLE_CALENDAR_SCOPES })
    agent.assertNoPendingInterceptors()
  })
  it('propagates the bounded OIDC ID token for initial identity verification', async () => {
    const { client, oauth } = setup()
    oauth.intercept({ path: '/token', method: 'POST' }).reply(200, { access_token: 'access', token_type: 'Bearer', scope: 'openid email', id_token: 'test.header.signature' })
    expect(await client.exchangeCode({ code: 'code', codeVerifier: 'verifier', redirectUri: 'https://sparra.example/api/calendar/callback' })).toMatchObject({ idToken: 'test.header.signature', grantedScopes: ['openid', 'email'] })
  })
  it.each(['', 'x'.repeat(16385), 42])('rejects malformed optional ID tokens without retaining them', async idToken => {
    const { client, oauth } = setup()
    oauth.intercept({ path: '/token', method: 'POST' }).reply(200, { access_token: 'access', token_type: 'Bearer', scope: 'openid', id_token: idToken })
    await expect(client.exchangeCode({ code: 'code', codeVerifier: 'verifier', redirectUri: 'https://sparra.example/api/calendar/callback' })).rejects.toMatchObject({ code: 'rejected' })
  })
  it.each([
    { access_token: '', token_type: 'Bearer', scope: 'openid' },
    { access_token: 'sensitive', token_type: 'Basic', scope: 'openid' },
    { access_token: 'sensitive', token_type: 'Bearer', expires_in: -1, scope: 'openid' },
    { access_token: 'sensitive', token_type: 'Bearer', scope: 'bad\nsecret' },
    { access_token: 'sensitive', token_type: 'Bearer' },
  ])('rejects malformed token responses without retaining their contents', async data => {
    const { client, oauth } = setup()
    oauth.intercept({ path: '/token', method: 'POST' }).reply(200, data)
    await expect(client.refreshTokens('refresh-sensitive')).rejects.toMatchObject({ code: 'rejected', message: 'Calendar provider rejected' })
  })
  it('refreshes and revokes using POST form bodies and no secret URL parameter', async () => {
    const { client, oauth, agent } = setup()
    oauth.intercept({ path: '/token', method: 'POST', body: /grant_type=refresh_token/ }).reply(200, { access_token: 'fresh', token_type: 'Bearer', scope: 'openid' })
    oauth.intercept({ path: '/revoke', method: 'POST', body: 'token=refresh-sensitive' }).reply(200, '')
    expect(await client.refreshTokens('refresh-sensitive')).toMatchObject({ accessToken: 'fresh', grantedScopes: ['openid'] })
    await client.revokeToken('refresh-sensitive')
    agent.assertNoPendingInterceptors()
  })
  it('identifies lost refresh authorization from OAuth invalid_grant safely', async () => {
    const { client, oauth } = setup()
    oauth.intercept({ path: '/token', method: 'POST' }).reply(400, { error: 'invalid_grant', error_description: 'sensitive account detail' })
    await expect(client.refreshTokens('revoked')).rejects.toMatchObject({ code: 'unauthorized' })
  })
  it('returns typed revoke confirmation and the exact terminal invalid_token response',async()=>{
    const {client,oauth}=setup()
    oauth.intercept({path:'/revoke',method:'POST'}).reply(200,'')
    expect(await client.revokeToken('valid')).toBe('revoked')
    oauth.intercept({path:'/revoke',method:'POST'}).reply(400,{error:'invalid_token',error_description:'private account detail'})
    expect(await client.revokeToken('expired')).toBe('invalid_token')
  })
  it.each([{error:'invalid_request'},{error:'invalid_grant'},{error:'INVALID_TOKEN'},'invalid_token',{error:42}])('never accepts another revoke 400 as terminal success: %j',async body=>{
    const {client,oauth}=setup();oauth.intercept({path:'/revoke',method:'POST'}).reply(400,body)
    await expect(client.revokeToken('secret')).rejects.toMatchObject({code:'unknown',outcome:'unknown'})
  })
  it('keeps accepted revoke with a lost response unknown after local close, without retry',async()=>{
    const {client,oauth,agent}=setup(Date.now()+50);let accepted=0
    oauth.intercept({path:'/revoke',method:'POST'}).reply(()=>{accepted++;return {statusCode:200,data:''}}).delay(200)
    await expect(client.revokeToken('secret')).rejects.toMatchObject({code:'unknown',outcome:'unknown'})
    await client.close();expect(accepted).toBe(1);expect(agent.getCallHistory()?.calls()).toHaveLength(1)
  })
  it('identifies refusal before dispatch and bounds revoke error bodies',async()=>{
    const first=setup();first.controller.abort()
    await expect(first.client.revokeToken('secret')).rejects.toMatchObject({code:'unavailable',outcome:'not_sent'})
    expect(first.agent.getCallHistory()?.calls()).toHaveLength(0)
    const second=setup();second.oauth.intercept({path:'/revoke',method:'POST'}).reply(400,'x'.repeat(1_048_577))
    await expect(second.client.revokeToken('secret')).rejects.toMatchObject({code:'unknown',outcome:'unknown'})
  })
  it('reads identity from the fixed userinfo endpoint with a bearer header', async () => {
    const { client, agent } = setup()
    agent.get('https://openidconnect.googleapis.com').intercept({ path: '/v1/userinfo', headers: { authorization: 'Bearer access-sensitive' } }).reply(200, { sub: 'google-user', email: 'owner@example.test', email_verified: true, name: 'ignored' })
    expect(await client.userInfo('access-sensitive')).toEqual({ sub: 'google-user', email: 'owner@example.test', emailVerified: true })
  })
  it('loads bounded public signing keys only from fixed Google certs without authorization', async () => {
    const { client, google, agent } = setup()
    google.intercept({ path: '/oauth2/v3/certs', method: 'GET' }).reply(200, { keys: [{ ...signingKey, unrelated: 'discarded' }] })
    expect(await client.signingKeys()).toEqual([signingKey])
    const sent = agent.getCallHistory()?.firstCall()
    expect(sent?.fullUrl).toBe('https://www.googleapis.com/oauth2/v3/certs')
    expect(sent?.headers).not.toHaveProperty('authorization')
  })
  it.each([
    { keys: [] },
    { keys: Array.from({ length: 17 }, (_, index) => ({ ...signingKey, kid: `key-${index}` })) },
    { keys: [signingKey, signingKey] },
    { keys: [{ ...signingKey, kty: 'EC' }] },
    { keys: [{ ...signingKey, alg: 'none' }] },
    { keys: [{ ...signingKey, use: 'enc' }] },
    { keys: [{ ...signingKey, n: 'not base64url' }] },
    { keys: [{ ...signingKey, n: 'AQAB' }] },
    { keys: [{ ...signingKey, e: 'AA' }] },
  ])('rejects malformed, ambiguous or excessive signing key sets safely', async response => {
    const { client, google } = setup()
    google.intercept({ path: '/oauth2/v3/certs' }).reply(200, response)
    await expect(client.signingKeys()).rejects.toMatchObject({ code: 'rejected' })
  })
  it('lists finite pages with encoded page tokens and discards unused provider fields', async () => {
    const { client, google } = setup()
    google.intercept({ path: '/calendar/v3/users/me/calendarList?maxResults=250' }).reply(200, { items: [{ id: 'a', summary: 'A', timeZone: 'Europe/Paris', accessRole: 'writer', unknown: 'ignored' }], nextPageToken: 'a/b +?' })
    google.intercept({ path: '/calendar/v3/users/me/calendarList?maxResults=250&pageToken=a%2Fb+%2B%3F' }).reply(200, { items: [{ id: 'b', summary: 'B', timeZone: 'UTC', accessRole: 'owner' }] })
    expect(await client.listCalendars('access-sensitive')).toEqual([{ id: 'a', summary: 'A', timeZone: 'Europe/Paris', accessRole: 'writer' }, { id: 'b', summary: 'B', timeZone: 'UTC', accessRole: 'owner' }])
  })
  it('retains effective write access without private-event visibility from CalendarList', async () => {
    const { client, google } = setup()
    google.intercept({ path: '/calendar/v3/users/me/calendarList?maxResults=250' }).reply(200, { items: [{ id: 'shared', summary: 'Shared', timeZone: 'Europe/Paris', accessRole: 'writerWithoutPrivateAccess' }] })
    expect(await client.listCalendars('access')).toEqual([{ id: 'shared', summary: 'Shared', timeZone: 'Europe/Paris', accessRole: 'writerWithoutPrivateAccess' }])
  })
  it('rejects endless pagination', async () => {
    const { client, google } = setup()
    google.intercept({ path: /\/calendarList\?/ }).reply(200, { nextPageToken: 'same', items: [] }).persist()
    await expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'rejected' })
  })
  it('bounds unique Calendar list pages too', async () => {
    const { client, google, agent } = setup()
    let page = 0
    google.intercept({ path: /\/calendarList\?/ }).reply(() => ({ statusCode: 200, data: { nextPageToken: `page-${++page}`, items: [] } })).persist()
    await expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'rejected' })
    expect(agent.getCallHistory()?.calls().length).toBeLessThanOrEqual(10)
  })
  it('does not interpret a partial freeBusy error as available', async () => {
    const { client, google } = setup()
    google.intercept({ path: '/calendar/v3/freeBusy', method: 'POST' }).reply(200, { calendars: { 'a/b': { errors: [{ reason: 'notFound' }], busy: [] } } })
    await expect(client.freeBusy('access', { calendarId: 'a/b', timeMin: event.start.dateTime, timeMax: event.end.dateTime })).rejects.toMatchObject({ code: 'rejected' })
  })
  it('returns validated busy intervals', async () => {
    const { client, google } = setup()
    google.intercept({ path: '/calendar/v3/freeBusy', method: 'POST', body: JSON.stringify({ timeMin: event.start.dateTime, timeMax: event.end.dateTime, items: [{ id: 'a/b' }] }) }).reply(200, { calendars: { 'a/b': { busy: [{ start: event.start.dateTime, end: event.end.dateTime }] } } })
    expect(await client.freeBusy('access', { calendarId: 'a/b', timeMin: event.start.dateTime, timeMax: event.end.dateTime })).toEqual([{ start: event.start.dateTime, end: event.end.dateTime }])
  })
  it('rejects invalid freeBusy request intervals before sending', async () => {
    const { client, agent } = setup()
    await expect(client.freeBusy('access', { calendarId: 'a', timeMin: event.end.dateTime, timeMax: event.start.dateTime })).rejects.toMatchObject({ code: 'rejected' })
    expect(agent.getCallHistory()?.calls()).toHaveLength(0)
  })
  it('rejects URL-normalizing dot segments before sending', async () => {
    const { client, agent } = setup()
    await expect(client.getEvent('access', { calendarId: '..', eventId: '..' })).rejects.toMatchObject({ code: 'rejected' })
    expect(agent.getCallHistory()?.calls()).toHaveLength(0)
  })
  it('encodes calendar and event paths and preserves verified creation identity', async () => {
    const { client, google, agent } = setup()
    google.intercept({ path: '/calendar/v3/calendars/shared%2Fcalendar%40example.test/events?sendUpdates=none', method: 'POST', body: JSON.stringify(event) }).reply(200, { ...event, status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/event?eid=example' })
    expect(await client.insertEvent('access', { calendarId: 'shared/calendar@example.test', event })).toMatchObject({ id: event.id, extendedProperties: event.extendedProperties })
    google.intercept({ path: '/calendar/v3/calendars/shared%2Fcalendar%40example.test/events/a%2Fb%3F' }).reply(200, { ...event, id: 'a/b?', status: 'confirmed' })
    expect(await client.getEvent('access', { calendarId: 'shared/calendar@example.test', eventId: 'a/b?' })).toMatchObject({ id: 'a/b?' })
    agent.assertNoPendingInterceptors()
    expect(agent.getCallHistory()?.calls()).toHaveLength(2)
  })
  it('keeps a mismatched creation identity uncertain', async () => {
    const { client, google } = setup()
    google.intercept({ path: /\/events\?/, method: 'POST' }).reply(200, { ...event, id: 'other', status: 'confirmed' })
    await expect(client.insertEvent('access', { calendarId: 'a', event })).rejects.toMatchObject({ code: 'unknown' })
  })
  it('observes a sparse cancelled event with its stable identity intact', async () => {
    const { client, google } = setup()
    google.intercept({ path: '/calendar/v3/calendars/a/events/sparra123' }).reply(200, { id: 'sparra123', status: 'cancelled' })
    expect(await client.getEvent('access', { calendarId: 'a', eventId: 'sparra123' })).toEqual({ id: 'sparra123', status: 'cancelled' })
  })
  it('observes an event manually changed to all-day with date-only boundaries', async () => {
    const { client, google } = setup()
    const observed = { id: 'sparra123', status: 'confirmed', start: { date: '2026-10-21' }, end: { date: '2026-10-22' }, extendedProperties: event.extendedProperties }
    google.intercept({ path: '/calendar/v3/calendars/a/events/sparra123' }).reply(200, observed)
    expect(await client.getEvent('access', { calendarId: 'a', eventId: 'sparra123' })).toEqual(observed)
  })
  it.each([
    { id: 'sparra123', status: 'confirmed' },
    { id: 'sparra123', status: 'confirmed', start: { date: '2026-10-21' }, end: event.end },
    { id: 'sparra123', status: 'confirmed', start: { date: '2026-02-30' }, end: { date: '2026-03-01' } },
  ])('rejects incomplete or inconsistent ordinary observations safely', async observed => {
    const { client, google } = setup()
    google.intercept({ path: '/calendar/v3/calendars/a/events/sparra123' }).reply(200, observed)
    await expect(client.getEvent('access', { calendarId: 'a', eventId: 'sparra123' })).rejects.toMatchObject({ code: 'rejected' })
  })
  it.each([
    { id: 'sparra123', status: 'cancelled' },
    { ...event, status: 'cancelled' },
    { ...event, status: 'confirmed', start: { date: '2026-10-21' }, end: { date: '2026-10-22' } },
  ])('never accepts cancelled or date-only observations as verified timed creation', async observed => {
    const { client, google } = setup()
    google.intercept({ path: /\/events\?/, method: 'POST' }).reply(200, observed)
    await expect(client.insertEvent('access', { calendarId: 'a', event })).rejects.toMatchObject({ code: 'unknown' })
  })
  it('accepts an equivalent Google time serialization for verified creation', async () => {
    const { client, google } = setup()
    google.intercept({ path: /\/events\?/, method: 'POST' }).reply(200, { ...event, status: 'confirmed', start: { ...event.start, dateTime: '2026-10-21T08:00:00Z' }, end: { ...event.end, dateTime: '2026-10-21T08:30:00Z' } })
    expect(await client.insertEvent('access', { calendarId: 'a', event })).toMatchObject({ id: event.id, status: 'confirmed' })
  })
  it('rejects attendee payloads before dispatching creation', async () => {
    const { client } = setup()
    const withGuests = { ...event, attendees: [{ email: 'guest@example.test' }] }
    await expect(client.insertEvent('access', { calendarId: 'a', event: withGuests })).rejects.toMatchObject({ code: 'rejected' })
  })
  it.each([[401, 'unauthorized'], [403, 'rejected'], [404, 'not_found'], [409, 'conflict'], [429, 'rate_limited'], [500, 'unknown'], [503, 'unknown'], [302, 'unknown']])('maps creation HTTP %i to safe %s without retry', async (status, code) => {
    const { client, google, agent } = setup()
    google.intercept({ path: /\/events\?/, method: 'POST' }).reply(Number(status), { error: 'provider-sensitive' }, { headers: { location: 'https://attacker.invalid/' } })
    try { await client.insertEvent('access', { calendarId: 'a', event }); expect.fail('unexpected success') } catch (error) {
      expect(error).toMatchObject({ code, message: `Calendar provider ${code}` })
      expect(error).not.toHaveProperty('cause')
      expect(JSON.stringify(error)).not.toContain('provider-sensitive')
    }
    agent.assertNoPendingInterceptors()
    expect(agent.getCallHistory()?.calls()).toHaveLength(1)
  })
  it('preserves POST network uncertainty and never retries', async () => {
    const { client, google, agent } = setup()
    google.intercept({ path: /\/events\?/, method: 'POST' }).replyWithError(new Error('sensitive network body'))
    await expect(client.insertEvent('access', { calendarId: 'a', event })).rejects.toMatchObject({ code: 'unknown' })
    agent.assertNoPendingInterceptors()
    expect(agent.getCallHistory()?.calls()).toHaveLength(1)
  })
  it('bounds response bytes', async () => {
    const { client, google } = setup()
    google.intercept({ path: /\/calendarList\?/ }).reply(200, 'x'.repeat(1_048_577))
    await expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'rejected' })
  })
  it('keeps creation timeout uncertain and joins cancellation before close resolves', async () => {
    const { client, google } = setup(Date.now() + 25)
    google.intercept({ path: /\/events\?/, method: 'POST' }).reply(200, { ...event, status: 'confirmed' }).delay(100)
    await expect(client.insertEvent('access', { calendarId: 'a', event })).rejects.toMatchObject({ code: 'unknown' })
    await client.close()
  })
  it('caps invocation time at ten seconds even with a distant owner deadline', async () => {
    vi.useFakeTimers()
    try {
      const { client, google } = setup(Date.now() + 60000)
      google.intercept({ path: /\/calendarList\?/ }).reply(200, { items: [] }).delay(20000)
      const pending = expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'unavailable' })
      await vi.advanceTimersByTimeAsync(10000)
      await pending
      await client.close()
    } finally { vi.useRealTimers() }
  })
  it('aborts in-flight reads, joins them and rejects later work on close', async () => {
    const { client, google, controller } = setup()
    google.intercept({ path: /\/calendarList\?/ }).reply(200, { items: [] }).delay(100)
    const pending = expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'unavailable' })
    controller.abort(new Error('sensitive caller reason'))
    await client.close()
    await pending
    await expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('close itself cancels and joins work while leaving the injected transport caller-owned', async () => {
    const { client, google, agent } = setup()
    google.intercept({ path: /\/calendarList\?/ }).reply(200, { items: [] }).delay(100)
    const pending = expect(client.listCalendars('access')).rejects.toMatchObject({ code: 'unavailable' })
    await client.close()
    await pending
    google.intercept({ path: '/caller-owned' }).reply(200, 'usable')
    const response = await request('https://www.googleapis.com/caller-owned', { dispatcher: agent })
    expect(await response.body.text()).toBe('usable')
  })
})
