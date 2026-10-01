import { useEffect, useRef, useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import type { ActivityState, ListRequestsInput, ListRequestsPage } from '../../modules/sparra/sparra.functions'
import { appMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'

type Props={locale:Locale;state:ActivityState;page:ListRequestsPage;onMore(data:ListRequestsInput,signal:AbortSignal):Promise<ListRequestsPage|Response>;onRefused():Promise<void>}
export function InboxPanel({locale,state,page,onMore,onRefused}:Props){
  const t=appMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState(false),[failed,setFailed]=useState(false)
  const attempt=useRef(0),controller=useRef<AbortController|null>(null)
  const [refused,setRefused]=useState(false)
  useEffect(()=>()=>{attempt.current++;controller.current?.abort()},[])
  async function more(){
    if(!current.nextCursor)return
    controller.current?.abort();const owned=new AbortController(),id=++attempt.current;controller.current=owned;const live=()=>!owned.signal.aborted&&attempt.current===id
    setPending(true);setFailed(false)
    try{const next=await privateResult(onMore({cursor:current.nextCursor},owned.signal));if(live())setCurrent({requests:[...current.requests,...next.requests.filter(row=>!current.requests.some(existing=>existing.id===row.id))],nextCursor:next.nextCursor})}
    catch(error){if(live()){if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}setFailed(true)}}finally{if(live())setPending(false)}
  }
  if(refused)return <PrivateUnavailable locale={locale}/>
  const labels=requestMessages[locale]
  return <><Heading level={1}>{t.inbox}</Heading>{!state.configuration&&<p><a href={`/app/entreprise?lang=${locale}`}>{t.configure}</a></p>}
    {current.requests.length===0?<p>{t.noCalls}</p>:<ul className="sparra-inbox">{current.requests.map(request=><li key={request.id}>
      <a href={`/app/demandes/${request.id}?lang=${locale}`}>{request.summary??t.summaryUnavailable}</a>
      <p><time dateTime={request.admittedAt}>{observedDate(request.admittedAt,locale)}</time></p>
      <p>{t.status[request.status]}{request.treatedAt?` — ${t.treated}`:''}</p>
      {request.category&&<><strong>{labels.reason}</strong><p>{labels.category[request.category]}</p></>}
      {request.contact&&<>
        {request.contact.callback_e164&&<p>{request.contact.callback_e164}</p>}
        <p>{labels.callbackSource[request.contact.callback_source]}</p><p>{t.unconfirmed}</p>
      </>}
      {request.resultAvailability==='available'&&request.resultQuality==='partial'&&<span className="sparra-app-label">{t.partial}</span>}
    </li>)}</ul>}
    {current.nextCursor&&<Button label={t.more} isDisabled={!hydrated} isLoading={pending} onClick={()=>void more()}/>} {pending&&<p role="status">{t.loading}</p>}{failed&&<p role="alert">{t.unavailable}</p>}
  </>
}
