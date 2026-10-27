import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import type { EraseReceipt, RequestDetailDto } from '../../modules/sparra/sparra.functions'
import { appMessages, activityMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'
import { requiresReview } from '../../modules/sparra/follow-up'
import { followUpFailure, followUpMessages, type FollowUpFailure } from './follow-up-feedback'
import { bookingMessages } from './calendar-messages'
import type { UpdateRequestFollowUpInput, RequestFollowUpReceipt } from '../../modules/sparra/follow-up'
import { RequestCorrection, type CorrectionAttempt, type RequestCorrectionOperations } from './request-correction'

export type RequestLoaded={detail:RequestDetailDto|null;receipt:EraseReceipt|null}
type Props=Partial<RequestCorrectionOperations>&{locale:Locale;loaded:RequestLoaded;view?:'pending'|'all';onRefresh?(signal:AbortSignal):Promise<RequestLoaded|Response>;onTreat(input:UpdateRequestFollowUpInput,signal:AbortSignal):Promise<RequestFollowUpReceipt|Response>;onErase(signal:AbortSignal):Promise<EraseReceipt|Response>;onRefused():Promise<void>}
type RequestActionEffects={setCurrent(loaded:RequestLoaded):void;setPending(value:boolean):void;setFailed(value:boolean):void;setFailure?(value:FollowUpFailure|null):void;setRefused(value:boolean):void;onRefused():Promise<void>}

async function consumeTreatAction(treated:boolean,current:RequestLoaded,signal:AbortSignal,live:()=>boolean,onTreat:Props['onTreat'],setCurrent:RequestActionEffects['setCurrent']){
  const shown=current.detail
  if(!shown)return
  const result=await privateResult(onTreat({requestId:shown.id,expectedPublicationRevision:shown.followUp.publicationRevision,expectedDecisionToken:shown.followUp.decisionToken,treated},signal))
  if(result.requestId!==shown.id||result.followUp.publicationRevision!==shown.followUp.publicationRevision||result.followUp.declarationActive!==treated)throw new Error('Treatment receipt mismatch')
  // A decision receipt cannot restore content that was not part of the response.
  if(live())setCurrent({...current,detail:current.detail?{...current.detail,treatedAt:result.followUp.firstDeclaredAt,followUp:{...result.followUp,contentReadable:shown.followUp.contentReadable&&result.followUp.contentReadable}}:null})
}

async function consumeEraseAction(signal:AbortSignal,live:()=>boolean,onErase:Props['onErase'],setCurrent:RequestActionEffects['setCurrent']){
  const receipt=await privateResult(onErase(signal))
  if(live())setCurrent({detail:null,receipt})
}

async function settleRequestActionFailure(error:unknown,live:()=>boolean,{setFailed,setFailure,setRefused,onRefused}:Pick<RequestActionEffects,'setFailed'|'setFailure'|'setRefused'|'onRefused'>){
  if(!live())return
  if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}
  setFailure?.(followUpFailure(error));setFailed(true)
}

export async function performRequestAction(kind:'treat'|'revoke'|'erase',current:RequestLoaded,begin:ReturnType<typeof useRequestAttempt>,onTreat:Props['onTreat'],onErase:Props['onErase'],effects:RequestActionEffects){
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false);effects.setFailure?.(null)
  try{
    if(kind!=='erase')await consumeTreatAction(kind==='treat',current,signal,live,onTreat,effects.setCurrent)
    else await consumeEraseAction(signal,live,onErase,effects.setCurrent)
  }catch(error){await settleRequestActionFailure(error,live,effects)}finally{if(live())effects.setPending(false)}
}

async function refreshRequest(begin:ReturnType<typeof useRequestAttempt>,onRefresh:NonNullable<Props['onRefresh']>,effects:Required<RequestActionEffects>){
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false);effects.setFailure(null)
  try{
    const next=await privateResult(onRefresh(signal))
    if(live())effects.setCurrent(next)
  }catch(error){await settleRequestActionFailure(error,live,{setFailed:effects.setFailed,setRefused:effects.setRefused,onRefused:effects.onRefused})}
  finally{if(live())effects.setPending(false)}
}

function RequestSummaryExtraction({locale,detail,bookingLabel}:{locale:Locale;detail:RequestDetailDto;bookingLabel:string|null}){
  const t=appMessages[locale],labels=requestMessages[locale]
  return <>
    {bookingLabel&&detail.summary?<details><summary>{labels.initialExtraction}</summary><p>{detail.summary}</p></details>:detail.summary&&<p>{detail.summary}</p>}
    {detail.nextAction&&<><h3>{bookingLabel?labels.extractedAction:t.nextAction}</h3><p>{detail.nextAction}</p></>}
  </>
}

function RequestSummaryContact({locale,contact,bookingLabel}:{locale:Locale;contact:RequestDetailDto['contact'];bookingLabel:string|null}){
  const t=appMessages[locale],labels=requestMessages[locale]
  if(!contact)return null
  return <>
    <h3>{t.contact}</h3><p>{[contact.name,contact.callback_e164,contact.preference].filter(Boolean).join(' — ')||'—'}</p>
    <h3>{labels.numberSource}</h3><p>{labels.callbackSource[contact.callback_source]}</p>
    <p>{bookingLabel?labels.numberUnconfirmed:t.unconfirmed}</p>
  </>
}

function RequestSummary({locale,detail}:{locale:Locale;detail:RequestDetailDto}){
  const t=appMessages[locale],labels=requestMessages[locale]
  const bookingLabel=detail.category==='appointment_to_confirm'?(detail.bookingOutcome==='confirmed'?bookingMessages[locale].confirmed:detail.bookingOutcome==='cancelled'?bookingMessages[locale].cancelled:null):null
  return <section className="sparra-request-summary" aria-label={locale==='fr'?'Résumé':'Summary'}>
    <Heading level={2}>{detail.resultAvailability==='unavailable'?t.summaryUnavailable:detail.resultQuality==='partial'?t.partial:t.summary}</Heading>
    {detail.category&&<><h3>{followUpMessages[locale].requests}</h3><p>{bookingLabel??labels.category[detail.category]}</p></>}
    <RequestSummaryExtraction locale={locale} detail={detail} bookingLabel={bookingLabel}/>
    <RequestSummaryContact locale={locale} contact={detail.contact} bookingLabel={bookingLabel}/>
  </section>
}

function RequestTranscript({locale,detail}:{locale:Locale;detail:RequestDetailDto}){
  const t=appMessages[locale]
  return <section className="sparra-request-conversation"><Heading level={2}>{t.transcript}</Heading>{detail.transcriptAvailability==='unavailable'&&<p>{t.transcriptUnavailable}</p>}{detail.transcriptAvailability==='partial'&&<p>{t.transcriptPartial}: {detail.unavailableTurnCount} {t.unavailableTurns}.</p>}{detail.transcriptLossCount>0&&<p>{detail.transcriptLossCount} {t.lostTurns}.</p>}{detail.moreTurns&&<p>{t.moreTurns}</p>}<ol className="sparra-call-transcript">{detail.transcript.map(turn=><li key={turn.id} id={`turn-${turn.id}`} tabIndex={-1}><p><strong>{turn.role==='user'?t.caller:t.assistant}</strong>{turn.interrupted?` — ${t.interrupted}`:''}</p><p>{turn.text}</p></li>)}</ol></section>
}

function RequestBooking({locale,booking}:{locale:Locale;booking:NonNullable<RequestDetailDto['bookings']>[number]}){
  const labels=bookingMessages[locale]
  return <>
    <Heading level={2}>{booking.state==='confirmed'&&booking.providerReference&&booking.observedState==='cancelled'?labels.cancelled:booking.state==='confirmed'&&booking.providerReference&&(booking.observedState===null||booking.observedState==='confirmed')?labels.confirmed:labels.unconfirmed}</Heading>
    <p>{booking.serviceName}</p><p><time dateTime={booking.start}>{new Intl.DateTimeFormat(locale,{dateStyle:'long',timeStyle:'short',timeZone:booking.timezone}).format(new Date(booking.start))}</time> · {booking.timezone}</p>
    {booking.providerReference&&<p>{labels.reference} : {booking.providerReference}</p>}
    {booking.originalStart&&booking.originalStart!==booking.start&&<p>{labels.original} : <time dateTime={booking.originalStart}>{new Intl.DateTimeFormat(locale,{dateStyle:'long',timeStyle:'short',timeZone:booking.timezone}).format(new Date(booking.originalStart))}</time></p>}
    {booking.observedState==='cancelled'&&<p>{labels.observedCancellation}</p>}
  </>
}
function RequestBookings({locale,detail}:{locale:Locale;detail:RequestDetailDto}){
  if(!detail.bookings?.length)return null
  return <section aria-label={bookingMessages[locale].section}>{detail.bookings.map((booking,index)=><div key={booking.providerReference??index}><RequestBooking locale={locale} booking={booking}/></div>)}</section>
}

function RequestConfigurationSnapshot({locale,configuration}:{locale:Locale;configuration:RequestDetailDto['configuration']}){
  const t=appMessages[locale],a=activityMessages[locale]
  return <section className="sparra-request-knowledge" data-configuration-snapshot><Heading level={2}>{t.snapshot}</Heading>{configuration?<><p>{configuration.businessName} — {t.version} {configuration.revision}</p><dl>{(['openingHours','services','prices','faq','instructions'] as const).map(field=><div key={field}><dt>{a[field]}</dt><dd>{configuration.knowledge[field]||'—'}</dd></div>)}</dl></>:<p>{t.noSnapshot}</p>}</section>
}

type RequestAudioMetadata=NonNullable<RequestDetailDto['audio']>

function stopRequestAudio(player:HTMLAudioElement|null){
  if(!player)return
  player.pause();player.removeAttribute('src');player.load()
}

function unavailableAudioMessage(locale:Locale,state:RequestAudioMetadata['state']){
  if(locale!=='fr')return 'Conversation unavailable.'
  if(state==='declined')return 'L’appelant a choisi de continuer sans enregistrement.'
  if(state==='off')return 'Aucun enregistrement pour cet appel.'
  return 'Conversation indisponible.'
}

function RequestAudioDetails({locale,audio}:{locale:Locale;audio:RequestAudioMetadata}){
  return <>
    {audio.durationSeconds!==null&&<p>{Math.round(audio.durationSeconds)} s · {locale==='fr'?'Échéance':'Expires'} : <time dateTime={audio.expiresAt}>{observedDate(audio.expiresAt,locale)}</time></p>}
    {audio.state==='partial'&&<p>{locale==='fr'?'Cet extrait peut être incomplet.':'This excerpt may be incomplete.'}</p>}
  </>
}

export function RequestAudio({locale,detail,blocked,readGeneration=0}:{locale:Locale;detail:Pick<RequestDetailDto,'id'|'audio'>;blocked:boolean;readGeneration?:number}){
  const element=useRef<HTMLAudioElement>(null),[failed,setFailed]=useState(false),audio=detail.audio
  // A successful owned reread may recover a local playback error. Follow-up
  // receipts do not advance this generation or retire an available player.
  useEffect(()=>setFailed(false),[readGeneration,detail.id])
  const available=audio?.available===true&&!blocked&&!failed
  useEffect(()=>{
    const player=element.current
    if(!available)stopRequestAudio(player)
    return()=>stopRequestAudio(player)
  },[available,detail.id])
  if(!audio)return null
  return <section aria-label={locale==='fr'?'Conversation avec Sparra':'Conversation with Sparra'}>
    <Heading level={2}>{locale==='fr'?'Conversation avec Sparra':'Conversation with Sparra'}</Heading>
    <p>{locale==='fr'?'Enregistrement de l’échange avec l’assistant Sparra.':'Recording of the conversation with the Sparra assistant.'}</p>
    <RequestAudioDetails locale={locale} audio={audio}/>
    {available?<audio ref={element} controls controlsList="nodownload" preload="none" src={'/api/sparra/audio/'+detail.id} onError={()=>setFailed(true)}/>
      :<p role={failed?'status':undefined}>{unavailableAudioMessage(locale,audio.state)}</p>}
  </section>
}

function RequestActions({locale,detail,hydrated,pending,onMutate}:{locale:Locale;detail:RequestDetailDto;hydrated:boolean;pending:boolean;onMutate(kind:'treat'|'revoke'|'erase'):Promise<void>}){
 const t=appMessages[locale],f=followUpMessages[locale],follow=detail.followUp
 return <div className="sparra-request-actions">
  {requiresReview(follow)?<Button variant="primary" label={t.treat} isDisabled={!hydrated||pending||!follow.collectionClosed||!follow.contentReadable} onClick={()=>void onMutate('treat')}/>:<p role="status">{t.treated}</p>}
  {follow.declarationActive&&<Button variant="secondary" label={f.revoke} isDisabled={!hydrated||pending} onClick={()=>void onMutate('revoke')}/>}
 </div>
}
function RequestProvenance({locale,detail}:{locale:Locale;detail:RequestDetailDto}){
 const f=followUpMessages[locale]
 const evidence=detail.evidence.filter(source=>detail.transcript.some(turn=>turn.id===source.turnId&&turn.role===source.role))
 return <section className="sparra-request-provenance" aria-label={f.gaps}>
  <p>{detail.followUp.collectionClosed?f.closed:f.provisional}</p>
  {!detail.followUp.contentReadable&&<p>{f.unreadable}</p>}
  {detail.followUp.declarationActive&&requiresReview(detail.followUp)&&<p>{f.newPublication}</p>}
  {detail.followUp.firstDeclaredAt&&<p>{f.firstDeclaration} : <time dateTime={detail.followUp.firstDeclaredAt}>{observedDate(detail.followUp.firstDeclaredAt,locale)}</time></p>}
  {detail.callerPhone&&<p>{f.callerPhone} : {detail.callerPhone}</p>}
  {detail.collectionGaps.map(gap=><p key={gap}>{f[gap]}</p>)}<p>{f.audioCoverage}</p>
  {evidence.length>0&&<nav aria-label={f.evidence}><strong>{f.evidence}</strong><ul>{evidence.map(source=><li key={source.turnId}><a href={`#turn-${source.turnId}`}>{source.role==='user'?appMessages[locale].caller:appMessages[locale].assistant} · {detail.transcript.findIndex(turn=>turn.id===source.turnId)+1}</a></li>)}</ul></nav>}
 </section>
}

function RequestMetadata({locale,detail}:{locale:Locale;detail:Pick<RequestDetailDto,'status'|'admittedAt'|'endedAt'>}){
  const t=appMessages[locale]
  return <div className="sparra-request-meta"><p>{t.status[detail.status]}</p><p>{t.admitted}: <time dateTime={detail.admittedAt}>{observedDate(detail.admittedAt,locale)}</time></p><p>{detail.endedAt?`${t.ended}: ${observedDate(detail.endedAt,locale)}`:t.noEnd}</p></div>
}

function RequestFrame({locale,view,hydrated,locked,pending,canRefresh,onRefresh,refused,failed,failure,children}:{locale:Locale;view:'pending'|'all';hydrated:boolean;locked:boolean;pending:boolean;canRefresh:boolean;onRefresh():Promise<void>;refused:boolean;failed:boolean;failure:FollowUpFailure|null;children:ReactNode}){
  const t=appMessages[locale]
  if(refused)return <PrivateUnavailable locale={locale} title={t.details}/>
  return <><a className="sparra-back-link" href={`/app?lang=${locale}&view=${view}`}>{t.inbox}</a><div className="sparra-page-heading"><Heading level={1}>{t.details}</Heading>{canRefresh&&<Button label={t.refresh} isDisabled={!hydrated||locked} isLoading={pending} isInterruptible onClick={()=>void onRefresh()}/>}</div>
    {failed&&<p role="alert">{failure?followUpMessages[locale][failure]:t.unavailable}</p>}{children}{pending&&<p role="status">{t.pending}</p>}
  </>
}

type RequestContentProps={locale:Locale;current:RequestLoaded;hydrated:boolean;pending:boolean;confirm:boolean;setConfirm(value:boolean):void;onMutate(kind:'treat'|'revoke'|'erase'):Promise<void>;audioReadGeneration:number;audioBlocked:boolean;correction?:ReactNode}

function RequestErasure({locale,hydrated,pending,confirm,setConfirm,onMutate}:Pick<RequestContentProps,'locale'|'hydrated'|'pending'|'confirm'|'setConfirm'|'onMutate'>){
  const t=appMessages[locale]
  return <section className="sparra-request-erasure">{!confirm?<Button variant="secondary" label={t.erase} isDisabled={!hydrated||pending} onClick={()=>setConfirm(true)}/>:<div><p>{t.eraseWarning}</p><Button label={t.confirmErase} isDisabled={pending} onClick={()=>void onMutate('erase')}/><Button variant="secondary" label={t.cancel} isDisabled={pending} onClick={()=>setConfirm(false)}/></div>}</section>
}

function RequestContent({locale,current,hydrated,pending,confirm,setConfirm,onMutate,audioReadGeneration,audioBlocked,correction}:RequestContentProps){
  const t=appMessages[locale],detail=current.detail
  if(current.receipt)return <p role="status">{current.receipt.state==='queued'?t.queued:t.completed}</p>
  if(!detail)return null
  return <>
    <RequestMetadata locale={locale} detail={detail}/>
    <RequestActions locale={locale} detail={detail} hydrated={hydrated} pending={pending} onMutate={onMutate}/>
    <RequestProvenance locale={locale} detail={detail}/>
    <div className="sparra-call-workspace">
    <RequestSummary locale={locale} detail={detail}/>
    <RequestBookings locale={locale} detail={detail}/>
    <RequestTranscript locale={locale} detail={detail}/>
    <RequestAudio locale={locale} detail={detail} readGeneration={audioReadGeneration} blocked={audioBlocked}/>
    <RequestConfigurationSnapshot locale={locale} configuration={detail.configuration}/>
    {correction}
    </div>
    <RequestErasure locale={locale} hydrated={hydrated} pending={pending} confirm={confirm} setConfirm={setConfirm} onMutate={onMutate}/>
  </>
}

function useRequestPanelLifecycle({loaded,onTreat,onErase,onRefused,onRefresh}:Pick<Props,'loaded'|'onTreat'|'onErase'|'onRefused'|'onRefresh'>){
  const [current,setCurrent]=useState(loaded),[pending,setPending]=useState(false),[failed,setFailed]=useState(false),[confirm,setConfirm]=useState(false)
  const begin=useRequestAttempt(),lock=useRef(false),actionGeneration=useRef(0)
  const [failure,setFailure]=useState<FollowUpFailure|null>(null),[audioReadGeneration,setAudioReadGeneration]=useState(0)
  const [correctionPending,setCorrectionPending]=useState(false),[correctionGeneration,setCorrectionGeneration]=useState(0),[refused,setRefused]=useState(false)
  useLayoutEffect(()=>{begin();actionGeneration.current++;lock.current=false;setCurrent(loaded);setAudioReadGeneration(value=>value+1);setCorrectionGeneration(value=>value+1);setCorrectionPending(false);setPending(false);setFailed(false);setFailure(null);setConfirm(false);setRefused(false)},[loaded])
  function acquire(){if(lock.current)return null;lock.current=true;return ++actionGeneration.current}
  function release(generation:number){if(actionGeneration.current===generation)lock.current=false}
  function replaceCurrent(next:RequestLoaded){setCurrent(next);setAudioReadGeneration(value=>value+1);setCorrectionGeneration(value=>value+1);setConfirm(false)}
  async function mutate(kind:'treat'|'revoke'|'erase'){
    const generation=acquire();if(generation===null)return
    try{await performRequestAction(kind,current,begin,onTreat,onErase,{setCurrent,setPending,setFailed,setFailure,setRefused,onRefused})}finally{release(generation)}
  }
  async function refresh(){
    if(!onRefresh)return
    const generation=acquire();if(generation===null)return
    try{await refreshRequest(begin,onRefresh,{setCurrent:replaceCurrent,setPending,setFailed,setFailure,setRefused,onRefused})}finally{release(generation)}
  }
  function cancelCorrection(generation:number){if(actionGeneration.current===generation)begin()}
  function releaseCorrection(generation:number){if(actionGeneration.current!==generation)return;release(generation);setCorrectionPending(false)}
  function beginCorrection():CorrectionAttempt|null{
    const generation=acquire();if(generation===null)return null
    const attempt=begin();setCorrectionPending(true)
    return {...attempt,cancel:()=>cancelCorrection(generation),release:()=>releaseCorrection(generation)}
  }
  async function refuse(){setRefused(true);await onRefused()}
  return {current,pending,failed,confirm,setConfirm,failure,audioReadGeneration,correctionPending,correctionGeneration,refused,lock,mutate,refresh,beginCorrection,refuse}
}
function RequestCorrectionSlot({locale,detail,blocked,generation,operations,onBegin,onRefused}:{locale:Locale;detail:RequestDetailDto|null;blocked:boolean;generation:number;operations:Partial<RequestCorrectionOperations>;onBegin():CorrectionAttempt|null;onRefused():Promise<void>}){
  if(!detail)return null
  const {onReadActivity,onConfirmActivity,onLookupActivityConfirmation}=operations
  if(!onReadActivity||!onConfirmActivity||!onLookupActivityConfirmation)return null
  return <RequestCorrection key={generation} locale={locale} workspaceId={detail.workspaceId} callConfiguration={detail.configuration} callRevision={detail.configurationRevision} blocked={blocked} onBegin={onBegin} onRead={onReadActivity} onConfirm={onConfirmActivity} onLookup={onLookupActivityConfirmation} onRefused={onRefused}/>
}
export function RequestPanel(props:Props){
  const hydrated=useHydrated(),state=useRequestPanelLifecycle(props),{locale,view='pending'}=props
  const correction=<RequestCorrectionSlot locale={locale} detail={state.current.detail} blocked={state.pending} generation={state.correctionGeneration} operations={props} onBegin={state.beginCorrection} onRefused={state.refuse}/>
  return <RequestFrame locale={locale} view={view} hydrated={hydrated} locked={state.lock.current} pending={state.pending} canRefresh={Boolean(props.onRefresh)} onRefresh={state.refresh} refused={state.refused} failed={state.failed} failure={state.failure}>
    <RequestContent locale={locale} current={state.current} hydrated={hydrated} pending={state.pending||state.correctionPending} confirm={state.confirm} setConfirm={state.setConfirm} onMutate={state.mutate} audioReadGeneration={state.audioReadGeneration} audioBlocked={state.pending&&state.confirm} correction={correction}/>
  </RequestFrame>
}
