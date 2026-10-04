import { useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import type { ActivityState, ListRequestsInput, ListRequestsPage } from '../../modules/sparra/sparra.functions'
import { appMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'

export function mergeInboxPage(current: ListRequestsPage, next: ListRequestsPage): ListRequestsPage {
  // Only IDs from the already-loaded page suppress incoming rows.
  return { requests: [...current.requests, ...next.requests.filter(row => !current.requests.some(existing => existing.id === row.id))], nextCursor: next.nextCursor }
}

type Props={locale:Locale;state:ActivityState;page:ListRequestsPage;onMore(data:ListRequestsInput,signal:AbortSignal):Promise<ListRequestsPage|Response>;onRefused():Promise<void>}
type InboxPageEffects={setCurrent(page:ListRequestsPage):void;setPending(value:boolean):void;setFailed(value:boolean):void;setRefused(value:boolean):void;onRefused():Promise<void>}

async function settleInboxFailure(error:unknown,live:()=>boolean,{setFailed,setRefused,onRefused}:Pick<InboxPageEffects,'setFailed'|'setRefused'|'onRefused'>){
  if(!live())return
  if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}
  setFailed(true)
}

export async function loadInboxPage(current:ListRequestsPage,begin:ReturnType<typeof useRequestAttempt>,onMore:Props['onMore'],effects:InboxPageEffects){
  const cursor=current.nextCursor
  if(!cursor)return
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false)
  try{
    const next=await privateResult(onMore({cursor},signal))
    if(live())effects.setCurrent(mergeInboxPage(current,next))
  }catch(error){await settleInboxFailure(error,live,effects)}finally{if(live())effects.setPending(false)}
}

export function InboxPanel({locale,state,page,onMore,onRefused}:Props){
  const t=appMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState(false),[failed,setFailed]=useState(false)
  const begin=useRequestAttempt()
  const [refused,setRefused]=useState(false)
  function more(){return loadInboxPage(current,begin,onMore,{setCurrent,setPending,setFailed,setRefused,onRefused})}
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
