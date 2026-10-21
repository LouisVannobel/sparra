import { expect, test } from 'vitest'
import { startCalendarProtocolPeer } from '../helpers/calendar-protocol-peer.mjs'
import { calendarFixtureConfig } from '../helpers/calendar-fixture'
import { createGoogleCalendarClient } from '../../src/modules/calendar/google.server'
import { createHash } from 'node:crypto'

test('owned peer accepts one real PKCE authorization-code exchange and refuses invalid registration',async()=>{
  const peer=await startCalendarProtocolPeer()
  const client=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+10000)
  const verifier='fixture-verifier',redirectUri='https://sparra.example.test/api/calendar/google/callback'
  const authorize=new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorize.searchParams.set('client_id','fixture-calendar-client')
  authorize.searchParams.set('code_challenge_method','S256')
  authorize.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'))
  authorize.searchParams.set('nonce','fixture-nonce')
  authorize.searchParams.set('redirect_uri',redirectUri)
  try{
    const code=peer.register(authorize.toString(),'fixture-subject')
    const token=await client.exchangeCode({code,codeVerifier:verifier,redirectUri})
    expect(token).toMatchObject({accessToken:'fixture-access',refreshToken:'fixture-refresh'})
    expect(token.grantedScopes).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(peer.requests().filter(value=>value.path==='/token')).toHaveLength(1)
    expect(()=>peer.register('https://attacker.example.test/consent','fixture-subject')).toThrow('Calendar peer refused')
    expect(peer.evidence().disallowed).toBe(1)
    await client.close()
    await expect.poll(()=>peer.evidence()).toMatchObject({activeClientSockets:0,activeSockets:0,activeRequests:0})
  }finally{await client.close();await peer.close()}
})

test('default-owned Google Agent joins idle TLS sockets and rejects later work', async () => {
  const peer = await startCalendarProtocolPeer()
  const client = createGoogleCalendarClient(calendarFixtureConfig, new AbortController().signal, Date.now() + 10000)
  try {
    expect(await client.listCalendars('fixture-access')).toEqual([
      { id: 'fixture-calendar', summary: 'Agenda de qualification', timeZone: 'Europe/Paris', accessRole: 'owner' },
      { id: 'fixture-calendar-b', summary: 'Agenda de qualification', timeZone: 'Europe/Paris', accessRole: 'owner' },
    ])
    expect(peer.evidence().activeClientSockets).toBeGreaterThan(0)
    await client.close()
    await expect.poll(() => peer.evidence()).toMatchObject({ activeClientSockets: 0, activeSockets: 0, activeRequests: 0, disallowed: 0 })
    await expect(client.listCalendars('fixture-access')).rejects.toMatchObject({ code: 'unavailable' })
    expect(peer.requests()).toHaveLength(1)
  } finally { await client.close(); await peer.close() }
})

test.each(['hold-headers', 'hold-body'] as const)('default-owned Google Agent cancels %s and joins before peer retirement', async mode => {
  const peer = await startCalendarProtocolPeer()
  const client = createGoogleCalendarClient(calendarFixtureConfig, new AbortController().signal, Date.now() + 10000)
  try {
    peer.setMode(mode)
    const pending = client.listCalendars('fixture-access')
    const outcome = expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    await expect.poll(() => peer.requests().length).toBe(1)
    await client.close(); await outcome
    await expect.poll(() => peer.evidence()).toMatchObject({ activeClientSockets: 0, activeSockets: 0, activeRequests: 0, disallowed: 0 })
  } finally { await client.close(); await peer.close() }
})
