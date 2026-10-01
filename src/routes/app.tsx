import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { getWorkspace } from '../modules/workspaces/workspace.functions'
import { appMessages } from '../modules/sparra/messages'
import { AppShell, PrivateUnavailable, privateResult } from '../ui/sparra/app-shell'
import stylesheet from '../ui/sparra/sparra.css?url'

export const Route=createFileRoute('/app')({
  loaderDeps:({search})=>({lang:search.lang}),
  loader:async({deps,abortController})=>{
    try{return await privateResult(getWorkspace({data:{},signal:abortController.signal}))}
    catch(error){if(error instanceof Response&&error.status===401)throw redirect({to:'/login',search:{lang:deps.lang,error:undefined}});throw new Error('Private workspace unavailable')}
  },
  head:()=>({links:[{rel:'stylesheet',href:stylesheet}]}),
  component:()=>{const {lang}=Route.useSearch();return <AppShell locale={lang}><Outlet/></AppShell>},
  errorComponent:()=>{const {lang}=Route.useSearch();return <AppShell locale={lang}><PrivateUnavailable locale={lang}/></AppShell>},
  pendingMs:150,pendingMinMs:150,
  pendingComponent:()=>{const {lang}=Route.useSearch();return <AppShell locale={lang}><p role="status">{appMessages[lang].loading}</p></AppShell>},
})
