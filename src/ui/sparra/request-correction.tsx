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
type Reconcile='conflict'|'uncertain'|null
type AttemptedSave={workspaceId:string;input:ConfirmActivityInput;confirmation:ActivityConfirmationDto|null}
type Outcome={reconcile:Reconcile;feedback:Feedback;receipt:ActivityConfirmationLookup|null}
type Proposal={field:Field|null;text:string;reviewed:boolean;attested:boolean}
type CurrentActivity={base:ActivityConfigurationDto|null;hasRead:boolean;audioAvailable:boolean}

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
function isRefused(error:unknown){return error instanceof Response&&(error.status===401||(error.status===409&&error.headers.get('x-sparra-activity-error')==='workspace-changed'))}
function saveFailure(error:unknown,confirmed:boolean){
  if(isRefused(error))return 'refused'
  if(confirmed)return 'uncertain'
  if(!(error instanceof Response))return 'uncertain'
  if(error.status===400)return 'invalid'
  if(error.status!==409)return 'uncertain'
  return error.headers.get('x-sparra-activity-error')==='recording-unavailable'?'recording':'conflict'
}
function readFeedback(current:ActivityConfigurationDto|null,previous:Reconcile,attempt:AttemptedSave|null,receipt:ActivityConfirmationLookup|null):Feedback{
  if(!previous)return null
  if(previous!=='uncertain'||!attempt)return 'reread'
  if(receipt&&confirmedHead(current,attempt,receipt))return 'saved'
  if(receipt?.status==='unverifiable'&&containsAttempt(current,attempt))return 'observed'
  return 'different'
}
async function readPinnedActivity(workspaceId:string,onRead:Props['onRead'],onRefused:Props['onRefused'],owned:CorrectionAttempt){
  const state=await privateResult(onRead(owned.signal))
  if(!owned.live())return null
  if(state.workspace?.id!==workspaceId){await onRefused();return null}
  if(state.configuration!==null&&state.configuration.workspaceId!==workspaceId){await onRefused();return null}
  return state
}
function correctionControls(current:CurrentActivity,proposal:Proposal,disabled:boolean,reconcile:Reconcile){
  const normalized=proposal.text.replace(/\r\n/g,'\n'),limit=proposal.field===null?Infinity:fields[proposal.field]
  const changed=current.base!==null&&proposal.field!==null&&normalized!==current.base.knowledge[proposal.field]
  const audioBlocked=current.base!==null&&(current.base.recordingEnabled===true||(current.base.recordingPolicy==='local_30d'&&!current.audioAvailable))
  const editDisabled=disabled||reconcile!==null,tooLong=normalized.length>limit
  return {normalized,changed,audioBlocked,editDisabled,tooLong,canReview:changed&&!tooLong&&!audioBlocked&&!editDisabled}
}
function useCorrectionDraft(){
  const [current,setCurrent]=useState<CurrentActivity>({base:null,hasRead:false,audioAvailable:false})
  const [proposal,setProposal]=useState<Proposal>({field:null,text:'',reviewed:false,attested:false})
  function resetReview(){setProposal(value=>({...value,reviewed:false,attested:false}))}
  function adopt(state:ActivityState){setCurrent({base:state.configuration,hasRead:true,audioAvailable:state.localAudioAvailable});resetReview()}
  function edit(text:string){setProposal(value=>({...value,text,reviewed:false,attested:false}))}
  function selectField(field:Field){if(current.base)setProposal({field,text:current.base.knowledge[field],reviewed:false,attested:false})}
  return {current,proposal,resetReview,adopt,edit,selectField,review(){setProposal(value=>({...value,reviewed:true,attested:false}))},attest(attested:boolean){setProposal(value=>({...value,attested}))}}
}
function useCorrectionOperations({workspaceId,onBegin,onRead,onConfirm,onLookup,onRefused}:Pick<Props,'workspaceId'|'onBegin'|'onRead'|'onConfirm'|'onLookup'|'onRefused'>,draft:ReturnType<typeof useCorrectionDraft>){
  const [pending,setPending]=useState<'read'|'save'|null>(null),[outcome,setOutcome]=useState<Outcome>({reconcile:null,feedback:null,receipt:null})
  const operation=useRef<CorrectionAttempt|null>(null),attempted=useRef<AttemptedSave|null>(null)
  function release(owned:CorrectionAttempt){if(operation.current!==owned)return;operation.current=null;owned.release();setPending(null)}
  function start(mode:'read'|'save'){
    const owned=onBegin();if(!owned)return null
    operation.current=owned;setPending(mode);draft.resetReview();return owned
  }
  async function lookupAttempt(owned:CorrectionAttempt,attempt:AttemptedSave|null){
    if(outcome.reconcile!=='uncertain'||!attempt)return null
    const receipt=await privateResult(onLookup({draftId:attempt.input.draftId,draftVersion:attempt.input.draftVersion,expectedWorkspaceId:attempt.workspaceId},owned.signal))
    if(owned.live())setOutcome(value=>({...value,receipt}))
    return receipt
  }
  async function readCurrent(){
    const owned=start('read');if(!owned)return
    const previous=outcome.reconcile,attempt=attempted.current
    try{
      const receipt=await lookupAttempt(owned,attempt);if(!owned.live())return
      const state=await readPinnedActivity(workspaceId,onRead,onRefused,owned);if(!state)return
      draft.adopt(state);setOutcome(value=>({...value,reconcile:null,feedback:readFeedback(state.configuration,previous,attempt,receipt)}));attempted.current=null
    }catch(error){if(!owned.live())return;if(isRefused(error))await onRefused();else setOutcome(value=>({...value,feedback:'unavailable'}))}
    finally{if(owned.live())release(owned)}
  }
  async function confirmAndRead(owned:CorrectionAttempt,attempt:AttemptedSave){
    const receipt=await privateResult(onConfirm(attempt.input,owned.signal));if(!owned.live())return
    if(!exactReceipt(receipt,attempt)){setOutcome(value=>({...value,reconcile:'uncertain'}));return}
    attempt.confirmation=receipt;setOutcome(value=>({...value,receipt}))
    const state=await readPinnedActivity(workspaceId,onRead,onRefused,owned);if(!state)return
    if(!confirmedHead(state.configuration,attempt,receipt)){setOutcome(value=>({...value,reconcile:'uncertain'}));return}
    draft.adopt(state);setOutcome({reconcile:null,feedback:'saved',receipt});attempted.current=null
  }
  async function interpretSaveFailure(error:unknown,attempt:AttemptedSave){
    const reason=saveFailure(error,attempt.confirmation!==null)
    if(reason==='refused'){await onRefused();return}
    if(reason==='uncertain'){setOutcome(value=>({...value,reconcile:'uncertain'}));return}
    attempted.current=null
    if(reason==='invalid'){setOutcome(value=>({...value,feedback:'invalid'}));return}
    setOutcome(value=>({...value,reconcile:'conflict',feedback:reason==='recording'?'recording':null}))
  }
  async function save(input:ConfirmActivityInput['activity']){
    const owned=start('save');if(!owned)return
    const attempt:AttemptedSave={workspaceId,input:{draftId:globalThis.crypto.randomUUID(),draftVersion:1,expectedWorkspaceId:workspaceId,activity:input,decisions:[],confirmed:true},confirmation:null}
    attempted.current=attempt;setOutcome({reconcile:null,feedback:null,receipt:null})
    try{await confirmAndRead(owned,attempt)}catch(error){if(owned.live())await interpretSaveFailure(error,attempt)}finally{if(owned.live())release(owned)}
  }
  function stopWaiting(){const owned=operation.current;if(pending!=='save'||!owned)return;owned.cancel();setOutcome(value=>({...value,reconcile:'uncertain'}));draft.resetReview();release(owned)}
  function clearFeedback(){setOutcome(value=>({...value,feedback:null,receipt:null}))}
  return {pending,outcome,readCurrent,save,stopWaiting,clearFeedback}
}
function useRequestCorrection(props:Props){
  const hydrated=useHydrated(),draft=useCorrectionDraft(),requests=useCorrectionOperations(props,draft)
  const disabled=!hydrated||props.blocked||requests.pending!==null,controls=correctionControls(draft.current,draft.proposal,disabled,requests.outcome.reconcile)
  function edit(text:string){if(controls.editDisabled)return;draft.edit(text);requests.clearFeedback()}
  function selectField(field:Field){if(controls.editDisabled)return;draft.selectField(field);requests.clearFeedback()}
  function review(){if(controls.canReview)draft.review()}
  async function save(){
    if(!controls.canReview||!draft.proposal.reviewed||!draft.proposal.attested)return
    const {base}=draft.current,{field}=draft.proposal;if(!base||!field)return
    await requests.save(correctionInput(props.workspaceId,base,field,draft.proposal.text))
  }
  function readCurrent(){if(!disabled)void requests.readCurrent()}
  return {...draft,...requests,...controls,disabled,edit,selectField,review,save,readCurrent}
}
type CorrectionModel=ReturnType<typeof useRequestCorrection>

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
  return <>{callConfiguration&&<div><h3>{t.callValue}</h3><p className="sparra-correction-text">{callConfiguration.knowledge[field]||'—'}</p></div>}<section aria-label={t.compare}><Heading level={3}>{t.compare}</Heading><dl><dt>{t.before}</dt><dd className="sparra-correction-text">{base.knowledge[field]||'—'}</dd><dt>{t.after}</dt><dd className="sparra-correction-text">{text||'—'}</dd></dl></section></>
}
function CorrectionProposal({locale,workspaceId,callConfiguration,base,field,model}:{locale:Locale;workspaceId:string;callConfiguration:ActivityConfigurationDto|null;base:ActivityConfigurationDto;field:Field;model:CorrectionModel}){
  const t=correctionMessages[locale],{proposal}=model
  return <><TextArea label={t.proposed} description={activityMessages[locale].fieldHints[field]} value={proposal.text} onChange={model.edit} isDisabled={model.editDisabled} rows={5} width="100%" status={model.tooLong?{type:'error',message:`${t.limit} ${fields[field]}`}:undefined} statusVariant="detached"/>
    {callConfiguration&&<Button label={t.useCall} isDisabled={model.editDisabled} onClick={()=>model.edit(callConfiguration.knowledge[field])}/>}
    <CorrectionComparison locale={locale} base={base} field={field} text={model.normalized} callConfiguration={callConfiguration}/>
    {!model.changed&&<p>{t.unchanged}</p>}
    {!proposal.reviewed?<Button label={t.review} isDisabled={!model.canReview} onClick={model.review}/>:<><CorrectionFinalReview locale={locale} input={correctionInput(workspaceId,base,field,proposal.text)} attested={proposal.attested} disabled={model.editDisabled} onAttest={model.attest}/><p>{t.confirmHint}</p><Button label={t.confirm} variant="primary" isDisabled={!model.canReview||!proposal.attested} onClick={()=>void model.save()}/></>}
  </>
}
function CorrectionFeedback({locale,model}:{locale:Locale;model:CorrectionModel}){
  const t=correctionMessages[locale],{pending,outcome}=model
  const status=outcome.feedback==='saved'||outcome.feedback==='observed'||outcome.feedback==='reread'
  return <>{pending&&<p role="status">{pending==='read'?t.reading:t.saving}</p>}{pending==='save'&&<><p>{t.saveWait}</p><Button label={t.stop} onClick={model.stopWaiting}/></>}{outcome.reconcile&&<p role="alert">{t[outcome.reconcile]}</p>}{outcome.receipt?.status==='confirmed'&&<p role="status">{t.historical} {outcome.receipt.revision} ({outcome.receipt.savedAt}).</p>}{outcome.feedback&&<p role={status?'status':'alert'}>{t[outcome.feedback]}</p>}</>
}
function CorrectionKnowledge({locale,workspaceId,callConfiguration,callRevision,model}:Pick<Props,'locale'|'workspaceId'|'callConfiguration'|'callRevision'>&{model:CorrectionModel}){
  const t=correctionMessages[locale],{current,proposal}=model
  return <><p>{t.local}</p><p>{callRevision!==null?`${t.callVersion}: ${callRevision}`:t.noSnapshot}</p>{!callConfiguration&&callRevision!==null&&<p>{t.noSnapshot}</p>}
    <Button label={t.read} isDisabled={model.disabled} onClick={model.readCurrent}/>
    {current.hasRead&&!current.base&&<p>{t.noConfiguration} <a href={`/app/entreprise?lang=${locale}`}>{t.business}</a></p>}
    {current.base&&<><p>{t.currentVersion}: {current.base.revision}</p><div role="group" aria-label={t.field} className="sparra-helper-choices">{fieldNames.map(value=><Button key={value} label={activityMessages[locale][value]} aria-pressed={proposal.field===value} isDisabled={model.editDisabled} onClick={()=>model.selectField(value)}/>)}</div>
      {proposal.field&&<CorrectionProposal locale={locale} workspaceId={workspaceId} callConfiguration={callConfiguration} base={current.base} field={proposal.field} model={model}/>}
      {model.audioBlocked&&<p role="alert">{t.recording} <a href={`/app/entreprise?lang=${locale}`}>{t.business}</a></p>}</>}
    <CorrectionFeedback locale={locale} model={model}/></>
}
export function RequestCorrection(props:Props){
  const {locale}=props,t=correctionMessages[locale],model=useRequestCorrection(props)
  const [review,setReview]=useState<{open:boolean;symptom:Symptom|null}>({open:false,symptom:null})
  function chooseSymptom(symptom:Symptom){if(model.editDisabled)return;setReview({open:true,symptom});if(symptom==='knowledge'&&!model.current.hasRead)model.readCurrent()}
  return <section className="sparra-request-correction" aria-label={t.title}>{!review.open?<Button label={t.open} isDisabled={model.disabled} onClick={()=>{if(!model.disabled)setReview({open:true,symptom:null})}}/>:<>
    <Heading level={2}>{t.title}</Heading><p>{t.symptom}</p><div className="sparra-helper-choices">{symptoms.map(value=><Button key={value} label={t.symptoms[value]} aria-pressed={review.symptom===value} isDisabled={model.editDisabled} onClick={()=>chooseSymptom(value)}/>)}</div><p className="sparra-form-hint">{t.noTest}</p>
    {review.symptom&&review.symptom!=='knowledge'&&<p>{t.guidance[review.symptom]}</p>}{review.symptom==='knowledge'&&<CorrectionKnowledge locale={locale} workspaceId={props.workspaceId} callConfiguration={props.callConfiguration} callRevision={props.callRevision} model={model}/>}</>}
  </section>
}
