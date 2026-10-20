import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CalendarPanel, calendarDraft, calendarFailure } from '../../src/ui/sparra/calendar-panel'
import type { CalendarState } from '../../src/modules/calendar/connection.server'
const disconnected:CalendarState={available:true,status:'disconnected',accountEmail:null,selectedCalendar:null,calendars:[],enabled:false,policy:null,revision:0}
const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}
test('a fresh draft contains no invented persisted services or hours and cannot activate by connecting',()=>{
  expect(calendarDraft(disconnected)).toMatchObject({enabled:false,policy:{timeZone:'Europe/Paris',services:[],weeklyHours:[]}})
  const html=renderToStaticMarkup(<CalendarPanel locale="fr" state={disconnected} onConnect={unavailable} onSave={unavailable} onDisconnect={unavailable} onRead={unavailable}/>)
  expect(html).toContain('Connecter Google');expect(html).not.toContain('Vidange');expect(html).not.toContain('Enregistré')
})
test.each(['fr','en'] as const)('connected %s UI exposes actual account, safe selection and explicit enable with labeled time controls',locale=>{
  const html=renderToStaticMarkup(<CalendarPanel locale={locale} state={{...disconnected,status:'connected',accountEmail:'observed@example.test',calendars:[{id:'opaque-id',summary:'Observed calendar',timeZone:'Europe/Paris',accessRole:'writer'}]}} onConnect={unavailable} onSave={unavailable} onDisconnect={unavailable} onRead={unavailable}/>)
  expect(html).toContain('observed@example.test');expect(html).not.toContain('textarea');expect(html).toContain(locale==='fr'?'Prestations':'Services');expect(html).toContain(locale==='fr'?'Activer les réservations':'Enable bookings')
  expect(html).not.toContain('value="Vidange"');expect(html).not.toContain('checked=""')
})
test('reconnect and revocation remain visible and failure classification never leaks provider errors',()=>{
  const render=(status:CalendarState['status'])=>renderToStaticMarkup(<CalendarPanel locale="en" state={{...disconnected,status}} onConnect={unavailable} onSave={unavailable} onDisconnect={unavailable} onRead={unavailable}/>)
  expect(render('reconnect_required')).toContain('Reconnect Google');expect(render('revoking')).toContain('Disconnection pending')
  expect(calendarFailure(new Response('secret-provider-error',{status:409}))).toBe('conflict')
  expect(calendarFailure(new Error('secret-token'))).toBe('unavailable')
})
test('temporary API unavailability preserves the actual connected account and disconnect action',()=>{
  const html=renderToStaticMarkup(<CalendarPanel locale="en" state={{...disconnected,status:'connected',available:false,accountEmail:'observed@example.test'}} onConnect={unavailable} onSave={unavailable} onDisconnect={unavailable} onRead={unavailable}/>)
  expect(html).toContain('Google Calendar is currently unavailable.');expect(html).toContain('observed@example.test');expect(html).toContain('Disconnect Google')
})
