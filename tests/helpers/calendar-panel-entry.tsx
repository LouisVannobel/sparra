import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { CalendarPanel } from '../../src/ui/sparra/calendar-panel'
import type { CalendarState } from '../../src/modules/calendar/connection.server'
import '../../src/ui/auth/auth.css'
import '../../src/ui/sparra/sparra.css'
function Fixture(){
  const [events,setEvents]=useState<string[]>([])
  const mode=new URLSearchParams(location.search).get('mode')
  const state:CalendarState={available:true,status:mode?.startsWith('reconnect')?'reconnect_required':'connected',accountEmail:'owner@example.test',selectedCalendar:null,calendars:[{id:'opaque-real-id',summary:'Observed calendar',timeZone:'Europe/Paris',accessRole:'writer'}],enabled:false,policy:null,revision:0}
  const duplicateCalendars:CalendarState['calendars']=[{id:'calendar-a@example.test',summary:'Appointments',timeZone:'Europe/Paris',accessRole:'writer'},{id:'calendar-b@example.test',summary:'Appointments',timeZone:'Europe/Paris',accessRole:'owner'}]
  return <Theme theme={neutralTheme} mode="light"><CalendarPanel locale="en" state={mode==='duplicates'?{...state,calendars:duplicateCalendars}:state}
    onConnect={async()=>{setEvents(value=>[...value,'connect']);return '#connected'}}
    onDisconnect={async()=>{setEvents(value=>[...value,'disconnect']);if(mode==='reconnect-blocked')throw new Response('Calendar unavailable',{status:409})}}
    onRead={async()=>state}
    onSave={async data=>{setEvents(value=>[...value,JSON.stringify(data)]);throw new Response('fixture conflict',{status:409})}}/>
    <output aria-label="Fixture events">{events.join('\n')}</output></Theme>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
