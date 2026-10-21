import { expect, test } from 'vitest'
import { startCalendarProtocolPeer } from '../helpers/calendar-protocol-peer.mjs'
import { calendarFixtureConfig } from '../helpers/calendar-fixture'
import { createGoogleCalendarClient } from '../../src/modules/calendar/google.server'

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
