import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CalendarPanel, runCalendarAction } from '../../src/ui/sparra/calendar-panel'
import type { CalendarState } from '../../src/modules/calendar/connection.server'
type OperationRef={current:AbortController|null}
const disconnected:CalendarState={available:true,status:'disconnected',accountEmail:null,selectedCalendar:null,calendars:[],enabled:false,policy:null,revision:0}
const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}
test('a fresh draft contains no invented persisted services or hours and cannot activate by connecting',()=>{
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
})
test('temporary API unavailability preserves the actual connected account and disconnect action',()=>{
  const html=renderToStaticMarkup(<CalendarPanel locale="en" state={{...disconnected,status:'connected',available:false,accountEmail:'observed@example.test'}} onConnect={unavailable} onSave={unavailable} onDisconnect={unavailable} onRead={unavailable}/>)
  expect(html).toContain('Google Calendar is currently unavailable.');expect(html).toContain('observed@example.test');expect(html).toContain('Disconnect Google')
})

test('aborting a reconnect during disconnect prevents dependent consent and late feedback', async()=>{
  const busy={current:false}, operation:OperationRef={current:null}
  const events:string[]=[], feedback:string[]=[]
  let release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  const action={locale:'en' as const,current:{...disconnected,status:'connected' as const},draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:true,busy,operation,
    onConnect:async()=>{events.push('connect');return '/consent'},onDisconnect:async()=>{events.push('disconnect');await held},
    onSave:unavailable,onRead:unavailable,accept:()=>{events.push('accept')},setPending:(value:boolean)=>events.push(`pending:${value}`),
    setFeedback:(value:string|null)=>{if(value)feedback.push(value)},navigate:()=>{events.push('navigate')}}
  const first=runCalendarAction('connect',action)
  await Promise.resolve()
  await runCalendarAction('read',action)
  operation.current?.abort();release();await first
  expect(events).toEqual(['pending:true','disconnect'])
  expect(feedback).toEqual([])
  expect(busy.current).toBe(false)
})

test('aborting a delayed read or save never publishes a late state',async()=>{
  for(const kind of ['read','save'] as const){
    const busy={current:false},operation:OperationRef={current:null},published:string[]=[]
    let release!:(value:CalendarState)=>void
    const held=new Promise<CalendarState>(resolve=>{release=resolve})
    const action={locale:'en' as const,current:disconnected,draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:true,busy,operation,
      onConnect:unavailable,onDisconnect:unavailable,onSave:async()=>held,onRead:async()=>held,
      accept:()=>published.push('state'),setPending:(value:boolean)=>published.push(`pending:${value}`),
      setFeedback:(value:string|null)=>{if(value)published.push(value)},navigate:()=>published.push('navigate')}
    const pending=runCalendarAction(kind,action)
    operation.current?.abort();release(disconnected);await pending
    expect(published).toEqual(['pending:true'])
    expect(busy.current).toBe(false)
  }
})
test('disconnect reads only after revocation and a rejected action releases its lock',async()=>{
  const busy={current:false},operation:OperationRef={current:null},events:string[]=[]
  const draft={expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}}
  const action={locale:'en' as const,current:disconnected,draft,hydrated:true,busy,operation,
    onConnect:unavailable,onSave:unavailable,onDisconnect:async()=>{events.push('disconnect')},onRead:async()=>{events.push('read');return disconnected},
    accept:()=>events.push('accept'),setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:(value:string|null)=>{if(value)events.push(value)},navigate:()=>events.push('navigate')}
  await runCalendarAction('disconnect',action)
  expect(events).toEqual(['pending:true','disconnect','read','accept','pending:false'])
  events.length=0
  action.onRead=async()=>{throw new Response('secret-provider-details',{status:409})}
  await runCalendarAction('read',action)
  expect(events).toEqual(['pending:true','Settings changed or an operation is in progress. Refresh before retrying.','pending:false'])
  expect(events.join(' ')).not.toContain('secret-provider-details')
  expect(busy.current).toBe(false)
})
