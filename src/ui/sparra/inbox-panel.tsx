import { useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import type { ActivityState, ListRequestsInput, ListRequestsPage } from '../../modules/sparra/sparra.functions'
import { appMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'

type Props={locale:Locale;state:ActivityState;page:ListRequestsPage;onMore(data:ListRequestsInput,signal:AbortSignal):Promise<ListRequestsPage|Response>;onRefused():Promise<void>}
export function InboxPanel({locale,state,page,onMore,onRefused}:Props){
  const t=appMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState(false),[failed,setFailed]=useState(false)
  const begin=useRequestAttempt()
  const [refused,setRefused]=useState(false)
  async function more(){
    if(!current.nextCursor)return
    const {signal,live}=begin()
    setPending(true);setFailed(false)
    try{const next=await privateResult(onMore({cursor:current.nextCursor},signal));if(live())setCurrent({requests:[...current.requests,...next.requests.filter(row=>!current.requests.some(existing=>existing.id===row.id))],nextCursor:next.nextCursor})}
    catch(error){if(live()){if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}setFailed(true)}}finally{if(live())setPending(false)}
  }
  if(refused)return <PrivateUnavailable locale={locale}/>
  const labels=requestMessages[locale]
  return <><div className="sparra-page-heading"><Heading level={1}>{t.inbox}</Heading><p>{locale==='fr'?'Les demandes de vos appelants, au même endroit.':'Your callers’ requests, in one place.'}</p></div>{!state.configuration&&<p className="sparra-setup-note"><a href={`/app/entreprise?lang=${locale}`}>{t.configure}</a></p>}
    {current.requests.length===0?<div className="sparra-inbox-empty"><span className="sparra-empty-icon"><Icon icon="microphone" aria-hidden="true"/></span><p>{t.noCalls}</p></div>:<ul className="sparra-inbox">{current.requests.map(request=><li key={request.id}>
      <div className="sparra-inbox-row-heading">
      <a href={`/app/demandes/${request.id}?lang=${locale}`}>{request.summary??t.summaryUnavailable}</a>
      <p><time dateTime={request.admittedAt}>{observedDate(request.admittedAt,locale)}</time></p>
      </div>
      <p className="sparra-inbox-status">{t.status[request.status]}{request.treatedAt?` — ${t.treated}`:''}</p>
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
