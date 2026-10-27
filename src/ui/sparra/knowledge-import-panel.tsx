import { useEffect, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { TextArea } from '@astryxdesign/core/TextArea'
import type { ActivityState, KnowledgeDecision, KnowledgeImportDto, SaveActivityInput, WebsiteCapture } from '../../modules/sparra/sparra.functions'
import { activityMessages, knowledgeMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { privateResult } from './app-shell'

export type KnowledgePreparation={capture:KnowledgeImportDto|null;decisions:readonly KnowledgeDecision[]}
type Target=Extract<KnowledgeDecision,{action:'use'}>['target']
const targets:readonly Target[]=['openingHours','services','prices','faq']
function KnowledgeSource({source,locale}:{source:WebsiteCapture;locale:Locale}){
  const t=knowledgeMessages[locale]
  // Only server-validated HTTPS links are interactive, including retained receipts.
  const safe=(()=>{try{const url=new URL(source.url);return url.protocol==='https:'&&!url.username&&!url.password}catch{return false}})()
  return <p className="sparra-knowledge-source">{t.source}: {safe?<a href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>:source.url}<br/>{t.captured}: <time dateTime={source.capturedAt}>{source.capturedAt}</time></p>
}
function Passage({passage,locale,disabled,decision,onUse,onIgnore}:{passage:WebsiteCapture['passages'][number];locale:Locale;disabled:boolean;decision?:KnowledgeDecision;onUse(target:Target,text:string):void;onIgnore():void}){
  const t=knowledgeMessages[locale],a=activityMessages[locale]
  const [target,setTarget]=useState<Target|''>(''),[text,setText]=useState(passage.text)
  return <fieldset className="sparra-import-passage"><legend>Passage {passage.id}</legend><blockquote>{passage.text}</blockquote>
    <label>{t.target}<select value={target} disabled={disabled} onChange={event=>{const value=event.target.value;setTarget(targets.find(item=>item===value)??'')}}><option value="">{t.choose}</option>{targets.map(value=><option key={value} value={value}>{a[value]}</option>)}</select></label>
    <TextArea label={t.edit} value={text} onChange={setText} isDisabled={disabled} width="100%"/>
    <Button type="button" label={t.use} isDisabled={disabled||!target||!text||decision?.action==='use'} onClick={()=>{if(target)onUse(target,text)}}/>
    <Button type="button" label={t.ignore} isDisabled={disabled||decision?.action==='ignore'} onClick={onIgnore}/>
    {decision&&<p role="status">{decision.action==='use'?t.used:t.ignored}</p>}
  </fieldset>
}
export function KnowledgeImportPanel({locale,editable,disabled,value,onChange,onEdit,onImport,onPendingChange,onRefused}:{locale:Locale;editable:SaveActivityInput;disabled:boolean;value:KnowledgePreparation;onChange(value:KnowledgePreparation):void;onEdit(value:SaveActivityInput):void;onImport(url:string,signal:AbortSignal):Promise<KnowledgeImportDto|Response>;onPendingChange(value:boolean):void;onRefused():Promise<void>}){
  const t=knowledgeMessages[locale]
  const [url,setUrl]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState('')
  const request=useRef<{controller:AbortController;editable:SaveActivityInput}|null>(null)
  useEffect(()=>()=>{request.current?.controller.abort();request.current=null},[])
  useEffect(()=>{if(request.current&&request.current.editable!==editable){request.current.controller.abort();request.current=null;setPending(false);onPendingChange(false);setError(t.failed)}},[editable,onPendingChange,t.failed])
  function cancel(){request.current?.controller.abort();request.current=null;setPending(false);onPendingChange(false);setError(t.failed)}
  function manual(){cancel();onChange({capture:null,decisions:[]});setError('')}
  async function read(){
    if(disabled||pending)return
    const owned={controller:new AbortController(),editable};request.current=owned
    onChange({capture:null,decisions:[]});setError('');setPending(true);onPendingChange(true)
    try{const capture=await privateResult(onImport(url,owned.controller.signal));if(request.current===owned&&!owned.controller.signal.aborted)onChange({capture,decisions:[]})}
    catch(failure){if(request.current===owned){if(failure instanceof Response&&failure.status===401)await onRefused();else setError(t.failed)}}
    finally{if(request.current===owned){request.current=null;setPending(false);onPendingChange(false)}}
  }
  function decide(decision:KnowledgeDecision){onChange({...value,decisions:[...value.decisions.filter(item=>item.passageId!==decision.passageId),decision]})}
  return <section aria-label={t.title} className="sparra-knowledge-import"><h2>{t.title}</h2><p>{t.hint}</p><p>{t.boundaries}</p>
    <TextInput label={t.url} value={url} onChange={value=>{if(pending)cancel();setUrl(value)}} isDisabled={disabled} width="100%"/>
    <Button type="button" label={t.read} isDisabled={disabled||pending||!url} onClick={()=>void read()}/><Button type="button" label={t.manual} isDisabled={disabled} onClick={manual}/>
    {pending&&<><p role="status">{t.reading}</p><Button type="button" label={t.cancel} onClick={cancel}/></>}{error&&<p role="alert">{error}</p>}
    {value.capture&&<><KnowledgeSource source={value.capture.source} locale={locale}/><p>{t.adaptation}</p>{value.capture.source.passages.map(passage=><Passage key={value.capture!.captureId+passage.id} passage={passage} locale={locale} disabled={disabled||pending} decision={value.decisions.find(item=>item.passageId===passage.id)} onIgnore={()=>decide({action:'ignore',passageId:passage.id})} onUse={(target,text)=>{decide({action:'use',passageId:passage.id,target});onEdit({...editable,knowledge:{...editable.knowledge,[target]:[editable.knowledge[target],text].filter(Boolean).join('\n')}})}}/>)}</>}
  </section>
}
export function KnowledgeOrigin({state,locale}:{state:ActivityState;locale:Locale}){
  if(!state.configuration)return null
  const t=knowledgeMessages[locale],confirmation=state.confirmation
  return <details className="sparra-knowledge-origin"><summary>{t.provenance}</summary>{confirmation?<><p>{t.retention}: <time dateTime={confirmation.expiresAt}>{confirmation.expiresAt}</time></p>{confirmation.provenance.source?<><KnowledgeSource source={confirmation.provenance.source} locale={locale}/><p>{t.adaptation}</p>{confirmation.provenance.source.passages.map(passage=>{const decision=confirmation.provenance.decisions.find(item=>item.passageId===passage.id);return <div key={passage.id}><blockquote>{passage.text}</blockquote><p>{decision?.action==='use'?`${t.used} : ${activityMessages[locale][decision.target]}`:t.ignored}</p></div>})}</>:<p>{t.manualOrigin}</p>}</>:<p>{t.originUnavailable}</p>}</details>
}
