import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
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
import { useRequestAttempt } from './use-request-attempt'
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
      case 409:return failure.headers.get('x-sparra-activity-error')==='workspace-changed'?{kind:'refused'}:{kind:'error',reason:mode==='save'&&failure.headers.get('x-sparra-activity-error')==='recording-unavailable'?'recordingUnavailable':'conflict'}
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

function ActivityPreviewSettings({locale,preview}:{locale:Locale;preview:ConfirmActivityInput['activity']}){
  const t=activityMessages[locale]
  return <dl className="sparra-recap-details"><dt>{t.businessName}</dt><dd>{preview.businessName}</dd><dt>{t.sector}</dt><dd>{getSectorPreset(preview.sector,locale).label}</dd>
    <dt>{t.transferDestination}</dt><dd>{preview.transferDestination||'—'}</dd><dt>{t.recordingEnabled}</dt><dd>{preview.recordingPolicy==='local_30d'?(locale==='fr'?'Conservation locale pendant 30 jours':'Local retention for 30 days'):(locale==='fr'?'Désactivé':'Off')}</dd><dt>{t.recordingContactPhone}</dt><dd>{preview.recordingContactPhone||'—'}</dd></dl>
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

function ActivityConfirmationReview({locale,preview,attested,disabled,onAttest,heading}:{locale:Locale;preview:ConfirmActivityInput['activity']|null;attested:boolean;disabled:boolean;onAttest(value:boolean):void;heading:RefObject<HTMLHeadingElement|null>}){
  if(!preview)return null
  const t=activityMessages[locale],k=knowledgeMessages[locale]
  return <section aria-label={k.review}><h2 ref={heading} tabIndex={-1}>{k.review}</h2><p>{k.reviewHint}</p>{sections.map(([field])=><div key={field}><h3>{t[field]}</h3><p className="sparra-knowledge-preview" data-knowledge-preview={field}>{preview.knowledge[field]||k.unknown}</p></div>)}<ActivityPreviewSettings locale={locale} preview={preview}/><p>{k.oldPrice}</p><CheckboxInput htmlName="knowledgeAttestation" label={k.attestation} value={attested} onChange={onAttest} isDisabled={disabled} width="100%"/></section>
}
function ActivityGuidedCalendar({locale,calendarSlot,activeSection}:{locale:Locale;calendarSlot?:ReactNode;activeSection:ActivitySection}){
  if(!calendarSlot)return null
  const visible=activeSection==='handling'||activeSection==='recap'
  return <div className="sparra-guided-calendar" hidden={!visible}><p className="sparra-form-hint">{activityMessages[locale].calendarConnectionHint}</p>{calendarSlot}</div>
}

type ActivityEditorProps={
  locale:Locale;activity:{editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;localAudioAvailable:boolean}
  availability:{hydrated:boolean;pending:boolean;reconcile:boolean;externalNavigationPending:boolean}
  actions:{onEdit(next:SaveActivityInput):void;onSubmit():void;onPreparedAnswersChange(value:boolean):void}
  knowledge:{content:ReactNode;reviewToken:unknown};calendarSlot?:ReactNode;children:ReactNode;initialSection:ActivitySection
}
function ActivityEditor({locale,activity,availability,actions,knowledge,calendarSlot,children,initialSection}:ActivityEditorProps){
  const {editable,configuration,localAudioAvailable}=activity,{hydrated,pending,reconcile,externalNavigationPending}=availability
  const {onEdit,onSubmit,onPreparedAnswersChange}=actions,{content:knowledgeSlot,reviewToken}=knowledge
  const t=activityMessages[locale],disabled=!hydrated||pending||externalNavigationPending
  const [activeSection,setActiveSection]=useState<ActivitySection>(initialSection)
  const [review,setReview]=useState<{preview:ConfirmActivityInput['activity']|null;attested:boolean}>({preview:null,attested:false})
  const {preview,attested}=review
  const reviewHeading=useRef<HTMLHeadingElement>(null)
  useEffect(()=>{setReview({preview:null,attested:false})},[editable,reviewToken])
  useEffect(()=>{if(preview)reviewHeading.current?.focus()},[preview])
  function reviewOrSubmit(){if(preview&&attested){onSubmit();return}setReview({preview:normalizeActivityDraft(editable),attested:false});setActiveSection('recap')}
  const audioBlocked=recordingSaveBlocked(editable,localAudioAvailable)
  const saveBlocked=activitySaveBlocked(editable,configuration,audioBlocked,reconcile)
  const {issues,fieldRef,fieldStatus,submit}=useActivityValidation({locale,editable,disabled,saveBlocked,onSubmit:reviewOrSubmit,onInvalid:setActiveSection})
  return <><form className="sparra-business-form" aria-label={t.title} aria-busy={pending} noValidate onSubmit={event=>{event.preventDefault();submit()}}>
    <nav className="sparra-guided-navigation" aria-label={t.guidedNavigation}>{activitySections.map((section,index)=><Button key={section} type="button" label={t.guidedSections[index]} aria-current={activeSection===section?'step':undefined} aria-controls={`activity-${section}`} isDisabled={!hydrated} onClick={()=>setActiveSection(section)}/>)}</nav>
    <div id="activity-establishment" data-activity-section="establishment" hidden={activeSection!=='establishment'}><ActivityEstablishmentFields locale={locale} editable={editable} disabled={disabled} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/></div>
    <div id="activity-knowledge" data-activity-section="knowledge" hidden={activeSection!=='knowledge'}>{knowledgeSlot}<ActivityKnowledgeFields onPreparedAnswersChange={onPreparedAnswersChange} locale={locale} editable={editable} disabled={disabled} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/></div>
    <div id="activity-handling" data-activity-section="handling" hidden={activeSection!=='handling'}><ActivityCallHandlingFields locale={locale} editable={editable} configuration={configuration} localAudioAvailable={localAudioAvailable} disabled={disabled} pending={pending} reconcile={reconcile} onEdit={onEdit} fieldRef={fieldRef} fieldStatus={fieldStatus}/></div>
    <div id="activity-recap" data-activity-section="recap" hidden={activeSection!=='recap'}><ActivityRecap locale={locale} editable={editable} calendarSlot={calendarSlot}/><ActivityConfirmationReview locale={locale} preview={preview} attested={attested} disabled={disabled||reconcile} onAttest={attested=>setReview(value=>({...value,attested}))} heading={reviewHeading}/></div>
    <ActivityRecordingWarnings locale={locale} localAudioAvailable={localAudioAvailable} legacy={editable.recordingEnabled===true} audioBlocked={audioBlocked} hydrated={hydrated} activeSection={activeSection} onReview={()=>setActiveSection('handling')}/>
    <ActivitySaveSummary locale={locale} issues={issues} pending={pending} reconcile={reconcile} editable={editable} configuration={configuration}/>
    <Button className="sparra-form-submit" variant="primary" label={preview?knowledgeMessages[locale].confirmAction:knowledgeMessages[locale].reviewAction} type="submit" isDisabled={disabled||saveBlocked||(preview!==null&&!attested)} isLoading={pending}/>
  </form>
    {children}
    <ActivityGuidedCalendar locale={locale} calendarSlot={calendarSlot} activeSection={activeSection}/>
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

function ActivityWorkspaceContent({workspace,onEnsure,editor}:{workspace:WorkspaceDto|null;onEnsure():void;editor:ActivityEditorProps}){
  const a=appMessages[editor.locale]
  const feedback=<>{editor.children}{editor.activity.configuration&&<p className="sparra-version-note">{a.version}: {editor.activity.configuration.revision}</p>}</>
  if(!workspace)return <><p>{a.createHint}</p><Button label={a.create} isDisabled={!editor.availability.hydrated||editor.availability.externalNavigationPending} isLoading={editor.availability.pending} onClick={onEnsure}/>{feedback}</>
  return <ActivityEditor {...editor}>{feedback}</ActivityEditor>
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

function normalizeActivityDraft(value:SaveActivityInput):ConfirmActivityInput['activity']{
  return {...value,businessName:value.businessName.trim(),knowledge:{openingHours:value.knowledge.openingHours.replace(/\r\n/g,'\n'),services:value.knowledge.services.replace(/\r\n/g,'\n'),prices:value.knowledge.prices.replace(/\r\n/g,'\n'),faq:value.knowledge.faq.replace(/\r\n/g,'\n'),instructions:value.knowledge.instructions.replace(/\r\n/g,'\n')},transferDestination:value.transferDestination??null,recordingEnabled:value.recordingEnabled??false,recordingPolicy:value.recordingPolicy??'off',recordingContactPhone:value.recordingContactPhone??null}
}
function activityStateInWorkspace(read:ActivityState,expected:string|undefined){return expected!==undefined&&read.workspace?.id===expected&&(read.configuration===null||read.configuration.workspaceId===expected)}
function useActivityNavigationStatus({editable,configuration,preparation,hasPreparedAnswers,pendingMode,capturePending,reconcile,onNavigationStateChange}:{editable:SaveActivityInput;configuration:ActivityConfigurationDto|null;preparation:KnowledgePreparation;hasPreparedAnswers:boolean;pendingMode:ActivityOperation|null;capturePending:boolean;reconcile:boolean;onNavigationStateChange?:Props['onNavigationStateChange']}){
  const dirty=hasPreparedAnswers||preparation.capture!==null||JSON.stringify(editable)!==JSON.stringify(draft(configuration))
  useEffect(()=>{onNavigationStateChange?.({dirty,pending:pendingMode!==null||capturePending,reconcile})},[dirty,pendingMode,capturePending,reconcile,onNavigationStateChange])
}
function activityConfirmationMatchesCurrent(submission:ConfirmActivityInput,receipt:ActivityConfirmationDto,current:ActivityConfigurationDto|null){
  return receipt.revision===submission.activity.expectedRevision+1&&current?.revision===receipt.revision&&current.savedAt===receipt.savedAt&&activityMatchesConfiguration(submission.activity,current)
}
function useActivityEditorLifecycle({locale,state,onEnsure,onConfirm,onLookup,onRead,onRefused,onNavigationStateChange,externalNavigationPending}:Pick<Props,'locale'|'state'|'onEnsure'|'onConfirm'|'onLookup'|'onRead'|'onRefused'|'onNavigationStateChange'>&{externalNavigationPending:boolean}){
  const hydrated=useHydrated()
  const [configurationState,setConfigurationState]=useState(()=>({current:state,editable:draft(state.configuration)}))
  const {current,editable}=configurationState
  const [operation,setOperation]=useState<{mode:ActivityOperation|null;receipt:ActivityConfirmationLookup|null}>({mode:null,receipt:null})
  const {mode:pendingMode,receipt}=operation
  const {saved,setSaved,conflict,setConflict,uncertain,setUncertain,latest,setLatest,error,setError,showError}=useActivitySaveFeedback(locale,()=>setConfigurationState(previous=>({...previous,current:{...previous.current,localAudioAvailable:false}})))
  const [preparation,setPreparation]=useState<KnowledgePreparation>({capture:null,decisions:[]}),[capturePending,setCapturePending]=useState(false)
  const submitted=useRef<ConfirmActivityInput|null>(null),identity=useRef<{draftId:string;draftVersion:number}|null>(null)
  const [hasPreparedAnswers,setHasPreparedAnswers]=useState(false)
  const reconcile=conflict||uncertain
  useActivityNavigationStatus({editable,configuration:current.configuration,preparation,hasPreparedAnswers,pendingMode,capturePending,reconcile,onNavigationStateChange})
  const audioBlocked=recordingSaveBlocked(editable,current.localAudioAvailable)
  const begin=useRequestAttempt()
  const [refused,setRefused]=useState(false)
  async function refuse(){setRefused(true);await onRefused()}
  function changed(){if(identity.current)identity.current={...identity.current,draftVersion:identity.current.draftVersion+1};setSaved(false)}
  function edit(next:SaveActivityInput){if(externalNavigationPending||pendingMode!==null)return;setConfigurationState(value=>({...value,editable:next}));changed()}
  function prepare(next:KnowledgePreparation){setPreparation(next);changed()}
  function replaceDraft(read:ActivityState){if(!activityStateInWorkspace(read,current.workspace?.id)){void refuse();return}setConfigurationState({current:read,editable:draft(read.configuration)});setPreparation({capture:null,decisions:[]});identity.current=null;submitted.current=null;setOperation(value=>({...value,receipt:null}));setConflict(false);setUncertain(false);setError('');setLatest(null);setSaved(false)}
  async function ensureWorkspace(signal:AbortSignal,live:()=>boolean){
    const workspace=await privateResult(onEnsure(signal))
    const read=await privateResult(onRead(signal))
    if(!live())return
    if(!activityStateInWorkspace(read,workspace.id)){await refuse();return}
    setConfigurationState({current:read,editable:draft(read.configuration)})
  }
  async function readLatest(signal:AbortSignal,live:()=>boolean){
    if(submitted.current){
      const result=await privateResult(onLookup({draftId:submitted.current.draftId,draftVersion:submitted.current.draftVersion,expectedWorkspaceId:submitted.current.expectedWorkspaceId},signal))
      if(!live())return
      setOperation(value=>({...value,receipt:result}))
    }
    // A historical receipt never establishes the current head.
    const read=await privateResult(onRead(signal))
    if(!live())return
    if(!activityStateInWorkspace(read,submitted.current?.expectedWorkspaceId??current.workspace?.id)){await refuse();return}
    setLatest(read)
  }
  async function saveDraft(signal:AbortSignal,live:()=>boolean){
    if(!current.workspace)throw new Error('Activity workspace unavailable')
    identity.current??={draftId:globalThis.crypto.randomUUID(),draftVersion:1}
    const submission:ConfirmActivityInput={...identity.current,expectedWorkspaceId:current.workspace.id,activity:normalizeActivityDraft({...editable,expectedWorkspaceId:current.workspace.id}),...(preparation.capture?{captureId:preparation.capture.captureId}:{}),decisions:preparation.decisions.map(decision=>({...decision})),confirmed:true}
    submitted.current=submission
    const result=await privateResult(onConfirm(submission,signal))
    if(!live())return
    setOperation(value=>({...value,receipt:result}))
    const read=await privateResult(onRead(signal))
    if(!live())return
    if(!activityStateInWorkspace(read,submission.expectedWorkspaceId)){await refuse();return}
    if(!activityConfirmationMatchesCurrent(submission,result,read.configuration)){setLatest(read);setUncertain(true);return}
    setConfigurationState({current:read,editable:draft(read.configuration)});setPreparation({capture:null,decisions:[]});setSaved(true);setConflict(false);setUncertain(false);setLatest(null);submitted.current=null;identity.current=null
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
    const {signal,live}=begin()
    setOperation(value=>({mode,receipt:mode==='save'?null:value.receipt}));setSaved(false);if(mode!=='latest')setError('')
    await performOperation(mode,signal,live)
      .catch(async failure=>{if(live())await interpretFailure(mode,failure)})
      .finally(()=>{if(live())setOperation(value=>({...value,mode:null}))})
  }
  function cancel(){
    begin()
    if(pendingMode==='save'){setUncertain(true);setLatest(null)}
    setOperation(value=>({...value,mode:null}))
  }
  return {hydrated,current,editable,pendingMode,saved,uncertain,latest,error,reconcile,refused,setHasPreparedAnswers,edit,replaceDraft,persist,cancel,preparation,prepare,capturePending,setCapturePending,receipt,refuse}
}

type ActivityModel=ReturnType<typeof useActivityEditorLifecycle>
function ActivityReceiptFeedback({locale,reconcile,receipt}:{locale:Locale;reconcile:boolean;receipt:ActivityConfirmationLookup|null}){
  if(!reconcile||!receipt)return null
  const k=knowledgeMessages[locale]
  return <p role="status">{receipt.status==='confirmed'?k.historical+' '+receipt.revision+' ('+receipt.savedAt+').':k.unverifiable}</p>
}
function ActivityFeedback({locale,model,externalNavigationPending}:{locale:Locale;model:ActivityModel;externalNavigationPending:boolean}){
  return <><ActivityPendingFeedback locale={locale} mode={model.pendingMode} onCancel={model.cancel}/><ActivityOutcomeFeedback locale={locale} uncertain={model.uncertain&&model.receipt?.status!=='confirmed'} error={model.error} saved={model.saved}/><ActivityReceiptFeedback locale={locale} reconcile={model.reconcile} receipt={model.receipt}/><ActivityReconciliation locale={locale} editable={model.editable} pending={model.pendingMode!==null||externalNavigationPending} reconcile={model.reconcile} latest={model.latest} onCheckLatest={()=>void model.persist('latest')} onReplaceLatest={model.replaceDraft}/><KnowledgeOrigin state={model.current} locale={locale}/></>
}
export function ActivityPanel({locale,state,onEnsure,onConfirm,onLookup,onImport,onRead,onRefused,calendarSlot,initialSection='establishment',onNavigationStateChange,externalNavigationPending=false}:Props){
  const a=appMessages[locale],model=useActivityEditorLifecycle({locale,state,onEnsure,onConfirm,onLookup,onRead,onRefused,onNavigationStateChange,externalNavigationPending})
  const pending=model.pendingMode!==null,importDisabled=!model.hydrated||pending||externalNavigationPending||model.reconcile
  if(model.refused)return <PrivateUnavailable locale={locale} title={a.business}/>
  const editor:ActivityEditorProps={
    locale,activity:{editable:model.editable,configuration:model.current.configuration,localAudioAvailable:model.current.localAudioAvailable},
    availability:{hydrated:model.hydrated,pending,reconcile:model.reconcile,externalNavigationPending:externalNavigationPending||model.capturePending},
    actions:{onEdit:model.edit,onSubmit:()=>void model.persist('save'),onPreparedAnswersChange:model.setHasPreparedAnswers},
    knowledge:{content:<KnowledgeImportPanel locale={locale} editable={model.editable} disabled={importDisabled} value={model.preparation} onChange={model.prepare} onEdit={model.edit} onImport={onImport} onPendingChange={model.setCapturePending} onRefused={model.refuse}/>,reviewToken:model.preparation},
    calendarSlot,initialSection,children:<ActivityFeedback locale={locale} model={model} externalNavigationPending={externalNavigationPending}/>
  }
  return <><div className="sparra-page-heading"><Heading level={1}>{a.business}</Heading><p>{activityMessages[locale].description}</p></div><ActivityWorkspaceContent workspace={model.current.workspace} onEnsure={()=>void model.persist('ensure')} editor={editor}/></>
}
