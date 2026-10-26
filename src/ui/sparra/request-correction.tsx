import { useEffect,useRef,useState,type RefObject } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextArea } from '@astryxdesign/core/TextArea'
import type { ActivityConfigurationDto,ActivityState,SaveActivityInput } from '../../modules/sparra/sparra.functions'
import { activityMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { privateResult } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'
import { correctionMessages } from './correction-messages'

export type RequestCorrectionOperations={
  onReadActivity(signal:AbortSignal):Promise<ActivityState|Response>
  onSaveActivity(data:SaveActivityInput,signal:AbortSignal):Promise<ActivityConfigurationDto|Response>
}
type Props={locale:Locale;callConfiguration:ActivityConfigurationDto|null;callRevision:number|null;blocked:boolean;actionLock:RefObject<boolean>;onPendingChange(value:boolean):void;onRefused():Promise<void>;onRead:RequestCorrectionOperations['onReadActivity'];onSave:RequestCorrectionOperations['onSaveActivity']}
const fieldNames=['openingHours','services','prices','faq','instructions'] as const
type Field=typeof fieldNames[number]
const fields={openingHours:1000,services:2000,prices:1500,faq:3000,instructions:2000} satisfies Record<Field,number>
const symptoms=['knowledge','transcription','pronunciation','summary','action','unknown'] as const
type Symptom=typeof symptoms[number]
type Feedback='saved'|'observed'|'different'|'reread'|'unavailable'|'invalid'|'recording'|null
type AttemptedSave={workspaceId:string;input:SaveActivityInput}

function correctionInput(base:ActivityConfigurationDto,field:Field,text:string):SaveActivityInput{
  return {expectedWorkspaceId:base.workspaceId,expectedRevision:base.revision,businessName:base.businessName,sector:base.sector,knowledge:{...base.knowledge,[field]:text.replace(/\r\n/g,'\n')},transferDestination:base.transferDestination,recordingEnabled:base.recordingEnabled??false,recordingPolicy:base.recordingPolicy,recordingContactPhone:base.recordingContactPhone}
}
function containsAttempt(configuration:ActivityConfigurationDto|null,attempt:AttemptedSave):boolean{
  const input=attempt.input
  return configuration!==null&&configuration.workspaceId===attempt.workspaceId&&configuration.revision===input.expectedRevision+1
    &&configuration.businessName===input.businessName&&configuration.sector===input.sector
    &&fieldNames.every(field=>configuration.knowledge[field]===input.knowledge[field])
    &&configuration.transferDestination===input.transferDestination&&(configuration.recordingEnabled??false)===input.recordingEnabled
    &&configuration.recordingPolicy===input.recordingPolicy&&configuration.recordingContactPhone===input.recordingContactPhone
}

function CorrectionComparison({locale,base,field,text,callConfiguration}:{locale:Locale;base:ActivityConfigurationDto;field:Field;text:string;callConfiguration:ActivityConfigurationDto|null}){
  const t=correctionMessages[locale]
  return <>
    {callConfiguration&&<div><h3>{t.callValue}</h3><p className="sparra-correction-text">{callConfiguration.knowledge[field]||'—'}</p></div>}
    <section aria-label={t.compare}><Heading level={3}>{t.compare}</Heading><dl><dt>{t.before}</dt><dd className="sparra-correction-text">{base.knowledge[field]||'—'}</dd><dt>{t.after}</dt><dd className="sparra-correction-text">{text||'—'}</dd></dl></section>
  </>
}

export function RequestCorrection({locale,callConfiguration,callRevision,blocked,actionLock,onPendingChange,onRead,onSave,onRefused}:Props){
  const t=correctionMessages[locale],hydrated=useHydrated(),begin=useRequestAttempt()
  const [open,setOpen]=useState(false),[symptom,setSymptom]=useState<Symptom|null>(null)
  const [base,setBase]=useState<ActivityConfigurationDto|null>(null),[hasRead,setHasRead]=useState(false),[audioAvailable,setAudioAvailable]=useState(false)
  const [field,setField]=useState<Field|null>(null),[text,setText]=useState(''),[reviewed,setReviewed]=useState(false)
  const [pending,setPending]=useState<'read'|'save'|null>(null),operation=useRef<'read'|'save'|null>(null)
  const [reconcile,setReconcile]=useState<'conflict'|'uncertain'|null>(null),[feedback,setFeedback]=useState<Feedback>(null)
  const attempted=useRef<AttemptedSave|null>(null)
  useEffect(()=>()=>{actionLock.current=false},[actionLock])
  const disabled=!hydrated||blocked||pending!==null
  const editDisabled=disabled||reconcile!==null
  const normalized=text.replace(/\r\n/g,'\n'),tooLong=field!==null&&normalized.length>fields[field]
  const changed=base!==null&&field!==null&&normalized!==base.knowledge[field]
  const audioBlocked=base!==null&&(base.recordingEnabled===true||(base.recordingPolicy==='local_30d'&&!audioAvailable))
  const canReview=changed&&!tooLong&&!audioBlocked&&!editDisabled
  function edit(value:string){if(editDisabled)return;setText(value);setReviewed(false);setFeedback(null)}
  function selectField(next:Field){if(editDisabled||!base)return;setField(next);setText(base.knowledge[next]);setReviewed(false);setFeedback(null)}
  function release(){operation.current=null;actionLock.current=false;setPending(null);onPendingChange(false)}
  async function readCurrent(){
    if(!hydrated||actionLock.current)return
    actionLock.current=true;operation.current='read';setPending('read');onPendingChange(true);setReviewed(false)
    const {signal,live}=begin()
    try{
      const state=await privateResult(onRead(signal));if(!live())return
      // A pinned call cannot be used to edit a different workspace's configuration.
      const current=state.configuration&&state.workspace?.id===state.configuration.workspaceId&&(!callConfiguration||callConfiguration.workspaceId===state.configuration.workspaceId)?state.configuration:null
      const previous=reconcile,attempt=attempted.current
      setBase(current);setHasRead(true);setAudioAvailable(state.localAudioAvailable);setReconcile(null)
      setFeedback(previous==='uncertain'&&attempt?(containsAttempt(current,attempt)?'observed':'different'):previous?'reread':null)
      attempted.current=null
    }catch(error){if(live()){if(error instanceof Response&&error.status===401)await onRefused();else setFeedback('unavailable')}}
    finally{if(live())release()}
  }
  async function save(){
    if(!reviewed||!canReview||!base||!field||actionLock.current)return
    const attempt={workspaceId:base.workspaceId,input:correctionInput(base,field,text)}
    attempted.current=attempt;actionLock.current=true;operation.current='save';setPending('save');onPendingChange(true);setFeedback(null);setReviewed(false)
    const {signal,live}=begin()
    try{
      const result=await privateResult(onSave(attempt.input,signal));if(!live())return
      if(!containsAttempt(result,attempt)){setReconcile('uncertain');return}
      setBase(result);setFeedback('saved');setReconcile(null);attempted.current=null
    }catch(error){
      if(!live())return
      if(error instanceof Response&&(error.status===401||(error.status===409&&error.headers.get('x-sparra-activity-error')==='workspace-changed'))){await onRefused();return}
      if(error instanceof Response&&error.status===409){setReconcile('conflict');if(error.headers.get('x-sparra-activity-error')==='recording-unavailable')setFeedback('recording')}
      else if(error instanceof Response&&error.status===400){setFeedback('invalid');attempted.current=null}
      else setReconcile('uncertain')
    }finally{if(live())release()}
  }
  function stopWaiting(){if(operation.current!=='save')return;begin();setReconcile('uncertain');setReviewed(false);release()}
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
            {!reviewed?<Button label={t.review} isDisabled={!canReview} onClick={()=>{if(canReview)setReviewed(true)}}/>:<><p>{t.confirmHint}</p><Button label={t.confirm} variant="primary" isDisabled={!canReview} onClick={()=>void save()}/></>}
          </>}
          {audioBlocked&&<p role="alert">{t.recording} <a href={`/app/entreprise?lang=${locale}`}>{t.business}</a></p>}
        </>}
        {pending&&<p role="status">{pending==='read'?t.reading:t.saving}</p>}
        {pending==='save'&&<><p>{t.saveWait}</p><Button label={t.stop} onClick={stopWaiting}/></>}
        {reconcile&&<p role="alert">{t[reconcile]}</p>}
        {feedback&&<p role={feedback==='saved'||feedback==='observed'||feedback==='reread'?'status':'alert'}>{t[feedback]}</p>}
      </>}
    </>}
  </section>
}
