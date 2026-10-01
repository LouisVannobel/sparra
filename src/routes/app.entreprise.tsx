import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getActivity, saveActivity } from '../modules/sparra/sparra.functions'
import { ensurePersonalWorkspace } from '../modules/workspaces/workspace.functions'
import { ActivityPanel } from '../ui/sparra/activity-panel'
import { privateResult, PrivateUnavailable } from '../ui/sparra/app-shell'
import { appMessages } from '../modules/sparra/messages'

export const Route=createFileRoute('/app/entreprise')({
  loaderDeps:({search})=>({lang:search.lang}),
  loader:async({deps,abortController,parentMatchPromise})=>{
    // Keep the native per-Request auth protocol lifetime sequential in SSR.
    try{await parentMatchPromise;abortController.signal.throwIfAborted();return await privateResult(getActivity({data:{},signal:abortController.signal}))}
    catch(error){if(error instanceof Response&&error.status===401)throw redirect({to:'/login',search:{lang:deps.lang,error:undefined}});throw new Error('Business unavailable')}
  },
  head:({match})=>({meta:[{title:appMessages[match.search.lang].business}]}),
  component:Business,
  errorComponent:()=>{const {lang}=Route.useSearch();return <PrivateUnavailable locale={lang}/>},
})
function Business(){const {lang}=Route.useSearch(),state=Route.useLoaderData(),router=useRouter(),ensure=useServerFn(ensurePersonalWorkspace),save=useServerFn(saveActivity),read=useServerFn(getActivity)
  return <ActivityPanel key={`${state.workspace?.id??'absent'}:${state.configuration?.revision??0}:${lang}`} locale={lang} state={state} onEnsure={async signal=>{const result=await ensure({signal});if(!result)throw new Error('Workspace unavailable');return result}} onSave={(data,signal)=>save({data,signal})} onRead={signal=>read({data:{},signal})} onRefused={async()=>{await router.navigate({to:'/login',search:{lang,error:undefined}})}}/>
}
