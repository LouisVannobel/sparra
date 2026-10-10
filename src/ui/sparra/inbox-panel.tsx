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

type InboxTreatmentEffects=Pick<InboxPageEffects,'setPending'|'setFailed'|'setRefused'|'onRefused'>&{setCurrent(update:(page:ListRequestsPage)=>ListRequestsPage):void;setReadFailed(value:boolean):void;setTreating(value:string|null):void}

function applyInboxTreatment(page:ListRequestsPage,requestId:string,treatedAt:string):ListRequestsPage{
  return {...page,requests:page.requests.map(request=>request.id===requestId?{...request,treatedAt}:request)}
}

export async function treatInboxRequest(current:ListRequestsPage,requestId:string,lock:{current:boolean},begin:ReturnType<typeof useRequestAttempt>,onTreat:Props['onTreat'],effects:InboxTreatmentEffects){
  if(lock.current||!current.requests.some(request=>request.id===requestId&&!request.treatedAt))return
  const {signal,live}=begin()
  lock.current=true;effects.setPending(false);effects.setTreating(requestId);effects.setReadFailed(false);effects.setFailed(false)
  try{
    const receipt=await privateResult(onTreat(requestId,signal))
    if(!live())return
    if(receipt.requestId!==requestId)throw new Error('Treatment receipt mismatch')
    effects.setCurrent(latest=>applyInboxTreatment(latest,requestId,receipt.treatedAt))
  }catch(error){await settleInboxFailure(error,live,effects)}
  finally{if(live()){lock.current=false;effects.setTreating(null)}}
}

type InboxRequest=ListRequestsPage['requests'][number]
function InboxContact({contact,locale}:{contact:InboxRequest['contact'];locale:Locale}){
  if(!contact)return null
  return <>{contact.callback_e164&&<p>{contact.callback_e164}</p>}<p>{requestMessages[locale].callbackSource[contact.callback_source]}</p><p>{appMessages[locale].unconfirmed}</p></>
}
function InboxResult({request,locale}:{request:InboxRequest;locale:Locale}){
  const t=appMessages[locale],labels=requestMessages[locale]
  return <>{request.category&&<><strong>{labels.reason}</strong><p>{labels.category[request.category]}</p></>}{request.nextAction&&<><strong>{t.nextAction}</strong><p>{request.nextAction}</p></>}
    <InboxContact contact={request.contact} locale={locale}/>{request.resultAvailability==='available'&&request.resultQuality==='partial'&&<span className="sparra-app-label">{t.partial}</span>}</>
}
function InboxTreatment({request,locale,disabled,treating,onTreat}:{request:InboxRequest;locale:Locale;disabled:boolean;treating:string|null;onTreat(requestId:string):void}){
  if(request.treatedAt)return null
  return <Button label={appMessages[locale].treat} aria-describedby={`inbox-call-${request.id}`} isDisabled={disabled} isLoading={treating===request.id} onClick={()=>onTreat(request.id)}/>
}
function InboxRow({request,locale,disabled,treating,onTreat}:{request:InboxRequest;locale:Locale;disabled:boolean;treating:string|null;onTreat(requestId:string):void}){
  const t=appMessages[locale]
  return <li><div className="sparra-inbox-row-heading" id={`inbox-call-${request.id}`}><a href={`/app/demandes/${request.id}?lang=${locale}`}>{request.summary??t.summaryUnavailable}</a><p><time dateTime={request.admittedAt}>{observedDate(request.admittedAt,locale)}</time></p></div>
    <div className="sparra-app-label sparra-inbox-operator">{request.treatedAt?<time dateTime={request.treatedAt}>{t.treated}</time>:t.untreated}</div><p className="sparra-inbox-status">{t.status[request.status]}</p>
    <InboxResult request={request} locale={locale}/><InboxTreatment request={request} locale={locale} disabled={disabled} treating={treating} onTreat={onTreat}/></li>
}
function InboxRows({requests,locale,disabled,treating,onTreat}:{requests:InboxRequest[];locale:Locale;disabled:boolean;treating:string|null;onTreat(requestId:string):void}){
  if(requests.length===0)return <div className="sparra-inbox-empty"><span className="sparra-empty-icon"><Icon icon="microphone" aria-hidden="true"/></span><p>{appMessages[locale].noCalls}</p></div>
  return <ul className="sparra-inbox">{requests.map(request=><InboxRow key={request.id} request={request} locale={locale} disabled={disabled} treating={treating} onTreat={onTreat}/>)}</ul>
}
function InboxProgress({locale,pending,treating}:{locale:Locale;pending:'more'|'refresh'|null;treating:string|null}){
  const t=appMessages[locale]
  return <>{pending&&<p role="status">{t.loading}</p>}{treating&&<p role="status">{t.pending}</p>}</>
}
function InboxFailures({locale,failed,treatmentFailed}:{locale:Locale;failed:boolean;treatmentFailed:boolean}){
  const t=appMessages[locale]
  return <>{failed&&<p role="alert">{t.unavailable}</p>}{treatmentFailed&&<p role="alert">{t.treatmentUnknown}</p>}</>
}
function InboxHeading({locale,configuration,disabled,pending,onRefresh}:{locale:Locale;configuration:ActivityState['configuration'];disabled:boolean;pending:'more'|'refresh'|null;onRefresh():void}){
  const t=appMessages[locale]
  return <><div className="sparra-page-heading"><Heading level={1}>{t.inbox}</Heading><p>{descriptions[locale]}</p><Button label={t.refresh} isDisabled={disabled} isLoading={pending==='refresh'} onClick={onRefresh}/></div>{!configuration&&<p className="sparra-setup-note"><a href={`/app/entreprise?lang=${locale}`}>{t.configure}</a></p>}</>
}
function InboxMore({locale,cursor,disabled,pending,onMore}:{locale:Locale;cursor:ListRequestsPage['nextCursor'];disabled:boolean;pending:'more'|'refresh'|null;onMore():void}){
  if(!cursor)return null
  return <Button label={appMessages[locale].more} isDisabled={disabled||pending!==null} isLoading={pending==='more'} onClick={onMore}/>
}

export function InboxPanel({locale,state,page,onMore,onTreat,onRefused}:Props){
  const hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState<'more'|'refresh'|null>(null),[failed,setFailed]=useState(false)
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
  const treat=(requestId:string)=>void treatInboxRequest(current,requestId,treatmentLock,begin,onTreat,{setCurrent,setPending:()=>setPending(null),setReadFailed:setFailed,setTreating,setFailed:setTreatmentFailed,setRefused,onRefused})
  if(refused)return <PrivateUnavailable locale={locale}/>
  const controlsDisabled=!hydrated||treating!==null
  return <><InboxHeading locale={locale} configuration={state.configuration} disabled={controlsDisabled} pending={pending} onRefresh={()=>void read('refresh')}/>
    <InboxRows requests={current.requests} locale={locale} disabled={controlsDisabled} treating={treating} onTreat={treat}/>
    <InboxMore locale={locale} cursor={current.nextCursor} disabled={controlsDisabled} pending={pending} onMore={()=>void read('more')}/>
    <InboxProgress locale={locale} pending={pending} treating={treating}/><InboxFailures locale={locale} failed={failed} treatmentFailed={treatmentFailed}/>
  </>
}
