import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getActivity, saveActivity } from '../modules/sparra/sparra.functions'
import { ensurePersonalWorkspace } from '../modules/workspaces/workspace.functions'
import { useBusinessNavigation } from '../ui/sparra/use-business-navigation'
import { ActivityPanel } from '../ui/sparra/activity-panel'
import { privateResult, PrivateUnavailable } from '../ui/sparra/app-shell'
import { appMessages } from '../modules/sparra/messages'
import { getCalendar, beginCalendarConnection, saveCalendarPolicy, disconnectCalendar } from '../modules/calendar/calendar.functions'
import { CalendarPanel } from '../ui/sparra/calendar-panel'
import type { CalendarState } from '../modules/calendar/connection.server'

const unavailableCalendar:CalendarState={available:false,status:'unavailable',accountEmail:null,selectedCalendar:null,calendars:[],enabled:false,policy:null,revision:0}

export const Route=createFileRoute('/app/entreprise')({
  validateSearch:(search:{calendar?:unknown}):{calendar?:'returned'|'failed'}=>search.calendar==='returned'||search.calendar==='failed'?{calendar:search.calendar}:{},
  loaderDeps:({search})=>({lang:search.lang}),
  loader:async({deps,abortController,parentMatchPromise})=>{
    // Keep the native per-Request auth protocol lifetime sequential in SSR.
    try{await parentMatchPromise;abortController.signal.throwIfAborted();const activity=await privateResult(getActivity({data:{},signal:abortController.signal}));const calendar=await privateResult(getCalendar({data:{},signal:abortController.signal})).catch(()=>unavailableCalendar);return {activity,calendar}}
    catch(error){if(error instanceof Response&&error.status===401)throw redirect({to:'/login',search:{lang:deps.lang,error:undefined}});throw new Error('Business unavailable')}
  },
  head:({match})=>({meta:[{title:appMessages[match.search.lang].business}]}),
  component:Business,
  errorComponent:function BusinessUnavailable(){const {lang}=Route.useSearch();return <PrivateUnavailable locale={lang} title={appMessages[lang].business}/>},
})
function Business(){const {lang,calendar:callback}=Route.useSearch(),{activity:state,calendar}=Route.useLoaderData(),router=useRouter(),ensure=useServerFn(ensurePersonalWorkspace),save=useServerFn(saveActivity),read=useServerFn(getActivity),begin=useServerFn(beginCalendarConnection),savePolicy=useServerFn(saveCalendarPolicy),disconnect=useServerFn(disconnectCalendar),readCalendar=useServerFn(getCalendar)
  const navigation=useBusinessNavigation(lang)
  return <><ActivityPanel onNavigationStateChange={navigation.onActivityNavigationStateChange} externalNavigationPending={navigation.externalNavigationPending} key={`${state.workspace?.id??'absent'}:${state.configuration?.revision??0}:${lang}`} locale={lang} state={state} initialSection={callback?'handling':'establishment'} onEnsure={async signal=>{const result=await ensure({signal});if(!result)throw new Error('Workspace unavailable');return result}} onSave={(data,signal)=>save({data,signal})} onRead={signal=>read({data:{},signal})} onRefused={async()=>{await router.navigate({to:'/login',search:{lang,error:undefined},ignoreBlocker:true})}} calendarSlot={
    <CalendarPanel onNavigationStateChange={navigation.onCalendarNavigationStateChange} onBeforeConnect={navigation.onBeforeConnect} onNavigate={href=>router.navigate({href,reloadDocument:true,ignoreBlocker:true})} key={`${lang}:${calendar.status}:${calendar.revision}`} locale={lang} state={calendar} callbackFailed={callback==='failed'} focusOnEntry={callback!==undefined} onConnect={signal=>begin({data:{locale:lang},signal})} onSave={(data,signal)=>savePolicy({data,signal})} onDisconnect={signal=>disconnect({data:{},signal})} onRead={signal=>readCalendar({data:{},signal})}/>}/>{navigation.connectionRefusal&&<p role="alert">{navigation.connectionRefusal}</p>}</>
}
