import { useEffect, useRef, useState } from 'react'
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
const sections=[['openingHours',1000],['services',2000],['prices',1500],['faq',3000],['instructions',2000]] as const
function draft(configuration:ActivityConfigurationDto|null):SaveActivityInput{return configuration?{businessName:configuration.businessName,sector:configuration.sector,knowledge:{...configuration.knowledge},transferDestination:configuration.transferDestination,recordingEnabled:configuration.recordingEnabled??false,expectedRevision:configuration.revision}:{businessName:'',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:false,expectedRevision:0}}

function ActivityEditor({locale,editable,hydrated,pending,reconcile,onEdit,onSubmit}:{locale:Locale;editable:SaveActivityInput;hydrated:boolean;pending:boolean;reconcile:boolean;onEdit(next:SaveActivityInput):void;onSubmit():void}){
  const t=activityMessages[locale]
  return <form className="sparra-business-form" aria-busy={pending} onSubmit={event=>{event.preventDefault();if(!pending&&!reconcile)onSubmit()}}>
    <TextInput label={t.businessName} value={editable.businessName} onChange={businessName=>onEdit({...editable,businessName})} htmlName="businessName" isRequired isDisabled={!hydrated||pending} width="100%"/>
    <Selector label={t.sector} value={editable.sector} options={[{value:'garage',label:t.garage},{value:'controle-technique',label:t.controleTechnique}]} onChange={sector=>{if(sector==='garage'||sector==='controle-technique')onEdit({...editable,sector})}} isDisabled={!hydrated||pending} width="100%"/>
    {sections.map(([field,limit])=><TextArea key={field} label={t[field]} description={`${limit} ${locale==='fr'?'caractères maximum':'characters maximum'}`} htmlName={field} value={editable.knowledge[field]} onChange={value=>onEdit({...editable,knowledge:{...editable.knowledge,[field]:value}})} rows={4} isDisabled={!hydrated||pending} width="100%"/>)}
    <TextInput label={t.transferDestination} description={t.transferHint} htmlName="transferDestination" value={editable.transferDestination??''} onChange={value=>onEdit({...editable,transferDestination:value||null})} isDisabled={!hydrated||pending} width="100%"/>
    <CheckboxInput label={t.recordingEnabled} description={t.recordingHint} htmlName="recordingEnabled" value={editable.recordingEnabled??false} onChange={recordingEnabled=>onEdit({...editable,recordingEnabled})} isDisabled={!hydrated||pending} width="100%"/>
    <Button label={t.save} type="submit" isDisabled={!hydrated||reconcile} isLoading={pending}/>
  </form>
}

function ActivityReconciliation({locale,pending,latest,onCheckLatest,onReplaceLatest}:{locale:Locale;pending:boolean;latest:ActivityState|null;onCheckLatest():void;onReplaceLatest(state:ActivityState):void}){
  const t=activityMessages[locale],a=appMessages[locale]
  return <div className="sparra-conflict"><Button label={a.checkLatest} isDisabled={pending} onClick={onCheckLatest}/>{latest&&<><p role="status">{latest.configuration?`${a.latest}: ${latest.configuration.revision}`:t.noSavedConfiguration}</p><Button label={a.loadLatest} isDisabled={pending} onClick={()=>onReplaceLatest(latest)}/></>}</div>
}

export function ActivityPanel({locale,state,onEnsure,onSave,onRead,onRefused}:Props){
  const t=activityMessages[locale],a=appMessages[locale],hydrated=useHydrated()
  const [current,setCurrent]=useState(state),[editable,setEditable]=useState(()=>draft(state.configuration)),[pendingMode,setPendingMode]=useState<'ensure'|'save'|'latest'|null>(null),[saved,setSaved]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[uncertain,setUncertain]=useState(false),[latest,setLatest]=useState<ActivityState|null>(null)
  const pending=pendingMode!==null,reconcile=conflict||uncertain
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
  async function interpretFailure(mode:'ensure'|'save'|'latest',failure:unknown){
    if(failure instanceof Response&&failure.status===401){setRefused(true);await onRefused();return}
    if(failure instanceof Response&&failure.status===409){setConflict(true);setError(t.conflict)}
    else if(failure instanceof Response&&failure.status===400)setError(t.invalid)
    else if(mode==='save'){setUncertain(true);setLatest(null)}
    else setError(t.unavailable)
  }
  async function persist(mode:'ensure'|'save'|'latest'){
    controller.current?.abort();const owned=new AbortController(),id=++attempt.current;controller.current=owned
    const live=()=>!owned.signal.aborted&&attempt.current===id
    setPendingMode(mode);setSaved(false);setError('')
    try{
      if(mode==='ensure')await ensureWorkspace(owned.signal,live)
      else if(mode==='latest')await readLatest(owned.signal,live)
      else await saveDraft(owned.signal,live)
    }catch(failure){if(live())await interpretFailure(mode,failure)}finally{if(live())setPendingMode(null)}
  }
  if(refused)return <PrivateUnavailable locale={locale}/>
  return <><Heading level={1}>{a.business}</Heading>{current.configuration&&<p>{a.version}: {current.configuration.revision}</p>}
    {!current.workspace?<><p>{a.createHint}</p><Button label={a.create} isDisabled={!hydrated} isLoading={pending} onClick={()=>void persist('ensure')}/></>:<ActivityEditor locale={locale} editable={editable} hydrated={hydrated} pending={pending} reconcile={reconcile} onEdit={edit} onSubmit={()=>void persist('save')}/>}
    {pending&&<><p role="status">{t.saving}</p><Button label={a.cancel} onClick={()=>{attempt.current++;controller.current?.abort();if(pendingMode==='save'){setUncertain(true);setLatest(null)}setPendingMode(null)}}/></>}{uncertain&&<p role="alert">{t.outcomeUnknown}</p>}{error&&<p role="alert">{error}</p>}{saved&&<p role="status">{t.saved}</p>}
    {reconcile&&<ActivityReconciliation locale={locale} pending={pending} latest={latest} onCheckLatest={()=>void persist('latest')} onReplaceLatest={replaceDraft}/>}
  </>
}
