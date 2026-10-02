import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getActivity, listRequests } from '../modules/sparra/sparra.functions'
import { InboxPanel } from '../ui/sparra/inbox-panel'
import { privateResult, PrivateUnavailable } from '../ui/sparra/app-shell'
import { appMessages } from '../modules/sparra/messages'

export const Route=createFileRoute('/app/')({
  loaderDeps:({search})=>({lang:search.lang}),
  loader:async({deps,abortController,parentMatchPromise})=>{
    // Native auth uses one protocol lifetime per SSR Request. Finish the
    // parent read before opening the child's protected principal invocation.
    try{await parentMatchPromise;abortController.signal.throwIfAborted();const state=await privateResult(getActivity({data:{},signal:abortController.signal}));const page=await privateResult(listRequests({data:{},signal:abortController.signal}));return {state,page}}
    catch(error){if(error instanceof Response&&error.status===401)throw redirect({to:'/login',search:{lang:deps.lang,error:undefined}});throw new Error('Inbox unavailable')}
  },
  head:({match})=>({meta:[{title:appMessages[match.search.lang].inbox}]}),
  component:Inbox,
  errorComponent:function InboxUnavailable(){const {lang}=Route.useSearch();return <PrivateUnavailable locale={lang}/>},
})
function Inbox(){const {lang}=Route.useSearch(),loaded=Route.useLoaderData(),router=useRouter(),more=useServerFn(listRequests)
  return <InboxPanel key={loaded.page.requests.map(row=>row.id).join(',')+lang} locale={lang} {...loaded} onMore={(data,signal)=>more({data,signal})} onRefused={async()=>{await router.navigate({to:'/login',search:{lang,error:undefined}})}}/>
}
