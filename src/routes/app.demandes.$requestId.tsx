import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getRequestDetail, getRequestErasure, markRequestTreated, eraseRequest } from '../modules/sparra/sparra.functions'
import { RequestPanel, type RequestLoaded } from '../ui/sparra/request-panel'
import { privateResult, PrivateUnavailable } from '../ui/sparra/app-shell'
import { appMessages } from '../modules/sparra/messages'

export const Route=createFileRoute('/app/demandes/$requestId')({
  loaderDeps:({search})=>({lang:search.lang}),
  loader:async({deps,params,abortController,parentMatchPromise}):Promise<RequestLoaded>=>{
    try{
      // Finish the parent's native auth lifetime before this protected read.
      await parentMatchPromise;abortController.signal.throwIfAborted()
      try{return {detail:await privateResult(getRequestDetail({data:{requestId:params.requestId},signal:abortController.signal})),receipt:null}}
      catch(error){if(!(error instanceof Response)||error.status!==404)throw error}
      return {detail:null,receipt:await privateResult(getRequestErasure({data:{requestId:params.requestId},signal:abortController.signal}))}
    }catch(error){if(error instanceof Response&&error.status===401)throw redirect({to:'/login',search:{lang:deps.lang,error:undefined}});throw new Error('Request unavailable')}
  },
  head:({match})=>({meta:[{title:appMessages[match.search.lang].details}]}),
  component:Request,
  errorComponent:function RequestUnavailable(){const {lang}=Route.useSearch();return <PrivateUnavailable locale={lang} title={appMessages[lang].details}/>},
})
function Request(){const {lang}=Route.useSearch(),{requestId}=Route.useParams(),loaded=Route.useLoaderData(),router=useRouter(),treat=useServerFn(markRequestTreated),erase=useServerFn(eraseRequest)
  return <RequestPanel key={requestId+lang+JSON.stringify(loaded)} locale={lang} loaded={loaded} onTreat={signal=>treat({data:{requestId},signal})} onErase={signal=>erase({data:{requestId},signal})} onRefused={async()=>{await router.navigate({to:'/login',search:{lang,error:undefined}})}}/>
}
