import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextInput } from '@astryxdesign/core/TextInput'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Selector } from '@astryxdesign/core/Selector'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import type { ActivityConfigurationDto, ActivityState, SaveActivityInput, ConfirmActivityInput, ActivityConfirmationDto, ActivityConfirmationKey, ActivityConfirmationLookup, KnowledgeImportDto } from '../../modules/sparra/sparra.functions'
import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import { activityMessages, appMessages, knowledgeMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { getSectorPreset, sectorIds } from '../../modules/sparra/sectors'
import { privateResult, PrivateUnavailable } from './app-shell'
import { KnowledgeImportPanel, KnowledgeOrigin, type KnowledgePreparation } from './knowledge-import-panel'
import { ActivityFaqHelper, ActivityIntakeHelper } from './activity-knowledge-helpers'

export type ActivityNavigationState={dirty:boolean;pending:boolean;reconcile:boolean}

type Props={onNavigationStateChange?:(state:ActivityNavigationState)=>void;externalNavigationPending?:boolean;initialSection?:ActivitySection;calendarSlot?:ReactNode;locale:Locale;state:ActivityState;onEnsure(signal:AbortSignal):Promise<WorkspaceDto|Response>;onConfirm(data:ConfirmActivityInput,signal:AbortSignal):Promise<ActivityConfirmationDto|Response>;onLookup(key:ActivityConfirmationKey,signal:AbortSignal):Promise<ActivityConfirmationLookup|Response>;onImport(url:string,signal:AbortSignal):Promise<KnowledgeImportDto|Response>;onRead(signal:AbortSignal):Promise<ActivityState|Response>;onRefused():Promise<void>}
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

export function activityRecordingContactVisible(editable:SaveActivityInput,configuration:ActivityConfigurationDto|null):boolean{
  return editable.recordingPolicy==='local_30d'||editable.recordingContactPhone!=null||configuration?.recordingContactPhone!=null
}

export function activitySaveBlocked(editable:SaveActivityInput,configuration:ActivityConfigurationDto|null,audioBlocked:boolean,reconcile=false):boolean{
  return reconcile||audioBlocked||activityMatchesConfiguration(editable,configuration)
}

type ActivityFieldStatus={type:'error';message:string}|undefined
function ActivityKnowledgeFields({locale,editable,disabled,onEdit,fieldRef,fieldStatus,onPreparedAnswersChange}:{onPreparedAnswersChange:(value:boolean)=>void;locale:Locale;editable:SaveActivityInput;disabled:boolean;onEdit(next:SaveActivityInput):void;fieldRef(field:ActivityField,element:HTMLInputElement|HTMLTextAreaElement|null):void;fieldStatus(field:ActivityField,limit:number):ActivityFieldStatus}){
  const t=activityMessages[locale],preset=getSectorPreset(editable.sector,locale),examples=editable.sector==='controle-technique'?t.inspectionExamples:editable.sector==='garage'?t.fieldExamples:undefined
  return <fieldset className="sparra-form-section"><legend>{t.answerInformation}</legend><p className="sparra-form-hint">{t.knowledgeHint}</p><div className="sparra-knowledge-fields">{sections.map(([field,limit],index)=><div key={field} className={index<2?'sparra-knowledge-primary':'sparra-knowledge-secondary'}><TextArea ref={element=>fieldRef(field,element)} label={t[field]} description={t.fieldHints[field]} placeholder={examples?.[field]} htmlName={field} value={editable.knowledge[field]} onChange={value=>onEdit({...editable,knowledge:{...editable.knowledge,[field]:value}})} rows={index<2?4:3} status={fieldStatus(field,limit)} statusVariant="detached" isDisabled={disabled} width="100%"/><p className="sparra-field-limit">{limit} {t.characterLimit}</p>
    {field==='faq'&&<ActivityFaqHelper onPreparedAnswersChange={onPreparedAnswersChange} locale={locale} faq={editable.knowledge.faq} questions={preset.faqQuestions} disabled={disabled} onChange={faq=>onEdit({...editable,knowledge:{...editable.knowledge,faq}})}/>}
    {field==='instructions'&&<ActivityIntakeHelper locale={locale} instructions={editable.knowledge.instructions} questions={preset.intakeQuestions} disabled={disabled} onChange={instructions=>onEdit({...editable,knowledge:{...editable.knowledge,instructions}})}/>}
  </div>)}</div></fieldset>
}

function ActivityRecordingControl({locale,editable,configuration,localAudioAvailable,disabled,pending,reconcile,onEdit}:{locale:Locale;editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;disabled:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void}){
  const t=activityMessages[locale]
  const recordingOn=editable.recordingPolicy==='local_30d',legacy=editable.recordingEnabled===true
  const deactivating=configuration?.recordingPolicy==='local_30d'&&!recordingOn||configuration?.recordingEnabled===true&&!legacy
  return <div>{legacy&&<Button label={t.recordingCorrectLegacy} isDisabled={disabled} onClick={()=>onEdit({...editable,recordingEnabled:false})}/>}<CheckboxInput label={t.recordingEnabled} description={t.recordingHint} htmlName="recordingPolicy" value={recordingOn} onChange={value=>onEdit({...editable,recordingPolicy:value?'local_30d':'off'})} isDisabled={disabled||legacy||(!localAudioAvailable&&!recordingOn)} disabledMessage={!disabled&&!legacy&&!localAudioAvailable&&!recordingOn?t.recordingUnavailable:undefined} width="100%"/>{deactivating&&!pending&&!reconcile&&<p className="sparra-recording-note" role="status">{t.recordingDeactivation}</p>}</div>
}

type ActivitySection='establishment'|'knowledge'|'handling'|'recap'
const activitySections=['establishment','knowledge','handling','recap'] as const
function sectionForField(field:ActivityField):ActivitySection{
  if(field==='businessName')return 'establishment'
  return field==='transferDestination'||field==='recordingContactPhone'?'handling':'knowledge'
}
function useActivityValidation({locale,editable,disabled,saveBlocked,onSubmit,onInvalid}:{locale:Locale;editable:SaveActivityInput;disabled:boolean;saveBlocked:boolean;onSubmit():void;onInvalid(section:ActivitySection):void}){
  const t=activityMessages[locale]
  const [validated,setValidated]=useState(false)
  const [focusRequest,setFocusRequest]=useState<{field:ActivityField}|null>(null)
  const fields=useRef<Partial<Record<ActivityField,HTMLInputElement|HTMLTextAreaElement>>>({})
  useEffect(()=>{if(focusRequest)fields.current[focusRequest.field]?.focus()},[focusRequest])
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
    if(first){onInvalid(sectionForField(first));setFocusRequest({field:first});return}
    onSubmit()
  }
  return {issues,fieldRef,fieldStatus,submit}
}

function ActivitySaveSummary({locale,issues,pending,reconcile,editable,configuration}:{locale:Locale;issues:ActivityDraftIssues;pending:boolean;reconcile:boolean;editable:SaveActivityInput;configuration:ActivityConfigurationDto|null}){
  const t=activityMessages[locale]
  const draftStatus=configuration?(activityMatchesConfiguration(editable,configuration)?t.upToDate:t.unsaved):t.noSavedConfiguration
  return <div className="sparra-save-summary">{Object.keys(issues).length>0&&<p role="alert">{t.localInvalid}</p>}{!pending&&!reconcile&&<p className="sparra-draft-status" role="status">{draftStatus}</p>}<p className="sparra-form-hint">{t.saveHint}</p></div>
}

function ActivityEstablishmentFields({locale,editable,disabled,onEdit,fieldRef,fieldStatus}:{locale:Locale;editable:SaveActivityInput;disabled:boolean;onEdit(next:SaveActivityInput):void;fieldRef(field:ActivityField,element:HTMLInputElement|HTMLTextAreaElement|null):void;fieldStatus(field:ActivityField):ActivityFieldStatus}){
  const t=activityMessages[locale]
  return <fieldset className="sparra-form-section"><legend>{t.establishment}</legend><p className="sparra-form-hint">{t.requiredHint}</p><div className="sparra-field-pair">
    <TextInput ref={element=>fieldRef('businessName',element)} size="lg" label={t.businessName} description={t.businessNameHint} placeholder={editable.sector==='diagnostic-immobilier'?(locale==='fr'?'Établissement Martin':'Martin Business'):t.businessNamePlaceholder} value={editable.businessName} onChange={businessName=>onEdit({...editable,businessName})} htmlName="businessName" status={fieldStatus('businessName')} statusVariant="detached" isRequired isDisabled={disabled} width="100%"/>
    <Selector size="lg" label={t.sector} description={t.sectorHint} value={editable.sector} options={sectorIds.map(value=>({value,label:getSectorPreset(value,locale).label}))} onChange={value=>{const sector=sectorIds.find(sector=>sector===value);if(sector)onEdit({...editable,sector})}} isRequired isDisabled={disabled} width="100%"/>
  </div></fieldset>
}

function ActivityCallHandlingFields({locale,editable,configuration,localAudioAvailable,disabled,pending,reconcile,onEdit,fieldRef,fieldStatus}:{locale:Locale;editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;disabled:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void;fieldRef(field:ActivityField,element:HTMLInputElement|HTMLTextAreaElement|null):void;fieldStatus(field:ActivityField):ActivityFieldStatus}){
  const t=activityMessages[locale]
  return <fieldset className="sparra-form-section"><legend>{t.callHandling}</legend><div className="sparra-call-settings">
    <TextInput ref={element=>fieldRef('transferDestination',element)} size="lg" label={t.transferDestination} description={`${t.transferHint} ${t.transferFormat}`} placeholder={t.transferPlaceholder} htmlName="transferDestination" value={editable.transferDestination??''} onChange={value=>onEdit({...editable,transferDestination:value||null})} status={fieldStatus('transferDestination')} statusVariant="detached" isDisabled={disabled} width="100%"/>
    <ActivityRecordingControl locale={locale} editable={editable} configuration={configuration} localAudioAvailable={localAudioAvailable} disabled={disabled} pending={pending} reconcile={reconcile} onEdit={onEdit}/>
    {activityRecordingContactVisible(editable,configuration)&&<TextInput ref={element=>fieldRef('recordingContactPhone',element)} size="lg" label={t.recordingContactPhone} description={t.recordingContactHint} placeholder={t.recordingContactPlaceholder} htmlName="recordingContactPhone" value={editable.recordingContactPhone??''} onChange={value=>onEdit({...editable,recordingContactPhone:value||null})} status={fieldStatus('recordingContactPhone')} statusVariant="detached" isDisabled={disabled} width="100%"/>}
  </div></fieldset>
}

function ActivityRecap({locale,editable,calendarSlot}:{locale:Locale;editable:SaveActivityInput;calendarSlot?:ReactNode}){
  const t=activityMessages[locale]
  return <fieldset className="sparra-form-section"><legend>{t.recapTitle}</legend>
    <dl className="sparra-recap-details"><dt>{t.businessName}</dt><dd>{editable.businessName||'—'}</dd><dt>{t.sector}</dt><dd>{getSectorPreset(editable.sector,locale).label}</dd></dl>
    <p>{t.draftExplanation}</p><p>{t.lineValidation}</p>{calendarSlot&&<p>{t.independentCalendar}</p>}<p className="sparra-form-hint">{t.manualTest}</p>
  </fieldset>
}

function ActivityRecordingWarnings({locale,localAudioAvailable,legacy,audioBlocked,hydrated,activeSection,onReview}:{locale:Locale;localAudioAvailable:boolean;legacy:boolean;audioBlocked:boolean;hydrated:boolean;activeSection:ActivitySection;onReview():void}){
  if(localAudioAvailable&&!legacy)return null
  const t=activityMessages[locale]
  return <div className="sparra-save-blocker">
    {!localAudioAvailable&&<p className="sparra-recording-warning" role="alert">{t.recordingUnavailable}</p>}
    {legacy&&<p className="sparra-recording-warning" role="alert">{t.recordingLegacy}</p>}
    {audioBlocked&&activeSection!=='handling'&&<Button type="button" label={t.reviewCallSettings} isDisabled={!hydrated} onClick={onReview}/>}
  </div>
}

function ActivityEditor({knowledgeSlot,reviewToken,locale,editable,configuration,localAudioAvailable,hydrated,pending,reconcile,onEdit,onSubmit,calendarSlot,children,initialSection,externalNavigationPending,onPreparedAnswersChange}:{externalNavigationPending:boolean;onPreparedAnswersChange:(value:boolean)=>void;initialSection:ActivitySection;calendarSlot?:ReactNode;children:ReactNode;locale:Locale;editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;hydrated:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void;onSubmit():void;knowledgeSlot:ReactNode;reviewToken:unknown}){
  const t=activityMessages[locale],disabled=!hydrated||pending||externalNavigationPending
  const [activeSection,setActiveSection]=useState<ActivitySection>(initialSection)
  const [preview,setPreview]=useState<SaveActivityInput|null>(null),[attested,setAttested]=useState(false)
  const reviewHeading=useRef<HTMLHeadingElement>(null)
  useEffect(()=>{setPreview(null);setAttested(false)},[editable,reviewToken])
  useEffect(()=>{if(preview)reviewHeading.current?.focus()},[preview])
  function reviewOrSubmit(){if(preview&&attested){onSubmit();return}setPreview(normalizeActivityDraft(editable));setActiveSection('recap')}
  const audioBlocked=recordingSaveBlocked(editable,localAudioAvailable)
  const saveBlocked=activitySaveBlocked(editable,configuration,audioBlocked,reconcile)
  const {issues,fieldRef,fieldStatus,submit}=useActivityValidation({locale,editable,disabled,saveBlocked,onSubmit:reviewOrSubmit,onInvalid:setActiveSection})
  return <><form className="sparra-business-form" aria-label={t.title} aria-busy={pending} noValidate onSubmit={event=>{event.preventDefault();submit()}}>
    <nav className="sparra-guided-navigation" aria-label={t.guidedNavigation}>{activitySections.map((section,index)=><Button key={section} type="button" label={t.guidedSections[index]} aria-current={activeSection===section?'step':undefined} aria-controls={`activity-${section}`} isDisabled={!hydrated} onClick={()=>setActiveSection(section)}/>)}</nav>
    <div id="activity-establishment" data-activity-section="establishment" hidden={activeSection!=='establishment'}><ActivityEstablishmentFields locale={locale} editable={editable} disabled={disabled} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/></div>
    <div id="activity-knowledge" data-activity-section="knowledge" hidden={activeSection!=='knowledge'}>{knowledgeSlot}<ActivityKnowledgeFields onPreparedAnswersChange={onPreparedAnswersChange} locale={locale} editable={editable} disabled={disabled} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/></div>
    <div id="activity-handling" data-activity-section="handling" hidden={activeSection!=='handling'}><ActivityCallHandlingFields locale={locale} editable={editable} configuration={configuration} localAudioAvailable={localAudioAvailable} disabled={disabled} pending={pending} reconcile={reconcile} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/></div>
    <div id="activity-recap" data-activity-section="recap" hidden={activeSection!=='recap'}><ActivityRecap locale={locale} editable={editable} calendarSlot={calendarSlot}/>{preview&&<section aria-label={knowledgeMessages[locale].review}><h2 ref={reviewHeading} tabIndex={-1}>{knowledgeMessages[locale].review}</h2><p>{knowledgeMessages[locale].reviewHint}</p>{sections.map(([field])=><div key={field}><h3>{t[field]}</h3><p className="sparra-knowledge-preview" data-knowledge-preview={field}>{preview.knowledge[field]||knowledgeMessages[locale].unknown}</p></div>)}<p>{knowledgeMessages[locale].oldPrice}</p><CheckboxInput htmlName="knowledgeAttestation" label={knowledgeMessages[locale].attestation} value={attested} onChange={setAttested} isDisabled={disabled||reconcile} width="100%"/></section>}</div>
    <ActivityRecordingWarnings locale={locale} localAudioAvailable={localAudioAvailable} legacy={editable.recordingEnabled===true} audioBlocked={audioBlocked} hydrated={hydrated} activeSection={activeSection} onReview={()=>setActiveSection('handling')}/>
    <ActivitySaveSummary locale={locale} issues={issues} pending={pending} reconcile={reconcile} editable={editable} configuration={configuration}/>
    <Button className="sparra-form-submit" variant="primary" label={preview?knowledgeMessages[locale].confirmAction:knowledgeMessages[locale].reviewAction} type="submit" isDisabled={disabled||saveBlocked||(preview!==null&&!attested)} isLoading={pending}/>
  </form>
    {children}
    {calendarSlot&&<div className="sparra-guided-calendar" hidden={activeSection!=='handling'&&activeSection!=='recap'}><p className="sparra-form-hint">{t.calendarConnectionHint}</p>{calendarSlot}</div>}
  </>
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

function ActivityWorkspaceContent({knowledgeSlot,reviewToken,locale,workspace,configuration,localAudioAvailable,editable,hydrated,pending,reconcile,onEdit,onEnsure,onSave,calendarSlot,children,initialSection,externalNavigationPending,onPreparedAnswersChange}:{externalNavigationPending:boolean;onPreparedAnswersChange:(value:boolean)=>void;initialSection:ActivitySection;calendarSlot?:ReactNode;locale:Locale;workspace:WorkspaceDto|null;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean;editable:SaveActivityInput;hydrated:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void;onEnsure():void;onSave():void;children:ReactNode;knowledgeSlot:ReactNode;reviewToken:unknown}){
  const a=appMessages[locale]
  const feedback=<>{children}{configuration&&<p className="sparra-version-note">{a.version}: {configuration.revision}</p>}</>
  if(!workspace)return <><p>{a.createHint}</p><Button label={a.create} isDisabled={!hydrated||externalNavigationPending} isLoading={pending} onClick={onEnsure}/>{feedback}</>
  return <ActivityEditor knowledgeSlot={knowledgeSlot} reviewToken={reviewToken} externalNavigationPending={externalNavigationPending} onPreparedAnswersChange={onPreparedAnswersChange} locale={locale} editable={editable} configuration={configuration} localAudioAvailable={localAudioAvailable} hydrated={hydrated} pending={pending} reconcile={reconcile} onEdit={onEdit} onSubmit={onSave} calendarSlot={calendarSlot} initialSection={initialSection}>{feedback}</ActivityEditor>
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

export function normalizeActivityDraft(value:SaveActivityInput):ConfirmActivityInput['activity']{
  return {...value,businessName:value.businessName.trim(),knowledge:{openingHours:value.knowledge.openingHours.replace(/\r\n/g,'\n'),services:value.knowledge.services.replace(/\r\n/g,'\n'),prices:value.knowledge.prices.replace(/\r\n/g,'\n'),faq:value.knowledge.faq.replace(/\r\n/g,'\n'),instructions:value.knowledge.instructions.replace(/\r\n/g,'\n')},transferDestination:value.transferDestination??null,recordingEnabled:value.recordingEnabled??false,recordingPolicy:value.recordingPolicy??'off',recordingContactPhone:value.recordingContactPhone??null}
}
function useActivityEditorLifecycle({locale,state,onEnsure,onConfirm,onLookup,onRead,onRefused,onNavigationStateChange,externalNavigationPending}:Pick<Props,'locale'|'state'|'onEnsure'|'onConfirm'|'onLookup'|'onRead'|'onRefused'|'onNavigationStateChange'>&{externalNavigationPending:boolean}){
  const hydrated=useHydrated()
  const [current,setCurrent]=useState(state),[editable,setEditable]=useState(()=>draft(state.configuration)),[pendingMode,setPendingMode]=useState<ActivityOperation|null>(null)
  const {saved,setSaved,conflict,setConflict,uncertain,setUncertain,latest,setLatest,error,setError,showError}=useActivitySaveFeedback(locale,()=>setCurrent(previous=>({...previous,localAudioAvailable:false})))
  const [preparation,setPreparation]=useState<KnowledgePreparation>({capture:null,decisions:[]}),[capturePending,setCapturePending]=useState(false)
  const [receipt,setReceipt]=useState<ActivityConfirmationLookup|null>(null)
  const submitted=useRef<ConfirmActivityInput|null>(null),identity=useRef<{draftId:string;draftVersion:number}|null>(null)
  const [hasPreparedAnswers,setHasPreparedAnswers]=useState(false)
  const reconcile=conflict||uncertain
  const dirty=hasPreparedAnswers||preparation.capture!==null||JSON.stringify(editable)!==JSON.stringify(draft(current.configuration))
  useEffect(()=>{onNavigationStateChange?.({dirty,pending:pendingMode!==null||capturePending,reconcile})},[dirty,pendingMode,capturePending,reconcile,onNavigationStateChange])
  const audioBlocked=recordingSaveBlocked(editable,current.localAudioAvailable)
  const attempt=useRef(0),controller=useRef<AbortController|null>(null)
  const [refused,setRefused]=useState(false)
  useEffect(()=>()=>{attempt.current++;controller.current?.abort()},[])
  async function refuse(){setRefused(true);await onRefused()}
  function changed(){if(identity.current)identity.current={...identity.current,draftVersion:identity.current.draftVersion+1};setSaved(false)}
  function edit(next:SaveActivityInput){if(externalNavigationPending||pendingMode!==null)return;setEditable(next);changed()}
  function prepare(next:KnowledgePreparation){setPreparation(next);changed()}
  function replaceDraft(read:ActivityState){setEditable(draft(read.configuration));setCurrent(read);setPreparation({capture:null,decisions:[]});identity.current=null;submitted.current=null;setReceipt(null);setConflict(false);setUncertain(false);setError('');setLatest(null);setSaved(false)}
  async function ensureWorkspace(signal:AbortSignal,live:()=>boolean){
    await privateResult(onEnsure(signal))
    const read=await privateResult(onRead(signal))
    if(live()){setCurrent(read);setEditable(draft(read.configuration))}
  }
  async function readLatest(signal:AbortSignal,live:()=>boolean){
    if(submitted.current){
      const result=await privateResult(onLookup({draftId:submitted.current.draftId,draftVersion:submitted.current.draftVersion},signal))
      if(!live())return
      setReceipt(result)
    }
    // A historical receipt never establishes the current head.
    const read=await privateResult(onRead(signal))
    if(live())setLatest(read)
  }
  async function saveDraft(signal:AbortSignal,live:()=>boolean){
    identity.current??={draftId:globalThis.crypto.randomUUID(),draftVersion:1}
    const submission:ConfirmActivityInput={...identity.current,activity:normalizeActivityDraft(editable),...(preparation.capture?{captureId:preparation.capture.captureId}:{}),decisions:preparation.decisions.map(decision=>({...decision})),confirmed:true}
    submitted.current=submission
    const result=await privateResult(onConfirm(submission,signal))
    if(!live())return
    setReceipt(result)
    const read=await privateResult(onRead(signal))
    if(!live())return
    if(read.configuration?.revision!==result.revision){setLatest(read);setUncertain(true);return}
    setCurrent(read);setEditable(draft(read.configuration));setPreparation({capture:null,decisions:[]});setSaved(true);setConflict(false);setUncertain(false);setLatest(null);submitted.current=null;identity.current=null
  }
  async function interpretFailure(mode:ActivityOperation,failure:unknown){
    if(failure instanceof Response&&failure.headers.get('x-sparra-knowledge-error')==='KnowledgeCaptureUnavailable'){setError(knowledgeMessages[locale].invalidCapture);return}
    const outcome=classifyActivityFailure(mode,failure)
    if(outcome.kind==='refused'){await refuse();return}
    if(outcome.kind==='uncertain'){setUncertain(true);setLatest(null);return}
    showError(outcome.reason)
  }
  async function performOperation(mode:ActivityOperation,signal:AbortSignal,live:()=>boolean){
    if(mode==='ensure')return ensureWorkspace(signal,live)
    if(mode==='latest')return readLatest(signal,live)
    return saveDraft(signal,live)
  }
  async function persist(mode:ActivityOperation){
    if(externalNavigationPending||pendingMode!==null||capturePending)return
    if(mode==='save'&&activitySaveBlocked(editable,current.configuration,audioBlocked,reconcile))return
    controller.current?.abort();const owned=new AbortController(),id=++attempt.current;controller.current=owned
    const live=()=>!owned.signal.aborted&&attempt.current===id
    setPendingMode(mode);setSaved(false);if(mode!=='latest')setError('');if(mode==='save')setReceipt(null)
    await performOperation(mode,owned.signal,live)
      .catch(async failure=>{if(live())await interpretFailure(mode,failure)})
      .finally(()=>{if(live())setPendingMode(null)})
  }
  function cancel(){
    attempt.current++;controller.current?.abort()
    if(pendingMode==='save'){setUncertain(true);setLatest(null)}
    setPendingMode(null)
  }
  return {hydrated,current,editable,pendingMode,saved,uncertain,latest,error,reconcile,refused,setHasPreparedAnswers,edit,replaceDraft,persist,cancel,preparation,prepare,capturePending,setCapturePending,receipt,refuse}
}

export function ActivityPanel({locale,state,onEnsure,onConfirm,onLookup,onImport,onRead,onRefused,calendarSlot,initialSection='establishment',onNavigationStateChange,externalNavigationPending=false}:Props){
  const a=appMessages[locale],k=knowledgeMessages[locale]
  const {hydrated,current,editable,pendingMode,saved,uncertain,latest,error,reconcile,refused,setHasPreparedAnswers,edit,replaceDraft,persist,cancel,preparation,prepare,capturePending,setCapturePending,receipt,refuse}=useActivityEditorLifecycle({locale,state,onEnsure,onConfirm,onLookup,onRead,onRefused,onNavigationStateChange,externalNavigationPending})
  if(refused)return <PrivateUnavailable locale={locale} title={a.business}/>
  return <><div className="sparra-page-heading"><Heading level={1}>{a.business}</Heading><p>{activityMessages[locale].description}</p></div>
    <ActivityWorkspaceContent knowledgeSlot={<KnowledgeImportPanel locale={locale} editable={editable} disabled={!hydrated||pendingMode!==null||externalNavigationPending||reconcile} value={preparation} onChange={prepare} onEdit={edit} onImport={onImport} onPendingChange={setCapturePending} onRefused={refuse}/>} reviewToken={preparation} externalNavigationPending={externalNavigationPending||capturePending} onPreparedAnswersChange={setHasPreparedAnswers} locale={locale} workspace={current.workspace} configuration={current.configuration} localAudioAvailable={current.localAudioAvailable} editable={editable} hydrated={hydrated} pending={pendingMode!==null} reconcile={reconcile} onEdit={edit} onEnsure={()=>void persist('ensure')} onSave={()=>void persist('save')} calendarSlot={calendarSlot} initialSection={initialSection}>
      <ActivityPendingFeedback locale={locale} mode={pendingMode} onCancel={cancel}/>
      <ActivityOutcomeFeedback locale={locale} uncertain={uncertain&&receipt?.status!=='confirmed'} error={error} saved={saved}/>
      {reconcile&&receipt&&<p role="status">{receipt.status==='confirmed'?`${k.historical} ${receipt.revision} (${receipt.savedAt}).`:k.unverifiable}</p>}
      <ActivityReconciliation locale={locale} editable={editable} pending={pendingMode!==null||externalNavigationPending} reconcile={reconcile} latest={latest} onCheckLatest={()=>void persist('latest')} onReplaceLatest={replaceDraft}/>
      <KnowledgeOrigin state={current} locale={locale}/>
    </ActivityWorkspaceContent>
  </>
}
