import { useEffect, useRef, useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import type { EraseReceipt, RequestDetailDto } from '../../modules/sparra/sparra.functions'
import { appMessages, activityMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'

export type RequestLoaded={detail:RequestDetailDto|null;receipt:EraseReceipt|null}
type Props={locale:Locale;loaded:RequestLoaded;onTreat(signal:AbortSignal):Promise<{requestId:string;treatedAt:string}|Response>;onErase(signal:AbortSignal):Promise<EraseReceipt|Response>;onRefused():Promise<void>}
type RequestActionEffects={setCurrent(loaded:RequestLoaded):void;setPending(value:boolean):void;setFailed(value:boolean):void;setRefused(value:boolean):void;onRefused():Promise<void>}

async function consumeTreatAction(current:RequestLoaded,signal:AbortSignal,live:()=>boolean,onTreat:Props['onTreat'],setCurrent:RequestActionEffects['setCurrent']){
  const result=await privateResult(onTreat(signal))
  if(live())setCurrent({...current,detail:current.detail?{...current.detail,treatedAt:result.treatedAt}:null})
}

async function consumeEraseAction(signal:AbortSignal,live:()=>boolean,onErase:Props['onErase'],setCurrent:RequestActionEffects['setCurrent']){
  const receipt=await privateResult(onErase(signal))
  if(live())setCurrent({detail:null,receipt})
}

async function settleRequestActionFailure(error:unknown,live:()=>boolean,{setFailed,setRefused,onRefused}:Pick<RequestActionEffects,'setFailed'|'setRefused'|'onRefused'>){
  if(!live())return
  if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}
  setFailed(true)
}

export async function performRequestAction(kind:'treat'|'erase',current:RequestLoaded,begin:ReturnType<typeof useRequestAttempt>,onTreat:Props['onTreat'],onErase:Props['onErase'],effects:RequestActionEffects){
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false)
  try{
    if(kind==='treat')await consumeTreatAction(current,signal,live,onTreat,effects.setCurrent)
    else await consumeEraseAction(signal,live,onErase,effects.setCurrent)
  }catch(error){await settleRequestActionFailure(error,live,effects)}finally{if(live())effects.setPending(false)}
}

function RequestSummary({locale,detail}:{locale:Locale;detail:RequestDetailDto}){
  const t=appMessages[locale],labels=requestMessages[locale]
  return <section className="sparra-request-summary" aria-label={locale==='fr'?'Résumé':'Summary'}>
    <Heading level={2}>{detail.resultAvailability==='available'&&detail.resultQuality==='partial'?t.partial:t.summaryUnavailable}</Heading>
    {detail.summary&&<p>{detail.summary}</p>}
    {detail.category&&<><h3>{labels.reason}</h3><p>{labels.category[detail.category]}</p></>}
    {detail.nextAction&&<><h3>{t.nextAction}</h3><p>{detail.nextAction}</p></>}
    {detail.contact&&<>
      <h3>{t.contact}</h3><p>{[detail.contact.name,detail.contact.callback_e164,detail.contact.preference].filter(Boolean).join(' — ')||'—'}</p>
      <h3>{labels.numberSource}</h3><p>{labels.callbackSource[detail.contact.callback_source]}</p>
      <p>{t.unconfirmed}</p>
    </>}
  </section>
}

function RequestTranscript({locale,detail}:{locale:Locale;detail:RequestDetailDto}){
  const t=appMessages[locale]
  return <section className="sparra-request-conversation"><Heading level={2}>{t.transcript}</Heading>{detail.transcriptAvailability==='unavailable'&&<p>{t.transcriptUnavailable}</p>}{detail.transcriptAvailability==='partial'&&<p>{t.transcriptPartial}: {detail.unavailableTurnCount} {t.unavailableTurns}.</p>}{detail.transcriptLossCount>0&&<p>{detail.transcriptLossCount} {t.lostTurns}.</p>}{detail.moreTurns&&<p>{t.moreTurns}</p>}<ol className="sparra-call-transcript">{detail.transcript.map(turn=><li key={turn.id}><p><strong>{turn.role==='user'?t.caller:t.assistant}</strong>{turn.interrupted?` — ${t.interrupted}`:''}</p><p>{turn.text}</p></li>)}</ol></section>
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

export function RequestAudio({locale,detail,blocked}:{locale:Locale;detail:Pick<RequestDetailDto,'id'|'audio'>;blocked:boolean}){
  const element=useRef<HTMLAudioElement>(null),[failed,setFailed]=useState(false),audio=detail.audio
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

function RequestActions({locale,treatedAt,hydrated,pending,confirm,onMutate,onConfirm}:{locale:Locale;treatedAt:RequestDetailDto['treatedAt'];hydrated:boolean;pending:boolean;confirm:boolean;onMutate(kind:'treat'|'erase'):Promise<void>;onConfirm(value:boolean):void}){
  const t=appMessages[locale]
  return <div className="sparra-request-actions">
    {treatedAt?<p role="status">{t.treated}</p>:<Button label={t.treat} isDisabled={!hydrated||pending} onClick={()=>void onMutate('treat')}/>}
    {!confirm?<Button label={t.erase} isDisabled={!hydrated||pending} onClick={()=>onConfirm(true)}/>:<div><p>{t.eraseWarning}</p><Button label={t.confirmErase} isDisabled={pending} onClick={()=>void onMutate('erase')}/><Button label={t.cancel} isDisabled={pending} onClick={()=>onConfirm(false)}/></div>}
  </div>
}

function RequestMetadata({locale,detail}:{locale:Locale;detail:Pick<RequestDetailDto,'status'|'admittedAt'|'endedAt'>}){
  const t=appMessages[locale]
  return <div className="sparra-request-meta"><p>{t.status[detail.status]}</p><p>{t.admitted}: <time dateTime={detail.admittedAt}>{observedDate(detail.admittedAt,locale)}</time></p><p>{detail.endedAt?`${t.ended}: ${observedDate(detail.endedAt,locale)}`:t.noEnd}</p></div>
}

export function RequestPanel({locale,loaded,onTreat,onErase,onRefused}:Props){
  const t=appMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(loaded),[pending,setPending]=useState(false),[failed,setFailed]=useState(false),[confirm,setConfirm]=useState(false)
  const begin=useRequestAttempt()
  const [refused,setRefused]=useState(false)
  function mutate(kind:'treat'|'erase'){return performRequestAction(kind,current,begin,onTreat,onErase,{setCurrent,setPending,setFailed,setRefused,onRefused})}
  const detail=current.detail
  if(refused)return <PrivateUnavailable locale={locale} title={t.details}/>
  return <><a className="sparra-back-link" href={`/app?lang=${locale}`}>{t.inbox}</a><div className="sparra-page-heading"><Heading level={1}>{t.details}</Heading></div>
    {current.receipt?<p role="status">{current.receipt.state==='queued'?t.queued:t.completed}</p>:detail&&<>
      <RequestMetadata locale={locale} detail={detail}/>
      <div className="sparra-call-workspace">
      <RequestSummary locale={locale} detail={detail}/>
      <RequestTranscript locale={locale} detail={detail}/>
      <RequestAudio locale={locale} detail={detail} blocked={pending&&confirm}/>
      <RequestConfigurationSnapshot locale={locale} configuration={detail.configuration}/>
      </div>
      <RequestActions locale={locale} treatedAt={detail.treatedAt} hydrated={hydrated} pending={pending} confirm={confirm} onMutate={mutate} onConfirm={setConfirm}/>
    </>}{pending&&<p role="status">{t.pending}</p>}{failed&&<p role="alert">{t.unavailable}</p>}
  </>
}
