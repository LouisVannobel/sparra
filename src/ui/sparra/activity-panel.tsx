import { useEffect, useRef, useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextInput } from '@astryxdesign/core/TextInput'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Selector } from '@astryxdesign/core/Selector'
import type { ActivityConfigurationDto, ActivityState, SaveActivityInput } from '../../modules/sparra/sparra.functions'
import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import { activityMessages, appMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { privateResult, PrivateUnavailable } from './app-shell'

type Props={locale:Locale;state:ActivityState;onEnsure(signal:AbortSignal):Promise<WorkspaceDto|Response>;onSave(data:SaveActivityInput,signal:AbortSignal):Promise<ActivityConfigurationDto|Response>;onRead(signal:AbortSignal):Promise<ActivityState|Response>;onRefused():Promise<void>}
const sections=[['openingHours',1000],['services',2000],['prices',1500],['faq',3000],['instructions',2000]] as const
function draft(configuration:ActivityConfigurationDto|null):SaveActivityInput{return configuration?{businessName:configuration.businessName,sector:configuration.sector,knowledge:{...configuration.knowledge},transferDestination:configuration.transferDestination,expectedRevision:configuration.revision}:{businessName:'',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,expectedRevision:0}}
export function ActivityPanel({locale,state,onEnsure,onSave,onRead,onRefused}:Props){
  const t=activityMessages[locale],a=appMessages[locale],hydrated=useHydrated()
  const [current,setCurrent]=useState(state),[editable,setEditable]=useState(()=>draft(state.configuration)),[pending,setPending]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[latest,setLatest]=useState<ActivityConfigurationDto|null>(null)
  const attempt=useRef(0),controller=useRef<AbortController|null>(null)
  const [refused,setRefused]=useState(false)
  useEffect(()=>()=>{attempt.current++;controller.current?.abort()},[])
  async function persist(mode:'ensure'|'save'|'latest'){
    controller.current?.abort();const owned=new AbortController(),id=++attempt.current;controller.current=owned
    const live=()=>!owned.signal.aborted&&attempt.current===id
    setPending(true);setSaved(false);setError('')
    try{
      if(mode==='ensure'){await privateResult(onEnsure(owned.signal));const read=await privateResult(onRead(owned.signal));if(live()){setCurrent(read);setEditable(draft(read.configuration))}}
      else if(mode==='latest'){const read=await privateResult(onRead(owned.signal));if(live())setLatest(read.configuration)}
      else{const configuration=await privateResult(onSave(editable,owned.signal));if(live()){setCurrent({...current,configuration});setEditable(draft(configuration));setSaved(true);setConflict(false);setLatest(null)}}
    }catch(failure){if(live()){
      if(failure instanceof Response&&failure.status===401){setRefused(true);await onRefused();return}
      if(failure instanceof Response&&failure.status===409){setConflict(true);setError(t.conflict)}
      else setError(failure instanceof Response&&failure.status===400?t.invalid:t.unavailable)
    }}finally{if(live())setPending(false)}
  }
  if(refused)return <PrivateUnavailable locale={locale}/>
  return <><Heading level={1}>{a.business}</Heading>{current.configuration&&<p>{a.version}: {current.configuration.revision}</p>}
    {!current.workspace?<><p>{a.createHint}</p><Button label={a.create} isDisabled={!hydrated} isLoading={pending} onClick={()=>void persist('ensure')}/></>:<form className="sparra-business-form" aria-busy={pending} onSubmit={event=>{event.preventDefault();if(!pending&&!conflict)void persist('save')}}>
      <TextInput label={t.businessName} value={editable.businessName} onChange={businessName=>setEditable({...editable,businessName})} htmlName="businessName" isRequired isDisabled={!hydrated||pending} width="100%"/>
      <Selector label={t.sector} value={editable.sector} options={[{value:'garage',label:t.garage},{value:'controle-technique',label:t.controleTechnique}]} onChange={sector=>{if(sector==='garage'||sector==='controle-technique')setEditable({...editable,sector})}} isDisabled={!hydrated||pending} width="100%"/>
      {sections.map(([field,limit])=><TextArea key={field} label={t[field]} description={`${limit} ${locale==='fr'?'caractères maximum':'characters maximum'}`} htmlName={field} value={editable.knowledge[field]} onChange={value=>setEditable({...editable,knowledge:{...editable.knowledge,[field]:value}})} rows={4} isDisabled={!hydrated||pending} width="100%"/>)}
      <TextInput label={t.transferDestination} description={t.transferHint} htmlName="transferDestination" value={editable.transferDestination??''} onChange={value=>setEditable({...editable,transferDestination:value||null})} isDisabled={!hydrated||pending} width="100%"/>
      <Button label={t.save} type="submit" isDisabled={!hydrated||conflict} isLoading={pending}/>
    </form>}
    {pending&&<><p role="status">{t.saving}</p><Button label={a.cancel} onClick={()=>{attempt.current++;controller.current?.abort();setPending(false)}}/></>}{error&&<p role="alert">{error}</p>}{saved&&<p role="status">{t.saved}</p>}
    {conflict&&<div className="sparra-conflict"><Button label={a.checkLatest} isDisabled={pending} onClick={()=>void persist('latest')}/>{latest&&<><p role="status">{a.latest}: {latest.revision}</p><Button label={a.loadLatest} isDisabled={pending} onClick={()=>{setEditable(draft(latest));setCurrent({...current,configuration:latest});setConflict(false);setError('');setLatest(null)}}/></>}</div>}
  </>
}
