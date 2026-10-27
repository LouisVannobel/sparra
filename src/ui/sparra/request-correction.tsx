import { useRef,useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextArea } from '@astryxdesign/core/TextArea'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import type { ActivityConfigurationDto,ActivityState,ConfirmActivityInput,ActivityConfirmationDto,ActivityConfirmationKey,ActivityConfirmationLookup } from '../../modules/sparra/sparra.functions'
import { activityMessages } from '../../modules/sparra/messages'
import { getSectorPreset } from '../../modules/sparra/sectors'
import type { Locale } from '../auth/messages'
import { privateResult } from './app-shell'
import { correctionMessages } from './correction-messages'

export type RequestCorrectionOperations={
  onReadActivity(signal:AbortSignal):Promise<ActivityState|Response>
  onConfirmActivity(data:ConfirmActivityInput,signal:AbortSignal):Promise<ActivityConfirmationDto|Response>
  onLookupActivityConfirmation(key:ActivityConfirmationKey,signal:AbortSignal):Promise<ActivityConfirmationLookup|Response>
}
export type CorrectionAttempt={signal:AbortSignal;live():boolean;cancel():void;release():void}
type Props={locale:Locale;workspaceId:string;callConfiguration:ActivityConfigurationDto|null;callRevision:number|null;blocked:boolean;onBegin():CorrectionAttempt|null;onRefused():Promise<void>;onRead:RequestCorrectionOperations['onReadActivity'];onConfirm:RequestCorrectionOperations['onConfirmActivity'];onLookup:RequestCorrectionOperations['onLookupActivityConfirmation']}
const fieldNames=['openingHours','services','prices','faq','instructions'] as const
type Field=typeof fieldNames[number]
const fields={openingHours:1000,services:2000,prices:1500,faq:3000,instructions:2000} satisfies Record<Field,number>
const symptoms=['knowledge','transcription','pronunciation','summary','action','unknown'] as const
type Symptom=typeof symptoms[number]
type Feedback='saved'|'observed'|'different'|'reread'|'unavailable'|'invalid'|'recording'|null
type AttemptedSave={workspaceId:string;input:ConfirmActivityInput}

function correctionInput(workspaceId:string,base:ActivityConfigurationDto,field:Field,text:string):ConfirmActivityInput['activity']{
  return {expectedWorkspaceId:workspaceId,expectedRevision:base.revision,businessName:base.businessName,sector:base.sector,knowledge:{...base.knowledge,[field]:text.replace(/\r\n/g,'\n')},transferDestination:base.transferDestination,recordingEnabled:base.recordingEnabled??false,recordingPolicy:base.recordingPolicy,recordingContactPhone:base.recordingContactPhone}
}
function containsAttempt(configuration:ActivityConfigurationDto|null,attempt:AttemptedSave):boolean{
  const input=attempt.input.activity
  return configuration!==null&&configuration.workspaceId===attempt.workspaceId&&configuration.revision===input.expectedRevision+1
    &&configuration.businessName===input.businessName&&configuration.sector===input.sector
    &&fieldNames.every(field=>configuration.knowledge[field]===input.knowledge[field])
    &&configuration.transferDestination===input.transferDestination&&(configuration.recordingEnabled??false)===input.recordingEnabled
    &&configuration.recordingPolicy===input.recordingPolicy&&configuration.recordingContactPhone===input.recordingContactPhone
}
function exactReceipt(receipt:ActivityConfirmationLookup,attempt:AttemptedSave):receipt is ActivityConfirmationDto{return receipt.status==='confirmed'&&receipt.revision===attempt.input.activity.expectedRevision+1}
function confirmedHead(configuration:ActivityConfigurationDto|null,attempt:AttemptedSave,receipt:ActivityConfirmationLookup):boolean{return exactReceipt(receipt,attempt)&&containsAttempt(configuration,attempt)&&configuration?.savedAt===receipt.savedAt}

function CorrectionFinalReview({locale,input,attested,disabled,onAttest}:{locale:Locale;input:ConfirmActivityInput['activity'];attested:boolean;disabled:boolean;onAttest(value:boolean):void}){
  const t=correctionMessages[locale],a=activityMessages[locale]
  return <section aria-label={t.finalReview}><Heading level={3}>{t.finalReview}</Heading><dl>
    <dt>{a.businessName}</dt><dd>{input.businessName}</dd><dt>{a.sector}</dt><dd>{getSectorPreset(input.sector,locale).label}</dd>
    {fieldNames.map(field=><div key={field}><dt>{a[field]}</dt><dd className="sparra-correction-text">{input.knowledge[field]||'—'}</dd></div>)}
    <dt>{a.transferDestination}</dt><dd>{input.transferDestination||'—'}</dd><dt>{a.recordingEnabled}</dt><dd>{input.recordingPolicy==='local_30d'?t.audioOn:t.audioOff}</dd><dt>{a.recordingContactPhone}</dt><dd>{input.recordingContactPhone||'—'}</dd>
  </dl><CheckboxInput htmlName="correctionAttestation" label={t.attestation} value={attested} onChange={onAttest} isDisabled={disabled} width="100%"/></section>
}

function CorrectionComparison({locale,base,field,text,callConfiguration}:{locale:Locale;base:ActivityConfigurationDto;field:Field;text:string;callConfiguration:ActivityConfigurationDto|null}){
  const t=correctionMessages[locale]
  return <>
    {callConfiguration&&<div><h3>{t.callValue}</h3><p className="sparra-correction-text">{callConfiguration.knowledge[field]||'—'}</p></div>}
    <section aria-label={t.compare}><Heading level={3}>{t.compare}</Heading><dl><dt>{t.before}</dt><dd className="sparra-correction-text">{base.knowledge[field]||'—'}</dd><dt>{t.after}</dt><dd className="sparra-correction-text">{text||'—'}</dd></dl></section>
  </>
}

export function RequestCorrection({locale,workspaceId,callConfiguration,callRevision,blocked,onBegin,onRead,onConfirm,onLookup,onRefused}:Props){
  const t=correctionMessages[locale],hydrated=useHydrated()
  const [open,setOpen]=useState(false),[symptom,setSymptom]=useState<Symptom|null>(null)
  const [base,setBase]=useState<ActivityConfigurationDto|null>(null),[hasRead,setHasRead]=useState(false),[audioAvailable,setAudioAvailable]=useState(false)
  const [field,setField]=useState<Field|null>(null),[text,setText]=useState(''),[reviewed,setReviewed]=useState(false),[attested,setAttested]=useState(false)
  const [pending,setPending]=useState<'read'|'save'|null>(null),operation=useRef<CorrectionAttempt|null>(null)
  const [reconcile,setReconcile]=useState<'conflict'|'uncertain'|null>(null),[feedback,setFeedback]=useState<Feedback>(null)
  const attempted=useRef<AttemptedSave|null>(null)
  const [receipt,setReceipt]=useState<ActivityConfirmationLookup|null>(null)
  const disabled=!hydrated||blocked||pending!==null
  const editDisabled=disabled||reconcile!==null
  const normalized=text.replace(/\r\n/g,'\n'),tooLong=field!==null&&normalized.length>fields[field]
  const changed=base!==null&&field!==null&&normalized!==base.knowledge[field]
  const audioBlocked=base!==null&&(base.recordingEnabled===true||(base.recordingPolicy==='local_30d'&&!audioAvailable))
  const canReview=changed&&!tooLong&&!audioBlocked&&!editDisabled
  function edit(value:string){if(editDisabled)return;setText(value);setReviewed(false);setAttested(false);setFeedback(null);setReceipt(null)}
  function selectField(next:Field){if(editDisabled||!base)return;setField(next);setText(base.knowledge[next]);setReviewed(false);setAttested(false);setFeedback(null);setReceipt(null)}
  function release(owned:CorrectionAttempt){if(operation.current!==owned)return;operation.current=null;owned.release();setPending(null)}
  function isRefused(error:unknown){return error instanceof Response&&(error.status===401||(error.status===409&&error.headers.get('x-sparra-activity-error')==='workspace-changed'))}
  function changedWorkspace(state:ActivityState){return state.workspace?.id!==workspaceId||(state.configuration!==null&&state.configuration.workspaceId!==workspaceId)}
  function ownedConfiguration(state:ActivityState){return state.configuration&&state.workspace?.id===workspaceId&&state.configuration.workspaceId===workspaceId?state.configuration:null}
  async function readCurrent(){
    if(!hydrated||disabled)return
    const owned=onBegin();if(!owned)return
    operation.current=owned;setPending('read');setReviewed(false);setAttested(false)
    const {signal,live}=owned
    try{
      const previous=reconcile,attempt=attempted.current
      let confirmation:ActivityConfirmationLookup|null=null
      if(previous==='uncertain'&&attempt){confirmation=await privateResult(onLookup({draftId:attempt.input.draftId,draftVersion:attempt.input.draftVersion,expectedWorkspaceId:attempt.workspaceId},signal));if(!live())return;setReceipt(confirmation)}
      const state=await privateResult(onRead(signal));if(!live())return
      // A pinned call cannot be used to edit a different workspace's configuration.
      const current=ownedConfiguration(state)
      if(changedWorkspace(state)||(state.configuration&&!current)){await onRefused();return}
      setBase(current);setHasRead(true);setAudioAvailable(state.localAudioAvailable);setReconcile(null)
      setFeedback(previous==='uncertain'&&attempt?(confirmation&&confirmedHead(current,attempt,confirmation)?'saved':containsAttempt(current,attempt)&&confirmation?.status==='unverifiable'?'observed':'different'):previous?'reread':null)
      attempted.current=null
    }catch(error){if(live()){if(isRefused(error))await onRefused();else setFeedback('unavailable')}}
    finally{if(live())release(owned)}
  }
  async function save(){
    if(!reviewed||!attested||!canReview||!base||!field)return
    const owned=onBegin();if(!owned)return
    const attempt:AttemptedSave={workspaceId,input:{draftId:globalThis.crypto.randomUUID(),draftVersion:1,expectedWorkspaceId:workspaceId,activity:correctionInput(workspaceId,base,field,text),decisions:[],confirmed:true}}
    attempted.current=attempt;operation.current=owned;setPending('save');setFeedback(null);setReviewed(false);setAttested(false);setReceipt(null)
    const {signal,live}=owned
    let confirmed=false
    try{
      const result=await privateResult(onConfirm(attempt.input,signal));if(!live())return
      if(!exactReceipt(result,attempt)){setReconcile('uncertain');return}
      confirmed=true;setReceipt(result)
      const state=await privateResult(onRead(signal));if(!live())return
      const current=ownedConfiguration(state)
      if(changedWorkspace(state)||(state.configuration&&!current)){await onRefused();return}
      if(!confirmedHead(current,attempt,result)){setReconcile('uncertain');return}
      setBase(current);setAudioAvailable(state.localAudioAvailable);setFeedback('saved');setReconcile(null);attempted.current=null
    }catch(error){
      if(!live())return
      if(isRefused(error)){await onRefused();return}
      if(confirmed){setReconcile('uncertain');return}
      if(error instanceof Response&&error.status===409){setReconcile('conflict');attempted.current=null;if(error.headers.get('x-sparra-activity-error')==='recording-unavailable')setFeedback('recording')}
      else if(error instanceof Response&&error.status===400){setFeedback('invalid');attempted.current=null}
      else setReconcile('uncertain')
    }finally{if(live())release(owned)}
  }
  function stopWaiting(){const owned=operation.current;if(pending!=='save'||!owned)return;owned.cancel();setReconcile('uncertain');setReviewed(false);setAttested(false);release(owned)}
  function chooseSymptom(next:Symptom){if(editDisabled)return;setSymptom(next);if(next==='knowledge'&&!hasRead)void readCurrent()}
  return <section className="sparra-request-correction" aria-label={t.title}>
    {!open?<Button label={t.open} isDisabled={disabled} onClick={()=>{if(!disabled)setOpen(true)}}/>:<>
      <Heading level={2}>{t.title}</Heading><p>{t.symptom}</p>
      <div className="sparra-helper-choices">{symptoms.map(value=><Button key={value} label={t.symptoms[value]} aria-pressed={symptom===value} isDisabled={editDisabled} onClick={()=>chooseSymptom(value)}/>)}</div>
      <p className="sparra-form-hint">{t.noTest}</p>
      {symptom&&symptom!=='knowledge'&&<p>{t.guidance[symptom]}</p>}
      {symptom==='knowledge'&&<>
        <p>{t.local}</p><p>{callRevision!==null?`${t.callVersion}: ${callRevision}`:t.noSnapshot}</p>
        {!callConfiguration&&callRevision!==null&&<p>{t.noSnapshot}</p>}
        <Button label={t.read} isDisabled={disabled} onClick={()=>void readCurrent()}/>
        {hasRead&&!base&&<p>{t.noConfiguration} <a href={`/app/entreprise?lang=${locale}`}>{t.business}</a></p>}
        {base&&<>
          <p>{t.currentVersion}: {base.revision}</p>
          <div role="group" aria-label={t.field} className="sparra-helper-choices">{fieldNames.map(value=><Button key={value} label={activityMessages[locale][value]} aria-pressed={field===value} isDisabled={editDisabled} onClick={()=>selectField(value)}/>)}</div>
          {field&&<>
            <TextArea label={t.proposed} description={activityMessages[locale].fieldHints[field]} value={text} onChange={edit} isDisabled={editDisabled} rows={5} width="100%" status={tooLong?{type:'error',message:`${t.limit} ${fields[field]}`}:undefined} statusVariant="detached"/>
            {callConfiguration&&<Button label={t.useCall} isDisabled={editDisabled} onClick={()=>edit(callConfiguration.knowledge[field])}/>}
            <CorrectionComparison locale={locale} base={base} field={field} text={normalized} callConfiguration={callConfiguration}/>
            {!changed&&<p>{t.unchanged}</p>}
            {!reviewed?<Button label={t.review} isDisabled={!canReview} onClick={()=>{if(canReview){setReviewed(true);setAttested(false)}}}/>:<><CorrectionFinalReview locale={locale} input={correctionInput(workspaceId,base,field,text)} attested={attested} disabled={editDisabled} onAttest={setAttested}/><p>{t.confirmHint}</p><Button label={t.confirm} variant="primary" isDisabled={!canReview||!attested} onClick={()=>void save()}/></>}
          </>}
          {audioBlocked&&<p role="alert">{t.recording} <a href={`/app/entreprise?lang=${locale}`}>{t.business}</a></p>}
        </>}
        {pending&&<p role="status">{pending==='read'?t.reading:t.saving}</p>}
        {pending==='save'&&<><p>{t.saveWait}</p><Button label={t.stop} onClick={stopWaiting}/></>}
        {reconcile&&<p role="alert">{t[reconcile]}</p>}
        {receipt?.status==='confirmed'&&<p role="status">{t.historical} {receipt.revision} ({receipt.savedAt}).</p>}
        {feedback&&<p role={feedback==='saved'||feedback==='observed'||feedback==='reread'?'status':'alert'}>{t[feedback]}</p>}
      </>}
    </>}
  </section>
}
