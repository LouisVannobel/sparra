import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { CalendarPanel, type CalendarNavigationState } from '../../src/ui/sparra/calendar-panel'
import type { CalendarState } from '../../src/modules/calendar/connection.server'
import type { SaveCalendarPolicy } from '../../src/modules/calendar/policy'
import '../../src/ui/auth/auth.css'
import '../../src/ui/sparra/sparra.css'
const connected:CalendarState={available:true,status:'connected',accountEmail:'owner@example.test',selectedCalendar:null,calendars:[{id:'opaque-real-id',summary:'Observed calendar',timeZone:'Europe/Paris',accessRole:'writer'}],enabled:false,policy:null,revision:0}
const duplicateCalendars:CalendarState['calendars']=[{id:'calendar-a@example.test',summary:'Appointments',timeZone:'Europe/Paris',accessRole:'writer'},{id:'calendar-b@example.test',summary:'Appointments',timeZone:'Europe/Paris',accessRole:'owner'}]
const policy={version:1 as const,timeZone:'Europe/Paris',services:[{id:'service',name:'Known service',durationMinutes:30}],weeklyHours:[{day:1,ranges:[{start:'09:00',end:'12:00'}]}],bufferMinutes:5,noticeMinutes:60}
const known:CalendarState={...connected,calendars:[...connected.calendars,{id:'other-calendar',summary:'Other calendar',timeZone:'Europe/Paris',accessRole:'writer'}],selectedCalendar:connected.calendars[0]!,policy,revision:3}
const latest:CalendarState={...known,revision:7,enabled:true,policy:{...policy,timeZone:'Europe/London',services:[{id:'service',name:'Latest service',durationMinutes:60}],bufferMinutes:20}}

function calendarFixtureState(mode:string) {
  const connection:CalendarState={...connected,status:mode.startsWith('reconnect')?'reconnect_required':'connected'}
  if(mode.startsWith('draft'))return {connection,initial:known}
  if(mode==='duplicates')return {connection,initial:{...connection,calendars:duplicateCalendars}}
  return {connection,initial:connection}
}
async function readCalendarFixture(mode:string,connection:CalendarState,record:(event:string)=>void):Promise<CalendarState> {
  if(mode.endsWith('read-failed'))throw new Response('read unavailable',{status:503})
  if(!mode.startsWith('draft'))return connection
  record('read')
  return mode==='draft-ambiguous-identical'?known:latest
}
async function saveCalendarFixture(mode:string,data:SaveCalendarPolicy,record:(event:string)=>void):Promise<CalendarState> {
  record(JSON.stringify(data))
  if(mode==='draft-success')return {...known,...data,selectedCalendar:known.selectedCalendar,revision:4}
  if(mode.startsWith('draft-ambiguous'))throw new Error('unconfirmed')
  throw new Response('fixture conflict',{status:409})
}
function Fixture(){
  const [events,setEvents]=useState<string[]>([])
  const [navigation,setNavigation]=useState<CalendarNavigationState|null>(null)
  const [guard,setGuard]=useState(false)
  const navigationRelease=useRef<(()=>void)|null>(null)
  const search=new URLSearchParams(location.search),mode=search.get('mode')??''
  const {connection,initial}=calendarFixtureState(mode)
  const record=(event:string)=>setEvents(value=>[...value,event])
  return <Theme theme={neutralTheme} mode="light"><CalendarPanel locale={search.get('locale')==='fr'?'fr':'en'} state={initial}
    onNavigationStateChange={setNavigation}
    onBeforeConnect={mode==='guard'?()=>{setEvents(value=>[...value,'guard']);return guard}:undefined}
    onNavigate={mode==='guard'?async()=>{setEvents(value=>[...value,'navigate']);await new Promise<void>(resolve=>{navigationRelease.current=resolve})}:undefined}
    onConnect={async()=>{setEvents(value=>[...value,'connect']);return '#connected'}}
    onDisconnect={async()=>{setEvents(value=>[...value,'disconnect']);if(mode==='reconnect-blocked')throw new Response('Calendar unavailable',{status:409})}}
    onRead={()=>readCalendarFixture(mode,connection,record)}
    onSave={data=>saveCalendarFixture(mode,data,record)}/>
    {mode==='guard'&&<><button onClick={()=>setGuard(true)}>Allow connect</button><button onClick={()=>navigationRelease.current?.()}>Finish navigation</button></>}
    <output aria-label="Navigation state">{JSON.stringify(navigation)}</output>
    <output aria-label="Fixture events">{events.join('\n')}</output></Theme>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
