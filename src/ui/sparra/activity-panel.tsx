import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextInput } from '@astryxdesign/core/TextInput'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Selector } from '@astryxdesign/core/Selector'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import type { ActivityConfigurationDto, ActivityState, SaveActivityInput } from '../../modules/sparra/sparra.functions'
import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import { activityMessages, appMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { privateResult, PrivateUnavailable } from './app-shell'

type Props={locale:Locale;state:ActivityState;onEnsure(signal:AbortSignal):Promise<WorkspaceDto|Response>;onSave(data:SaveActivityInput,signal:AbortSignal):Promise<ActivityConfigurationDto|Response>;onRead(signal:AbortSignal):Promise<ActivityState|Response>;onRefused():Promise<void>}
type ActivityOperation='ensure'|'save'|'latest'
type ActivityErrorReason='conflict'|'invalid'|'unavailable'|'recordingUnavailable'
type ActivityFailure={kind:'refused'}|{kind:'uncertain'}|{kind:'error';reason:ActivityErrorReason}

export function classifyActivityFailure(mode:ActivityOperation,failure:unknown):ActivityFailure{
  if(failure instanceof Response){
    switch(failure.status){
      case 401:return {kind:'refused'}
      case 409:return {kind:'error',reason:mode==='save'&&failure.headers.get('x-sparra-activity-error')==='recording-unavailable'?'recordingUnavailable':'conflict'}
      case 400:return {kind:'error',reason:'invalid'}
    }
  }
  return mode==='save'?{kind:'uncertain'}:{kind:'error',reason:'unavailable'}
}

const sections=[['openingHours',1000],['services',2000],['prices',1500],['faq',3000],['instructions',2000]] as const
function draft(configuration:ActivityConfigurationDto|null):SaveActivityInput{return configuration?{businessName:configuration.businessName,sector:configuration.sector,knowledge:{...configuration.knowledge},transferDestination:configuration.transferDestination,recordingEnabled:configuration.recordingEnabled??false,recordingPolicy:configuration.recordingPolicy,recordingContactPhone:configuration.recordingContactPhone,expectedRevision:configuration.revision}:{businessName:'',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:false,recordingPolicy:'off',recordingContactPhone:null,expectedRevision:0}}
function recordingSaveBlocked(editable:SaveActivityInput,localAudioAvailable:boolean):boolean{
  return editable.recordingEnabled===true||(!localAudioAvailable&&editable.recordingPolicy==='local_30d')
}

type ActivityField='businessName'|'transferDestination'|'recordingContactPhone'|typeof sections[number][0]
type ActivityDraftIssues={
  businessName?:'required'|'nameTooLong'
  openingHours?:'tooLong';services?:'tooLong';prices?:'tooLong';faq?:'tooLong';instructions?:'tooLong'
  transferDestination?:'phoneFormat'
  recordingContactPhone?:'phoneFormat'
}

export function activityDraftIssues(editable:SaveActivityInput):ActivityDraftIssues{
  const issues:ActivityDraftIssues={}
  const name=editable.businessName.trim()
  if(!name)issues.businessName='required'
  else if(name.length>80)issues.businessName='nameTooLong'
  for(const [field,limit] of sections)if(editable.knowledge[field].replace(/\r\n/g,'\n').length>limit)issues[field]='tooLong'
  if(editable.transferDestination!=null&&!/^\+[1-9][0-9]{1,14}$/.test(editable.transferDestination))issues.transferDestination='phoneFormat'
  if(editable.recordingContactPhone!=null&&!/^\+[1-9][0-9]{1,14}(?![\s\S])/.test(editable.recordingContactPhone))issues.recordingContactPhone='phoneFormat'
  return issues
}

export function activityMatchesConfiguration(editable:SaveActivityInput,configuration:ActivityConfigurationDto|null):boolean{
  return configuration!==null&&editable.businessName===configuration.businessName&&editable.sector===configuration.sector&&(editable.transferDestination??null)===configuration.transferDestination&&(editable.recordingEnabled??false)===(configuration.recordingEnabled??false)&&(editable.recordingPolicy??'off')===configuration.recordingPolicy&&(editable.recordingContactPhone??null)===configuration.recordingContactPhone&&sections.every(([field])=>editable.knowledge[field]===configuration.knowledge[field])
}

type ActivityFieldStatus={type:'error';message:string}|undefined
function ActivityKnowledgeFields({locale,editable,disabled,onEdit,fieldRef,fieldStatus}:{locale:Locale;editable:SaveActivityInput;disabled:boolean;onEdit(next:SaveActivityInput):void;fieldRef(field:ActivityField,element:HTMLInputElement|HTMLTextAreaElement|null):void;fieldStatus(field:ActivityField,limit:number):ActivityFieldStatus}){
  const t=activityMessages[locale],examples=editable.sector==='controle-technique'?t.inspectionExamples:t.fieldExamples
  return <fieldset className="sparra-form-section"><legend>{t.answerInformation}</legend><p className="sparra-form-hint">{t.knowledgeHint}</p><div className="sparra-knowledge-fields">{sections.map(([field,limit],index)=><div key={field} className={index<2?'sparra-knowledge-primary':'sparra-knowledge-secondary'}><TextArea ref={element=>fieldRef(field,element)} label={t[field]} description={t.fieldHints[field]} placeholder={examples[field]} htmlName={field} value={editable.knowledge[field]} onChange={value=>onEdit({...editable,knowledge:{...editable.knowledge,[field]:value}})} rows={index<2?4:3} status={fieldStatus(field,limit)} statusVariant="detached" isDisabled={disabled} width="100%"/><p className="sparra-field-limit">{limit} {t.characterLimit}</p></div>)}</div></fieldset>
}

function ActivityRecordingControl({locale,editable,configuration,localAudioAvailable,disabled,pending,reconcile,onEdit}:{locale:Locale;editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;disabled:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void}){
  const t=activityMessages[locale]
  const recordingOn=editable.recordingPolicy==='local_30d',legacy=editable.recordingEnabled===true
  const deactivating=configuration?.recordingPolicy==='local_30d'&&!recordingOn||configuration?.recordingEnabled===true&&!legacy
  return <div>{!localAudioAvailable&&<p className="sparra-recording-warning" role="alert">{t.recordingUnavailable}</p>}{legacy&&<><p className="sparra-recording-warning" role="alert">{t.recordingLegacy}</p><Button label={t.recordingCorrectLegacy} isDisabled={disabled} onClick={()=>onEdit({...editable,recordingEnabled:false})}/></>}<CheckboxInput label={t.recordingEnabled} description={t.recordingHint} htmlName="recordingPolicy" value={recordingOn} onChange={value=>onEdit({...editable,recordingPolicy:value?'local_30d':'off'})} isDisabled={disabled||legacy||(!localAudioAvailable&&!recordingOn)} disabledMessage={!disabled&&!legacy&&!localAudioAvailable&&!recordingOn?t.recordingUnavailable:undefined} width="100%"/>{deactivating&&!pending&&!reconcile&&<p className="sparra-recording-note" role="status">{t.recordingDeactivation}</p>}</div>
}

function useActivityValidation({locale,editable,disabled,saveBlocked,onSubmit}:{locale:Locale;editable:SaveActivityInput;disabled:boolean;saveBlocked:boolean;onSubmit():void}){
  const t=activityMessages[locale]
  const [validated,setValidated]=useState(false)
  const fields=useRef<Partial<Record<ActivityField,HTMLInputElement|HTMLTextAreaElement>>>({})
  const issues:ActivityDraftIssues=validated?activityDraftIssues(editable):{}
  function fieldRef(field:ActivityField,element:HTMLInputElement|HTMLTextAreaElement|null){if(element)fields.current[field]=element;else delete fields.current[field]}
  function fieldStatus(field:ActivityField,limit=80):ActivityFieldStatus{
    const issue=issues[field]
    return issue?{type:'error',message:issue==='tooLong'?`${t.fieldErrors.tooLong} ${limit} ${t.characterLimit}.`:t.fieldErrors[issue]}:undefined
  }
  function submit(){
    if(disabled||saveBlocked)return
    const nextIssues=activityDraftIssues(editable)
    setValidated(true)
    const first=(['businessName','openingHours','services','prices','faq','instructions','transferDestination','recordingContactPhone'] as const).find(field=>nextIssues[field])
    if(first){fields.current[first]?.focus();return}
    onSubmit()
  }
  return {issues,fieldRef,fieldStatus,submit}
}

function ActivitySaveSummary({locale,issues,pending,reconcile,draftStatus}:{locale:Locale;issues:ActivityDraftIssues;pending:boolean;reconcile:boolean;draftStatus:string}){
  const t=activityMessages[locale]
  return <div className="sparra-save-summary">{Object.keys(issues).length>0&&<p role="alert">{t.localInvalid}</p>}{!pending&&!reconcile&&<p className="sparra-draft-status" role="status">{draftStatus}</p>}<p className="sparra-form-hint">{t.saveHint}</p></div>
}

function ActivityEditor({locale,editable,configuration,localAudioAvailable,audioBlocked,draftStatus,hydrated,pending,reconcile,onEdit,onSubmit}:{locale:Locale;editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;audioBlocked:boolean;draftStatus:string;hydrated:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void;onSubmit():void}){
  const t=activityMessages[locale],disabled=!hydrated||pending
  const saveBlocked=reconcile||audioBlocked
  const {issues,fieldRef,fieldStatus,submit}=useActivityValidation({locale,editable,disabled,saveBlocked,onSubmit})
  return <form className="sparra-business-form" aria-busy={pending} onSubmit={event=>{event.preventDefault();submit()}}>
    <fieldset className="sparra-form-section"><legend>{t.establishment}</legend><p className="sparra-form-hint">{t.requiredHint}</p><div className="sparra-field-pair">
    <TextInput ref={element=>fieldRef('businessName',element)} size="lg" label={t.businessName} description={t.businessNameHint} placeholder={t.businessNamePlaceholder} value={editable.businessName} onChange={businessName=>onEdit({...editable,businessName})} htmlName="businessName" status={fieldStatus('businessName')} statusVariant="detached" isRequired isDisabled={disabled} width="100%"/>
    <Selector size="lg" label={t.sector} description={t.sectorHint} value={editable.sector} options={[{value:'garage',label:t.garage},{value:'controle-technique',label:t.controleTechnique}]} onChange={sector=>{if(sector==='garage'||sector==='controle-technique')onEdit({...editable,sector})}} isRequired isDisabled={disabled} width="100%"/>
    </div></fieldset>
    <ActivityKnowledgeFields locale={locale} editable={editable} disabled={disabled} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/>
    <fieldset className="sparra-form-section"><legend>{t.callHandling}</legend><div className="sparra-call-settings">
    <TextInput ref={element=>fieldRef('transferDestination',element)} size="lg" label={t.transferDestination} description={`${t.transferHint} ${t.transferFormat}`} placeholder={t.transferPlaceholder} htmlName="transferDestination" value={editable.transferDestination??''} onChange={value=>onEdit({...editable,transferDestination:value||null})} status={fieldStatus('transferDestination')} statusVariant="detached" isDisabled={disabled} width="100%"/>
    <ActivityRecordingControl locale={locale} editable={editable} configuration={configuration} localAudioAvailable={localAudioAvailable} disabled={disabled} pending={pending} reconcile={reconcile} onEdit={onEdit}/>
    <TextInput ref={element=>fieldRef('recordingContactPhone',element)} size="lg" label={t.recordingContactPhone} description={t.recordingContactHint} placeholder={t.recordingContactPlaceholder} htmlName="recordingContactPhone" value={editable.recordingContactPhone??''} onChange={value=>onEdit({...editable,recordingContactPhone:value||null})} status={fieldStatus('recordingContactPhone')} statusVariant="detached" isDisabled={disabled} width="100%"/>
    </div>
    </fieldset>
    <ActivitySaveSummary locale={locale} issues={issues} pending={pending} reconcile={reconcile} draftStatus={draftStatus}/>
    <Button className="sparra-form-submit" variant="primary" label={t.save} type="submit" isDisabled={!hydrated||saveBlocked} isLoading={pending}/>
  </form>
}

function ActivityLatestInformation({locale,editable,pending,latest,onReplaceLatest}:{locale:Locale;editable:SaveActivityInput;pending:boolean;latest:ActivityState;onReplaceLatest(state:ActivityState):void}){
  const t=activityMessages[locale],a=appMessages[locale]
  return <div className="sparra-latest-information"><p role="status">{latest.configuration?(activityMatchesConfiguration(editable,latest.configuration)?t.latestMatches:t.latestDiffers):t.noSavedConfiguration}</p>{latest.configuration&&<p className="sparra-version-note">{a.latest}: {latest.configuration.revision}</p>}<p>{t.replaceWarning}</p><Button label={a.loadLatest} isDisabled={pending} onClick={()=>onReplaceLatest(latest)}/></div>
}

function ActivityReconciliation({locale,editable,pending,reconcile,latest,onCheckLatest,onReplaceLatest}:{locale:Locale;editable:SaveActivityInput;pending:boolean;reconcile:boolean;latest:ActivityState|null;onCheckLatest():void;onReplaceLatest(state:ActivityState):void}){
  if(!reconcile)return null
  return <div className="sparra-conflict"><Button label={appMessages[locale].checkLatest} isDisabled={pending} onClick={onCheckLatest}/>{latest&&<ActivityLatestInformation locale={locale} editable={editable} pending={pending} latest={latest} onReplaceLatest={onReplaceLatest}/>}</div>
}

function ActivityPendingFeedback({locale,mode,onCancel}:{locale:Locale;mode:ActivityOperation|null;onCancel():void}){
  if(mode===null)return null
  const t=activityMessages[locale],a=appMessages[locale]
  if(mode==='save')return <><p role="status">{t.saving}</p><p className="sparra-form-hint">{t.saveWaitHint}</p><Button label={t.stopWaiting} onClick={onCancel}/></>
  return <><p role="status">{mode==='ensure'?t.ensuring:t.checking}</p><Button label={a.cancel} onClick={onCancel}/></>
}

function ActivityOutcomeFeedback({locale,uncertain,error,saved}:{locale:Locale;uncertain:boolean;error:string;saved:boolean}){
  const t=activityMessages[locale]
  return <>{uncertain&&<p role="alert">{t.outcomeUnknown}</p>}{error&&<p role="alert">{error}</p>}{saved&&<p role="status">{t.saved}</p>}</>
}

function ActivityWorkspaceContent({locale,workspace,configuration,localAudioAvailable,editable,hydrated,audioBlocked,pending,reconcile,onEdit,onEnsure,onSave,children}:{locale:Locale;workspace:WorkspaceDto|null;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;editable:SaveActivityInput;hydrated:boolean;audioBlocked:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void;onEnsure():void;onSave():void;children:ReactNode}){
  const t=activityMessages[locale],a=appMessages[locale]
  const draftStatus=configuration?(activityMatchesConfiguration(editable,configuration)?t.upToDate:t.unsaved):t.noSavedConfiguration
  let content:ReactNode
  if(workspace)content=<ActivityEditor locale={locale} editable={editable} configuration={configuration} localAudioAvailable={localAudioAvailable} audioBlocked={audioBlocked} draftStatus={draftStatus} hydrated={hydrated} pending={pending} reconcile={reconcile} onEdit={onEdit} onSubmit={onSave}/>
  else content=<><p>{a.createHint}</p><Button label={a.create} isDisabled={!hydrated} isLoading={pending} onClick={onEnsure}/></>
  return <>{content}{children}
    {configuration&&<p className="sparra-version-note">{a.version}: {configuration.revision}</p>}
  </>
}

function useActivitySaveFeedback(locale:Locale,onRecordingUnavailable:()=>void){
  const [saved,setSaved]=useState(false),[conflict,setConflict]=useState(false),[uncertain,setUncertain]=useState(false),[latest,setLatest]=useState<ActivityState|null>(null)
  const [error,setError]=useState('')
  function showError(reason:ActivityErrorReason){
    if(reason==='conflict')setConflict(true)
    if(reason==='recordingUnavailable'){onRecordingUnavailable();return}
    setError(activityMessages[locale][reason])
  }
  return {saved,setSaved,conflict,setConflict,uncertain,setUncertain,latest,setLatest,error,setError,showError}
}

export function ActivityPanel({locale,state,onEnsure,onSave,onRead,onRefused}:Props){
  const a=appMessages[locale],hydrated=useHydrated()
  const [current,setCurrent]=useState(state),[editable,setEditable]=useState(()=>draft(state.configuration)),[pendingMode,setPendingMode]=useState<ActivityOperation|null>(null)
  const {saved,setSaved,conflict,setConflict,uncertain,setUncertain,latest,setLatest,error,setError,showError}=useActivitySaveFeedback(locale,()=>setCurrent(previous=>({...previous,localAudioAvailable:false})))
  const reconcile=conflict||uncertain
  const audioBlocked=recordingSaveBlocked(editable,current.localAudioAvailable)
  const attempt=useRef(0),controller=useRef<AbortController|null>(null)
  const [refused,setRefused]=useState(false)
  useEffect(()=>()=>{attempt.current++;controller.current?.abort()},[])
  function edit(next:SaveActivityInput){setEditable(next);setSaved(false)}
  function replaceDraft(read:ActivityState){edit(draft(read.configuration));setCurrent(read);setConflict(false);setUncertain(false);setError('');setLatest(null)}
  async function ensureWorkspace(signal:AbortSignal,live:()=>boolean){
    await privateResult(onEnsure(signal))
    const read=await privateResult(onRead(signal))
    if(live()){setCurrent(read);setEditable(draft(read.configuration))}
  }
  async function readLatest(signal:AbortSignal,live:()=>boolean){
    const read=await privateResult(onRead(signal))
    if(live())setLatest(read)
  }
  async function saveDraft(signal:AbortSignal,live:()=>boolean){
    const configuration=await privateResult(onSave(editable,signal))
    if(live()){setCurrent({...current,configuration});setEditable(draft(configuration));setSaved(true);setConflict(false);setUncertain(false);setLatest(null)}
  }
  async function interpretFailure(mode:ActivityOperation,failure:unknown){
    const outcome=classifyActivityFailure(mode,failure)
    if(outcome.kind==='refused'){setRefused(true);await onRefused();return}
    if(outcome.kind==='uncertain'){setUncertain(true);setLatest(null);return}
    showError(outcome.reason)
  }
  async function performOperation(mode:ActivityOperation,signal:AbortSignal,live:()=>boolean){
    if(mode==='ensure')return ensureWorkspace(signal,live)
    if(mode==='latest')return readLatest(signal,live)
    return saveDraft(signal,live)
  }
  async function persist(mode:ActivityOperation){
    if(mode==='save'&&audioBlocked)return
    controller.current?.abort();const owned=new AbortController(),id=++attempt.current;controller.current=owned
    const live=()=>!owned.signal.aborted&&attempt.current===id
    setPendingMode(mode);setSaved(false);if(mode!=='latest')setError('')
    await performOperation(mode,owned.signal,live)
      .catch(async failure=>{if(live())await interpretFailure(mode,failure)})
      .finally(()=>{if(live())setPendingMode(null)})
  }
  function cancel(){
    attempt.current++;controller.current?.abort()
    if(pendingMode==='save'){setUncertain(true);setLatest(null)}
    setPendingMode(null)
  }
  if(refused)return <PrivateUnavailable locale={locale} title={a.business}/>
  return <><div className="sparra-page-heading"><Heading level={1}>{a.business}</Heading><p>{activityMessages[locale].description}</p></div>
    <ActivityWorkspaceContent locale={locale} workspace={current.workspace} configuration={current.configuration} localAudioAvailable={current.localAudioAvailable} editable={editable} hydrated={hydrated} audioBlocked={audioBlocked} pending={pendingMode!==null} reconcile={reconcile} onEdit={edit} onEnsure={()=>void persist('ensure')} onSave={()=>void persist('save')}>
      <ActivityPendingFeedback locale={locale} mode={pendingMode} onCancel={cancel}/>
      <ActivityOutcomeFeedback locale={locale} uncertain={uncertain} error={error} saved={saved}/>
      <ActivityReconciliation locale={locale} editable={editable} pending={pendingMode!==null} reconcile={reconcile} latest={latest} onCheckLatest={()=>void persist('latest')} onReplaceLatest={replaceDraft}/>
    </ActivityWorkspaceContent>
  </>
}
