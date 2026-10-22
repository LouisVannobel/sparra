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
      setFeedback:(value:string|null)=>{if(value)published.push(value)},navigate:()=>{published.push('navigate')}}
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
    accept:()=>events.push('accept'),setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:(value:string|null)=>{if(value)events.push(value)},navigate:()=>{events.push('navigate')}}
  await runCalendarAction('disconnect',action)
  expect(events).toEqual(['pending:true','disconnect','read','accept','pending:false'])
  events.length=0
  action.onRead=async()=>{throw new Response('secret-provider-details',{status:409})}
  await runCalendarAction('read',action)
  expect(events).toEqual(['pending:true','Settings changed or an operation is in progress. Refresh before retrying.','pending:false'])
  expect(events.join(' ')).not.toContain('secret-provider-details')
  expect(busy.current).toBe(false)
})


test.each(['reconnect_required','revoking','connecting'] as const)('%s with retained email is never presented as connected',status=>{
  const html=renderToStaticMarkup(<CalendarPanel locale="en" state={{...disconnected,status,accountEmail:'retained@example.test'}} onConnect={unavailable} onSave={unavailable} onDisconnect={unavailable} onRead={unavailable}/>)
  expect(html).not.toContain('Connected account : retained@example.test')
  expect(html).toContain('retained@example.test')
})

test('connect guard precedes every side effect and accepted navigation stays pending until awaited',async()=>{
  const busy={current:false},operation:OperationRef={current:null},events:string[]=[]
  let allow=false,release!:()=>void
  const navigation=new Promise<void>(resolve=>{release=resolve})
  const action={locale:'en' as const,current:{...disconnected,status:'connected' as const},draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:true,busy,operation,
    onBeforeConnect:()=>{events.push('guard');return allow},onConnect:async()=>{events.push('begin');return '/consent'},onDisconnect:async()=>{events.push('disconnect')},onSave:unavailable,onRead:unavailable,accept:()=>{},setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:()=>{},navigate:async()=>{events.push('navigate');await navigation}}
  await runCalendarAction('connect',action)
  expect(events).toEqual(['guard']);expect(busy.current).toBe(false);expect(operation.current).toBe(null)
  allow=true;events.length=0
  const pending=runCalendarAction('connect',action)
  await expect.poll(()=>events).toEqual(['guard','pending:true','disconnect','begin','navigate'])
  expect(busy.current).toBe(true)
  release();await pending
  expect(events).toEqual(['guard','pending:true','disconnect','begin','navigate','pending:false'])
})


test('busy or unhydrated connect never invokes the guard, and aborted navigation rejects without late feedback',async()=>{
  const events:string[]=[],busy={current:false},operation:OperationRef={current:null}
  let reject!:(error:Error)=>void
  const held=new Promise<void>((_resolve,rejectPromise)=>{reject=rejectPromise})
  const action={locale:'en' as const,current:disconnected,draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:false,busy,operation,
    onBeforeConnect:()=>{events.push('guard');return true},onConnect:async()=>'/consent',onDisconnect:unavailable,onSave:unavailable,onRead:unavailable,accept:()=>{},setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:(value:string|null)=>{if(value)events.push(value)},navigate:async()=>{events.push('navigate');await held}}
  await runCalendarAction('connect',action);action.hydrated=true;busy.current=true;await runCalendarAction('connect',action)
  expect(events).toEqual([])
  busy.current=false;const pending=runCalendarAction('connect',action)
  await expect.poll(()=>events).toEqual(['guard','pending:true','navigate'])
  operation.current?.abort();reject(new Error('late navigation failure'));await pending
  expect(events).toEqual(['guard','pending:true','navigate']);expect(busy.current).toBe(false)
})

test.each([
  {status:400,message:'Check the services, durations and booking hours.'},
  {status:409,message:'Settings changed or an operation is in progress. Refresh before retrying.'},
  {status:503,message:'Operation not confirmed. Refresh to check its outcome.'},
  {status:null,message:'Operation not confirmed. Refresh to check its outcome.'},
])('save and read failure $status publish public feedback and only uncertain saves reconcile',async({status,message})=>{
  for(const kind of ['save','read'] as const){
    const busy={current:false},operation:OperationRef={current:null},events:(string|null)[]=[]
    const fail=async():Promise<never>=>{throw status===null?new Error('secret-provider-details'):new Response('secret-provider-details',{status})}
    const action={locale:'en' as const,current:disconnected,draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:true,busy,operation,
      onConnect:unavailable,onDisconnect:unavailable,onSave:fail,onRead:fail,accept:()=>events.push('state'),
      setReconcile:(value:boolean)=>events.push(`reconcile:${value}`),setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:(value:string|null)=>events.push(value),navigate:()=>{events.push('navigate')}}
    await runCalendarAction(kind,action)
    expect(events).toEqual(['pending:true',null,...(kind==='save'&&status!==400?['reconcile:true']:[]),message,'pending:false'])
    expect(busy.current).toBe(false);expect(operation.current).toBe(null)
  }
})

test.each(['read','save'] as const)('aborting a delayed rejected %s excludes late feedback and reconciliation',async kind=>{
  const busy={current:false},operation:OperationRef={current:null},events:(string|null)[]=[]
  let reject!:(error:Response)=>void
  const held=new Promise<CalendarState>((_resolve,rejectPromise)=>{reject=rejectPromise})
  const action={locale:'en' as const,current:disconnected,draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:true,busy,operation,
    onConnect:unavailable,onDisconnect:unavailable,onSave:async()=>held,onRead:async()=>held,accept:()=>events.push('state'),
    setReconcile:(value:boolean)=>events.push(`reconcile:${value}`),setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:(value:string|null)=>events.push(value),navigate:()=>{events.push('navigate')}}
  const pending=runCalendarAction(kind,action)
  operation.current?.abort();reject(new Response('secret-late-failure',{status:409}));await pending
  expect(events).toEqual(['pending:true',null])
  expect(busy.current).toBe(false);expect(operation.current).toBe(null)
})

test('an aborted action settling after controller replacement preserves its replacement',async()=>{
  const busy={current:false},operation:OperationRef={current:null},events:(string|null)[]=[]
  let reject!:(error:Error)=>void
  const held=new Promise<CalendarState>((_resolve,rejectPromise)=>{reject=rejectPromise})
  const action={locale:'en' as const,current:disconnected,draft:{expectedRevision:0,calendarId:'',enabled:false,policy:{version:1 as const,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}},hydrated:true,busy,operation,
    onConnect:unavailable,onDisconnect:unavailable,onSave:async()=>held,onRead:unavailable,accept:()=>events.push('state'),
    setReconcile:(value:boolean)=>events.push(`reconcile:${value}`),setPending:(value:boolean)=>events.push(`pending:${value}`),setFeedback:(value:string|null)=>events.push(value),navigate:()=>{events.push('navigate')}}
  const pending=runCalendarAction('save',action)
  operation.current?.abort()
  const replacement=new AbortController()
  operation.current=replacement
  reject(new Error('superseded save failure'));await pending
  expect(operation.current).toBe(replacement);expect(busy.current).toBe(false)
  expect(events).toEqual(['pending:true',null])
})
