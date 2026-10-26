import { useRef,useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useRouter } from '@tanstack/react-router'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { ActivityPanel } from '../../src/ui/sparra/activity-panel'
import { CalendarPanel } from '../../src/ui/sparra/calendar-panel'
import { useBusinessNavigation } from '../../src/ui/sparra/use-business-navigation'
import type { ActivityState,ActivityConfigurationDto } from '../../src/modules/sparra/sparra.functions'
import type { CalendarState } from '../../src/modules/calendar/connection.server'
import '../../src/ui/auth/auth.css'
import '../../src/ui/sparra/sparra.css'
const workspace={id:'fixture-workspace',displayName:'Fixture'}
const configuration:ActivityConfigurationDto={workspaceId:workspace.id,revision:1,savedAt:'2026-10-22T00:00:00Z',businessName:'Garage known',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:false,recordingPolicy:'off',recordingContactPhone:null}
const activity:ActivityState={workspace,configuration,localAudioAvailable:true}
const calendar:CalendarState={available:true,status:'connected',accountEmail:'fixture@example.test',selectedCalendar:{id:'calendar',summary:'Observed calendar'},calendars:[{id:'calendar',summary:'Observed calendar',timeZone:'Europe/Paris',accessRole:'writer'}],enabled:false,revision:3,policy:{version:1,timeZone:'Europe/Paris',services:[{id:'service',name:'Known service',durationMinutes:30}],weeklyHours:[{day:1,ranges:[{start:'09:00',end:'12:00'}]}],bufferMinutes:0,noticeMinutes:0}}
function FixtureLink({href,children}:{href:string;children:import('react').ReactNode}){const router=useRouter();return <a href={href} onClick={event=>{event.preventDefault();void router.navigate({href})}}>{children}</a>}
function Business(){
  const {lang,mode}=business.useSearch(),router=useRouter(),guard=useBusinessNavigation(lang)
  const [events,setEvents]=useState<string[]>([]),release=useRef<(()=>void)|null>(null)
  const savedActivity=useRef(activity),submissionKey=useRef('')
  const log=(event:string)=>setEvents(value=>[...value,event])
  return <><FixtureLink href={'/tests/helpers/business-navigation.html?lang='+(lang==='fr'?'en':'fr')+'&mode='+mode}>Language</FixtureLink><FixtureLink href="/other">Other page</FixtureLink><FixtureLink href="/login">Ordinary login</FixtureLink><a href="/document">Document</a>
    <ActivityPanel key={'fixture-workspace:1:'+lang} locale={lang} state={mode==='empty'?{...activity,configuration:null}:activity}
      onNavigationStateChange={guard.onActivityNavigationStateChange}
      externalNavigationPending={guard.externalNavigationPending}
      onEnsure={async()=>workspace} onRead={async()=>{if(mode==='knowledge-lost')log('read-current');return mode==='knowledge-lost'?{...activity,configuration:{...configuration,revision:3}}:savedActivity.current}}
      onImport={async()=>{log('import');if(mode==='knowledge-lost')await new Promise<void>(resolve=>{release.current=resolve});return {captureId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source:{url:'https://example.org/services',capturedAt:'2026-10-26T10:00:00Z',title:'Services',sha256:'a'.repeat(64),passages:[{id:'p1',text:'Vidange 80 €'}]}}}}
      onLookup={async key=>{log(JSON.stringify(key)===submissionKey.current?'lookup-exact':'lookup-wrong');return {status:'confirmed',revision:2,savedAt:configuration.savedAt}}}
      onConfirm={async input=>{const data=input.activity;submissionKey.current=JSON.stringify({draftId:input.draftId,draftVersion:input.draftVersion});log('activity-save');if(mode==='activity-pending')await new Promise<void>(resolve=>{release.current=resolve});if(mode==='refused')throw new Response('refused',{status:401});if(mode==='uncertain'||mode==='knowledge-lost')throw new Error('unknown');savedActivity.current={...activity,configuration:{...configuration,...data,revision:2}};return {status:'confirmed',revision:2,savedAt:configuration.savedAt}}}
      onRefused={()=>router.navigate({href:'/login',ignoreBlocker:true})}
      calendarSlot={<CalendarPanel key={lang+':connected:3'} locale={lang} state={calendar}
        onNavigationStateChange={guard.onCalendarNavigationStateChange} onBeforeConnect={guard.onBeforeConnect}
        onNavigate={url=>router.navigate({href:url,reloadDocument:true,ignoreBlocker:true})}
        onConnect={async()=>{log('connect');if(mode==='connect-held'||mode==='connect-reject')await new Promise<void>(resolve=>{release.current=resolve});if(mode==='connect-reject')throw new Error('rejected');return '/tests/helpers/business-navigation.html?lang=en&mode=arrived'}}
        onDisconnect={async()=>{log('disconnect')}} onRead={async()=>{log('calendar-read');if(mode==='calendar-read-held')await new Promise<void>(resolve=>{release.current=resolve});return {...calendar,revision:4,policy:{...calendar.policy!,services:[{id:'service',name:'Latest service',durationMinutes:60}]}}}}
        onSave={async data=>{log('calendar-save');if(mode==='calendar-save-held'){await new Promise<void>(resolve=>{release.current=resolve});return {...calendar,policy:data.policy,revision:4}}throw new Error('Unknown save outcome')}}/>}/>
    {guard.connectionRefusal&&<p role="alert">{guard.connectionRefusal}</p>}<button onClick={()=>release.current?.()}>Release operation</button><output aria-label="Fixture events">{events.join('\n')}</output>
  </>
}
const root=createRootRoute({component:()=> <Theme theme={neutralTheme} mode="light"><Outlet/></Theme>})
const business=createRoute({getParentRoute:()=>root,path:'/tests/helpers/business-navigation.html',validateSearch:(search:{lang?:unknown;mode?:unknown})=>({lang:search.lang==='en'?'en' as const:'fr' as const,mode:typeof search.mode==='string'?search.mode:''}),component:Business})
const other=createRoute({getParentRoute:()=>root,path:'/other',component:()=> <h1>Other page</h1>})
const login=createRoute({getParentRoute:()=>root,path:'/login',component:()=> <h1>Login recovery</h1>})
const router=createRouter({routeTree:root.addChildren([business,other,login])})
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/> )
