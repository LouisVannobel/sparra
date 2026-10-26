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
import { followUpFailure, followUpMessages, type FollowUpFailure } from './follow-up-feedback'
import { bookingMessages } from './calendar-messages'
import { requiresReview, type UpdateRequestFollowUpInput, type RequestFollowUpReceipt } from '../../modules/sparra/follow-up'

export function mergeInboxPage(current: ListRequestsPage, next: ListRequestsPage): ListRequestsPage {
  // Only IDs from the already-loaded page suppress incoming rows.
  return { requests: [...current.requests, ...next.requests.filter(row => !current.requests.some(existing => existing.id === row.id))], nextCursor: next.nextCursor }
}

type Props={locale:Locale;view?:'pending'|'all';state:ActivityState;page:ListRequestsPage;onMore(data:ListRequestsInput,signal:AbortSignal):Promise<ListRequestsPage|Response>;onTreat(input:UpdateRequestFollowUpInput,signal:AbortSignal):Promise<RequestFollowUpReceipt|Response>;onRefused():Promise<void>}
const descriptions={fr:'Les demandes de vos appelants, au même endroit.',en:'Your callers’ requests, in one place.'} as const
type InboxPageEffects={setCurrent(page:ListRequestsPage):void;setPending(value:boolean):void;setFailed(value:boolean):void;setRefused(value:boolean):void;onRefused():Promise<void>}

async function settleInboxFailure(error:unknown,live:()=>boolean,{setFailed,setRefused,onRefused}:Pick<InboxPageEffects,'setFailed'|'setRefused'|'onRefused'>){
  if(!live())return
  if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}
  setFailed(true)
}

export async function loadInboxPage(current:ListRequestsPage,begin:ReturnType<typeof useRequestAttempt>,onMore:Props['onMore'],effects:InboxPageEffects,kind:'more'|'refresh'='more',view?:'pending'|'all'){
  const cursor=current.nextCursor
  const data:ListRequestsInput|null=kind==='refresh'?{...(view?{view}:{})}:cursor?{cursor,...(view?{view}:{})}:null
  if(!data)return
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false)
  try{
    const next=await privateResult(onMore(data,signal))
    if(live())effects.setCurrent(kind==='refresh'?next:mergeInboxPage(current,next))
  }catch(error){await settleInboxFailure(error,live,effects)}finally{if(live())effects.setPending(false)}
}

type InboxTreatmentEffects=Pick<InboxPageEffects,'setPending'|'setFailed'|'setRefused'|'onRefused'>&{setCurrent(update:(page:ListRequestsPage)=>ListRequestsPage):void;setReadFailed(value:boolean):void;setTreating(value:string|null):void;setFailure?(value:FollowUpFailure|null):void}

function applyInboxTreatment(page:ListRequestsPage,shown:ListRequestsPage['requests'][number],receipt:RequestFollowUpReceipt):ListRequestsPage{
  // Only a full reread can restore readability of the retained row content.
  return {...page,requests:page.requests.map(request=>request.id===shown.id&&request.followUp.publicationRevision===shown.followUp.publicationRevision&&request.followUp.decisionToken===shown.followUp.decisionToken?{...request,followUp:{...receipt.followUp,contentReadable:request.followUp.contentReadable&&receipt.followUp.contentReadable},treatedAt:receipt.followUp.firstDeclaredAt}:request)}
}

export async function treatInboxRequest(current:ListRequestsPage,requestId:string,lock:{current:boolean},begin:ReturnType<typeof useRequestAttempt>,onTreat:Props['onTreat'],effects:InboxTreatmentEffects){
  const shown=current.requests.find(request=>request.id===requestId)
  if(lock.current||!shown||!requiresReview(shown.followUp)||!shown.followUp.collectionClosed||!shown.followUp.contentReadable)return
  const {signal,live}=begin()
  lock.current=true;effects.setPending(false);effects.setTreating(requestId);effects.setReadFailed(false);effects.setFailed(false);effects.setFailure?.(null)
  try{
    const receipt=await privateResult(onTreat({requestId,expectedPublicationRevision:shown.followUp.publicationRevision,expectedDecisionToken:shown.followUp.decisionToken,treated:true},signal))
    if(!live())return
    if(receipt.requestId!==requestId||receipt.followUp.publicationRevision!==shown.followUp.publicationRevision||!receipt.followUp.declarationActive)throw new Error('Treatment receipt mismatch')
    effects.setCurrent(latest=>applyInboxTreatment(latest,shown,receipt))
  }catch(error){if(live())effects.setFailure?.(followUpFailure(error));await settleInboxFailure(error,live,effects)}
  finally{if(live()){lock.current=false;effects.setTreating(null)}}
}

type InboxRequest=ListRequestsPage['requests'][number]
function InboxContact({contact,locale,bookingOutcome}:{contact:InboxRequest['contact'];locale:Locale;bookingOutcome:boolean}){
  if(!contact)return null
  return <>{contact.callback_e164&&<p>{contact.callback_e164}</p>}<p>{requestMessages[locale].callbackSource[contact.callback_source]}</p><p>{bookingOutcome?requestMessages[locale].numberUnconfirmed:appMessages[locale].unconfirmed}</p></>
}
function InboxResult({request,locale}:{request:InboxRequest;locale:Locale}){
  const t=appMessages[locale],labels=requestMessages[locale]
  const bookingLabel=request.category==='appointment_to_confirm'?(request.bookingOutcome==='confirmed'?bookingMessages[locale].confirmed:request.bookingOutcome==='cancelled'?bookingMessages[locale].cancelled:null):null
  return <>{request.category&&<><strong>{labels.reason}</strong><p>{bookingLabel??labels.category[request.category]}</p></>}{request.nextAction&&<><strong>{bookingLabel?labels.extractedAction:t.nextAction}</strong><p>{request.nextAction}</p></>}
    <InboxContact contact={request.contact} locale={locale} bookingOutcome={bookingLabel!==null}/>{request.resultAvailability==='available'&&request.resultQuality==='partial'&&<span className="sparra-app-label">{t.partial}</span>}</>
}
function InboxTreatment({request,locale,disabled,treating,onTreat}:{request:InboxRequest;locale:Locale;disabled:boolean;treating:string|null;onTreat(requestId:string):void}){
  if(!requiresReview(request.followUp)||!request.followUp.collectionClosed||!request.followUp.contentReadable)return null
  return <Button variant="primary" label={appMessages[locale].treat} aria-describedby={`inbox-call-${request.id}`} isDisabled={disabled} isLoading={treating===request.id} onClick={()=>onTreat(request.id)}/>
}
function InboxRow({request,locale,disabled,treating,onTreat,view='pending'}:{request:InboxRequest;locale:Locale;disabled:boolean;treating:string|null;onTreat(requestId:string):void;view?:'pending'|'all'}){
  const t=appMessages[locale],excerpt=request.summary===null&&request.resultAvailability==='unavailable'?request.conversationExcerpt:null
  const bookingLabel=request.category==='appointment_to_confirm'?(request.bookingOutcome==='confirmed'?bookingMessages[locale].confirmed:request.bookingOutcome==='cancelled'?bookingMessages[locale].cancelled:null):null
  return <li><div className="sparra-inbox-row-heading" id={`inbox-call-${request.id}`}><a href={`/app/demandes/${request.id}?lang=${locale}&view=${view}`}>{bookingLabel??request.summary??(excerpt?t.conversationExcerpt:t.summaryUnavailable)}</a><p><time dateTime={request.admittedAt}>{observedDate(request.admittedAt,locale)}</time></p></div>
    {excerpt&&<p><q>{excerpt}</q></p>}
    <div className="sparra-app-label sparra-inbox-operator">{requiresReview(request.followUp)?(request.followUp.declarationActive?followUpMessages[locale].newPublication:t.untreated):t.treated}</div><p className="sparra-inbox-status">{t.status[request.status]}</p>
    {!request.followUp.collectionClosed&&<p>{followUpMessages[locale].provisional}</p>}{!request.followUp.contentReadable&&<p>{followUpMessages[locale].unreadable}</p>}<InboxResult request={request} locale={locale}/><InboxTreatment request={request} locale={locale} disabled={disabled} treating={treating} onTreat={onTreat}/></li>
}
function InboxRows({requests,locale,disabled,treating,onTreat,view}:{requests:InboxRequest[];locale:Locale;disabled:boolean;treating:string|null;onTreat(requestId:string):void;view?:'pending'|'all'}){
  if(requests.length===0)return <div className="sparra-inbox-empty"><span className="sparra-empty-icon"><Icon icon="microphone" aria-hidden="true"/></span><p>{appMessages[locale].noCalls}</p></div>
  return <ul className="sparra-inbox">{requests.map(request=><InboxRow key={request.id} view={view} request={request} locale={locale} disabled={disabled} treating={treating} onTreat={onTreat}/>)}</ul>
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
  return <><div className="sparra-page-heading"><Heading level={1}>{t.inbox}</Heading><p>{descriptions[locale]}</p><Button label={t.refresh} isDisabled={disabled} isLoading={pending==='refresh'} isInterruptible onClick={onRefresh}/></div>{!configuration&&<p className="sparra-setup-note"><a href={`/app/entreprise?lang=${locale}`}>{t.configure}</a></p>}</>
}
function InboxMore({locale,cursor,disabled,pending,onMore}:{locale:Locale;cursor:ListRequestsPage['nextCursor'];disabled:boolean;pending:'more'|'refresh'|null;onMore():void}){
  if(!cursor)return null
  return <Button label={appMessages[locale].more} isDisabled={disabled||pending!==null} isLoading={pending==='more'} onClick={onMore}/>
}

export function InboxPanel({locale,state,page,onMore,onTreat,onRefused,view='pending'}:Props){
  const hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState<'more'|'refresh'|null>(null),[failed,setFailed]=useState(false)
  const begin=useRequestAttempt()
  const [failure,setFailure]=useState<FollowUpFailure|null>(null)
  const [refused,setRefused]=useState(false)
  const [treating,setTreating]=useState<string|null>(null),[treatmentFailed,setTreatmentFailed]=useState(false),treatmentLock=useRef(false)
  // A new loader page owns the whole first page, even when every ID is unchanged.
  // Retire reads before paint so old pagination cannot restore its captured rows.
  useLayoutEffect(()=>{begin();treatmentLock.current=false;setCurrent(page);setPending(null);setTreating(null);setFailed(false);setTreatmentFailed(false);setFailure(null);setRefused(false)},[page,view])
  function read(kind:'more'|'refresh'){
    if(treatmentLock.current)return
    setTreatmentFailed(false);setFailure(null)
    return loadInboxPage(current,begin,onMore,{setCurrent,setPending:value=>setPending(value?kind:null),setFailed,setRefused,onRefused},kind,view)
  }
  const treat=(requestId:string)=>void treatInboxRequest(current,requestId,treatmentLock,begin,onTreat,{setCurrent,setPending:()=>setPending(null),setReadFailed:setFailed,setTreating,setFailed:setTreatmentFailed,setFailure,setRefused,onRefused})
  if(refused)return <PrivateUnavailable locale={locale}/>
  const controlsDisabled=!hydrated||treating!==null
  return <><InboxHeading locale={locale} configuration={state.configuration} disabled={controlsDisabled} pending={pending} onRefresh={()=>void read('refresh')}/>
    <nav className="sparra-inbox-views" aria-label={followUpMessages[locale].views}>{(['pending','all'] as const).map(value=><a key={value} href={`/app?lang=${locale}&view=${value}`} aria-current={view===value?'page':undefined}>{followUpMessages[locale][value]}</a>)}</nav>
    <InboxRows view={view} requests={current.requests} locale={locale} disabled={controlsDisabled} treating={treating} onTreat={treat}/>
    <InboxMore locale={locale} cursor={current.nextCursor} disabled={controlsDisabled} pending={pending} onMore={()=>void read('more')}/>
    {failure&&<p role="alert">{followUpMessages[locale][failure]}</p>}<InboxProgress locale={locale} pending={pending} treating={treating}/><InboxFailures locale={locale} failed={failed} treatmentFailed={treatmentFailed&&!failure}/>
  </>
}
