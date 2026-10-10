import { useLayoutEffect, useRef, useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import type { ActivityState, ListRequestsInput, ListRequestsPage } from '../../modules/sparra/sparra.functions'
import { appMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'

export function mergeInboxPage(current: ListRequestsPage, next: ListRequestsPage): ListRequestsPage {
  // Only IDs from the already-loaded page suppress incoming rows.
  return { requests: [...current.requests, ...next.requests.filter(row => !current.requests.some(existing => existing.id === row.id))], nextCursor: next.nextCursor }
}

type Props={locale:Locale;state:ActivityState;page:ListRequestsPage;onMore(data:ListRequestsInput,signal:AbortSignal):Promise<ListRequestsPage|Response>;onTreat(requestId:string,signal:AbortSignal):Promise<{requestId:string;treatedAt:string}|Response>;onRefused():Promise<void>}
const descriptions={fr:'Les demandes de vos appelants, au même endroit.',en:'Your callers’ requests, in one place.'} as const
type InboxPageEffects={setCurrent(page:ListRequestsPage):void;setPending(value:boolean):void;setFailed(value:boolean):void;setRefused(value:boolean):void;onRefused():Promise<void>}

async function settleInboxFailure(error:unknown,live:()=>boolean,{setFailed,setRefused,onRefused}:Pick<InboxPageEffects,'setFailed'|'setRefused'|'onRefused'>){
  if(!live())return
  if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}
  setFailed(true)
}

export async function loadInboxPage(current:ListRequestsPage,begin:ReturnType<typeof useRequestAttempt>,onMore:Props['onMore'],effects:InboxPageEffects,kind:'more'|'refresh'='more'){
  const cursor=current.nextCursor
  const data=kind==='refresh'?{}:cursor?{cursor}:null
  if(!data)return
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false)
  try{
    const next=await privateResult(onMore(data,signal))
    if(live())effects.setCurrent(kind==='refresh'?next:mergeInboxPage(current,next))
  }catch(error){await settleInboxFailure(error,live,effects)}finally{if(live())effects.setPending(false)}
}

export function InboxPanel({locale,state,page,onMore,onTreat,onRefused}:Props){
  const t=appMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState<'more'|'refresh'|null>(null),[failed,setFailed]=useState(false)
  const begin=useRequestAttempt()
  const [refused,setRefused]=useState(false)
  const [treating,setTreating]=useState<string|null>(null),[treatmentFailed,setTreatmentFailed]=useState(false),treatmentLock=useRef(false)
  // A new loader page owns the whole first page, even when every ID is unchanged.
  // Retire reads before paint so old pagination cannot restore its captured rows.
  useLayoutEffect(()=>{begin();treatmentLock.current=false;setCurrent(page);setPending(null);setTreating(null);setFailed(false);setTreatmentFailed(false);setRefused(false)},[page])
  function read(kind:'more'|'refresh'){
    if(treatmentLock.current)return
    setTreatmentFailed(false)
    return loadInboxPage(current,begin,onMore,{setCurrent,setPending:value=>setPending(value?kind:null),setFailed,setRefused,onRefused},kind)
  }
  async function treat(requestId:string){
    if(treatmentLock.current||!current.requests.some(request=>request.id===requestId&&!request.treatedAt))return
    const {signal,live}=begin()
    treatmentLock.current=true;setPending(null);setTreating(requestId);setFailed(false);setTreatmentFailed(false)
    try{
      const receipt=await privateResult(onTreat(requestId,signal))
      if(!live())return
      if(receipt.requestId!==requestId)throw new Error('Treatment receipt mismatch')
      setCurrent(latest=>({...latest,requests:latest.requests.map(request=>request.id===requestId?{...request,treatedAt:receipt.treatedAt}:request)}))
    }catch(error){await settleInboxFailure(error,live,{setFailed:setTreatmentFailed,setRefused,onRefused})}
    finally{if(live()){treatmentLock.current=false;setTreating(null)}}
  }
  if(refused)return <PrivateUnavailable locale={locale}/>
  const labels=requestMessages[locale]
  return <><div className="sparra-page-heading"><Heading level={1}>{t.inbox}</Heading><p>{descriptions[locale]}</p><Button label={t.refresh} isDisabled={!hydrated||treating!==null} isLoading={pending==='refresh'} onClick={()=>void read('refresh')}/></div>{!state.configuration&&<p className="sparra-setup-note"><a href={`/app/entreprise?lang=${locale}`}>{t.configure}</a></p>}
    {current.requests.length===0?<div className="sparra-inbox-empty"><span className="sparra-empty-icon"><Icon icon="microphone" aria-hidden="true"/></span><p>{t.noCalls}</p></div>:<ul className="sparra-inbox">{current.requests.map(request=><li key={request.id}>
      <div className="sparra-inbox-row-heading" id={`inbox-call-${request.id}`}>
      <a href={`/app/demandes/${request.id}?lang=${locale}`}>{request.summary??t.summaryUnavailable}</a>
      <p><time dateTime={request.admittedAt}>{observedDate(request.admittedAt,locale)}</time></p>
      </div>
      <div className="sparra-app-label sparra-inbox-operator">{request.treatedAt?<time dateTime={request.treatedAt}>{t.treated}</time>:t.untreated}</div>
      <p className="sparra-inbox-status">{t.status[request.status]}</p>
      {request.category&&<><strong>{labels.reason}</strong><p>{labels.category[request.category]}</p></>}
      {request.nextAction&&<><strong>{t.nextAction}</strong><p>{request.nextAction}</p></>}
      {request.contact&&<>
        {request.contact.callback_e164&&<p>{request.contact.callback_e164}</p>}
        <p>{labels.callbackSource[request.contact.callback_source]}</p><p>{t.unconfirmed}</p>
      </>}
      {request.resultAvailability==='available'&&request.resultQuality==='partial'&&<span className="sparra-app-label">{t.partial}</span>}
      {!request.treatedAt&&<Button label={t.treat} aria-describedby={`inbox-call-${request.id}`} isDisabled={!hydrated||treating!==null} isLoading={treating===request.id} onClick={()=>void treat(request.id)}/>}
    </li>)}</ul>}
    {current.nextCursor&&<Button label={t.more} isDisabled={!hydrated||pending!==null||treating!==null} isLoading={pending==='more'} onClick={()=>void read('more')}/>} {pending&&<p role="status">{t.loading}</p>}{treating&&<p role="status">{t.pending}</p>}{failed&&<p role="alert">{t.unavailable}</p>}{treatmentFailed&&<p role="alert">{t.treatmentUnknown}</p>}
  </>
}
