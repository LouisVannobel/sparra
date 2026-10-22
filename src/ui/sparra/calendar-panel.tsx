import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import type { CalendarState } from '../../modules/calendar/connection.server'
import type { SaveCalendarPolicy } from '../../modules/calendar/policy'
import type { Locale } from '../auth/messages'
import { privateResult } from './app-shell'
import { calendarMessages } from './calendar-messages'

export type CalendarNavigationState={dirty:boolean;pending:boolean;reconcile:boolean;connecting:boolean}

type Props={onNavigationStateChange?:(state:CalendarNavigationState)=>void;onBeforeConnect?:()=>boolean;onNavigate?:(url:string)=>void|Promise<void>;locale:Locale;state:CalendarState;callbackFailed?:boolean;focusOnEntry?:boolean;onConnect(signal:AbortSignal):Promise<string|Response>;onSave(data:SaveCalendarPolicy,signal:AbortSignal):Promise<CalendarState|Response>;onDisconnect(signal:AbortSignal):Promise<void|Response>;onRead(signal:AbortSignal):Promise<CalendarState|Response>}
function calendarDraft(state:CalendarState):SaveCalendarPolicy {
  return {expectedRevision:state.revision,calendarId:state.selectedCalendar?.id??'',enabled:state.enabled,policy:state.policy??{version:1,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}}
}
function calendarFailure(error:unknown):'conflict'|'invalid'|'unavailable' {
  return error instanceof Response&&error.status===409?'conflict':error instanceof Response&&error.status===400?'invalid':'unavailable'
}
function NumericField({label,value,onChange,min,max,step=1,disabled}:{label:string;value:number;onChange(value:number):void;min:number;max:number;step?:number;disabled:boolean}) {
  return <label className="sparra-calendar-number">{label}<input type="number" required min={min} max={max} step={step} value={Number.isFinite(value)?value:''} disabled={disabled} onChange={event=>onChange(event.target.valueAsNumber)}/></label>
}
type CalendarEditorProps={policy:SaveCalendarPolicy['policy'];labels:(typeof calendarMessages)[Locale];disabled:boolean;update(patch:Partial<SaveCalendarPolicy['policy']>):void}
function ServicesEditor({policy,labels:t,disabled,update}:CalendarEditorProps) {
  return <fieldset className="sparra-form-section" disabled={disabled}><legend>{t.services}</legend>
    {policy.services.map((service,index)=><div key={service.id} className="sparra-calendar-row">
      <TextInput label={`${t.service} ${index+1}`} value={service.name} isRequired isDisabled={disabled} onChange={name=>update({services:policy.services.map(item=>item.id===service.id?{...item,name}:item)})}/>
      <NumericField label={`${t.duration} ${index+1}`} value={service.durationMinutes} min={5} max={480} step={5} disabled={disabled} onChange={durationMinutes=>update({services:policy.services.map(item=>item.id===service.id?{...item,durationMinutes}:item)})}/>
      <Button label={`${t.remove} ${index+1}`} isDisabled={disabled} onClick={()=>update({services:policy.services.filter(item=>item.id!==service.id)})}/>
    </div>)}
    <Button label={t.addService} isDisabled={disabled||policy.services.length>=30} onClick={()=>update({services:[...policy.services,{id:crypto.randomUUID(),name:'',durationMinutes:30}]})}/>
  </fieldset>
}
function WeeklyHoursEditor({policy,labels:t,disabled,update}:CalendarEditorProps) {
  return <fieldset className="sparra-form-section" disabled={disabled}><legend>{t.hours}</legend>
    {[1,2,3,4,5,6,0].map(day=>{const entry=policy.weeklyHours.find(item=>item.day===day);return <div key={day} className="sparra-calendar-day"><strong>{t.days[day]}</strong>
      {entry?.ranges.map((range,index)=><div className="sparra-calendar-row" key={index}>
        {(['start','end'] as const).map(field=><label key={field}>{`${t.days[day]} ${t[field]} ${index+1}`}<input type="time" required value={range[field]} disabled={disabled} onChange={event=>update({weeklyHours:policy.weeklyHours.map(item=>item.day===day?{...item,ranges:item.ranges.map((time,i)=>i===index?{...time,[field]:event.target.value}:time)}:item)})}/></label>)}
        <Button label={`${t.remove} ${t.days[day]} ${index+1}`} isDisabled={disabled} onClick={()=>update({weeklyHours:policy.weeklyHours.flatMap(item=>item.day!==day?[item]:item.ranges.length===1?[]:[{...item,ranges:item.ranges.filter((_,i)=>i!==index)}])})}/>
      </div>)}
      <Button label={`${t.addRange} — ${t.days[day]}`} isDisabled={disabled||(entry?.ranges.length??0)>=2} onClick={()=>update({weeklyHours:entry?policy.weeklyHours.map(item=>item.day===day?{...item,ranges:[...item.ranges,{start:'',end:''}]}:item):[...policy.weeklyHours,{day,ranges:[{start:'',end:''}]}]})}/>
    </div>})}
  </fieldset>
}
type CalendarLabels=(typeof calendarMessages)[Locale]
function CalendarConnectionActions({status,labels:t,disabled,onAction}:{status:CalendarState['status'];labels:CalendarLabels;disabled:boolean;onAction(action:CalendarAction):void}) {
  return <div className="sparra-calendar-actions">
      {status!=='revoking'&&<Button label={status==='connected'||status==='reconnect_required'?t.reconnect:t.connect} isDisabled={disabled} onClick={()=>onAction('connect')}/>}
      {status!=='disconnected'&&<Button label={t.disconnect} isDisabled={disabled} onClick={()=>onAction('disconnect')}/>}
      <Button label={t.read} isDisabled={disabled} onClick={()=>onAction('read')}/>
    </div>
}
function CalendarConnectionView({current,labels:t,disabled,onAction}:{current:CalendarState;labels:CalendarLabels;disabled:boolean;onAction(action:CalendarAction):void}) {
  const notices={disconnected:null,connected:null,reconnect_required:t.reconnectRequired,connecting:t.connecting,revoking:t.revoking,unavailable:null} satisfies Record<CalendarState['status'],string|null>
  const notice=notices[current.status]
  return <>
    <p>{current.accountEmail?`${current.status==='connected'?t.connected:t.retainedAccount} : ${current.accountEmail}`:t.disconnected}</p>
    {notice&&<p role="status">{notice}</p>}
    <p>{current.enabled?t.active:t.disabled}</p>
    <p className="sparra-form-hint">{t.access} {t.privacy}</p>
    <CalendarConnectionActions status={current.status} labels={t} disabled={disabled} onAction={onAction}/>
  </>
}
function calendarOptions(calendars:CalendarState['calendars']) {
  return calendars.map(calendar=>({value:calendar.id,
    label:calendars.some(other=>other.id!==calendar.id&&other.summary===calendar.summary)?`${calendar.summary} (${calendar.id})`:calendar.summary}))
}
function CalendarSelectionField({current,draft,labels:t,disabled,changeDraft}:{current:CalendarState;draft:SaveCalendarPolicy;labels:CalendarLabels;disabled:boolean;changeDraft(patch:Partial<SaveCalendarPolicy>):void}) {
  return <Selector label={t.choose} description={t.chooseHint} value={draft.calendarId||null} hasClear options={calendarOptions(current.calendars)} onChange={value=>changeDraft({calendarId:value??''})} isRequired isDisabled={disabled} width="100%"/>
}
function CalendarActivation({current,draft,labels:t,disabled,changeDraft}:{current:CalendarState;draft:SaveCalendarPolicy;labels:CalendarLabels;disabled:boolean;changeDraft(patch:Partial<SaveCalendarPolicy>):void}) {
  const unavailable=disabled||!current.available||!draft.calendarId||!draft.policy.services.length||!draft.policy.weeklyHours.length
  return <>
    <CheckboxInput label={t.enable} value={draft.enabled} onChange={enabled=>changeDraft({enabled})} isDisabled={unavailable}/>
    {!current.policy&&<p>{t.unsaved}</p>}
    <Button type="submit" label={t.save} isDisabled={unavailable}/>
  </>
}
function CalendarSettingsForm({current,draft,labels:t,disabled,editPolicy,changeDraft,onSave}:{current:CalendarState;draft:SaveCalendarPolicy;labels:CalendarLabels;disabled:boolean;editPolicy(patch:Partial<SaveCalendarPolicy['policy']>):void;changeDraft(patch:Partial<SaveCalendarPolicy>):void;onSave():void}) {
  return <form onSubmit={event=>{event.preventDefault();onSave()}}>
    <CalendarSelectionField current={current} draft={draft} labels={t} disabled={disabled} changeDraft={changeDraft}/>
    <TextInput label={t.timeZone} value={draft.policy.timeZone} onChange={timeZone=>editPolicy({timeZone})} isRequired isDisabled={disabled}/>
    <ServicesEditor policy={draft.policy} labels={t} disabled={disabled} update={editPolicy}/>
    <WeeklyHoursEditor policy={draft.policy} labels={t} disabled={disabled} update={editPolicy}/>
    <div className="sparra-calendar-row"><NumericField label={t.buffer} value={draft.policy.bufferMinutes} min={0} max={120} disabled={disabled} onChange={bufferMinutes=>editPolicy({bufferMinutes})}/><NumericField label={t.notice} value={draft.policy.noticeMinutes} min={0} max={10080} disabled={disabled} onChange={noticeMinutes=>editPolicy({noticeMinutes})}/></div>
    <CalendarActivation current={current} draft={draft} labels={t} disabled={disabled} changeDraft={changeDraft}/>
  </form>
}
type CalendarAction='connect'|'disconnect'|'save'|'read'
type CalendarActionContext=Pick<Props,'onConnect'|'onDisconnect'|'onSave'|'onRead'|'onBeforeConnect'> & {
  locale:Locale;current:CalendarState;draft:SaveCalendarPolicy;hydrated:boolean
  busy:{current:boolean};operation:{current:AbortController|null}
  accept(next:CalendarState,adopt?:boolean):void;setReconcile?(value:boolean):void;setPending(value:boolean):void;setFeedback(value:string|null):void;navigate(url:string):void|Promise<void>
}
async function connectCalendarAction(context:CalendarActionContext,signal:AbortSignal) {
  if(context.current.status==='connected'||context.current.status==='reconnect_required') {
    await privateResult(context.onDisconnect(signal))
    if(signal.aborted)return
  }
  const url=await privateResult(context.onConnect(signal))
  if(!signal.aborted)await context.navigate(url)
}
async function disconnectCalendarAction(context:CalendarActionContext,signal:AbortSignal) {
  await privateResult(context.onDisconnect(signal))
  if(signal.aborted)return
  const next=await privateResult(context.onRead(signal))
  if(!signal.aborted)context.accept(next)
}
async function performCalendarAction(action:CalendarAction,context:CalendarActionContext,signal:AbortSignal):Promise<void> {
  if(action==='connect')return connectCalendarAction(context,signal)
  if(action==='disconnect')return disconnectCalendarAction(context,signal)
  if(action==='save') {
    const next=await privateResult(context.onSave(context.draft,signal))
    if(!signal.aborted){context.accept(next,true);context.setFeedback(calendarMessages[context.locale].saved)}
    return
  }
  const next=await privateResult(context.onRead(signal))
  if(!signal.aborted)context.accept(next)
}
function publishCalendarActionFailure(action:CalendarAction,context:CalendarActionContext,error:unknown):void {
  const t=calendarMessages[context.locale],kind=calendarFailure(error)
  if(action==='save'&&kind!=='invalid')context.setReconcile?.(true)
  context.setFeedback(kind==='conflict'?t.conflict:kind==='invalid'?t.invalid:t.failure)
}
/** The same refs own exclusion and cancellation for all concrete panel actions. */
export async function runCalendarAction(action:CalendarAction, context:CalendarActionContext):Promise<void> {
  const {busy,operation}=context
  if(busy.current||!context.hydrated)return
  if(action==='connect'&&context.onBeforeConnect?.()===false)return
  busy.current=true
  const controller=new AbortController()
  operation.current=controller
  context.setPending(true)
  context.setFeedback(null)
  const live=()=>!controller.signal.aborted
  try {
    await performCalendarAction(action,context,controller.signal)
  } catch(error) {
    if(live())publishCalendarActionFailure(action,context,error)
  } finally {
    busy.current=false
    if(operation.current===controller)operation.current=null
    if(live())context.setPending(false)
  }
}
function CalendarDraftStatus({dirty,reconcile,canAdopt,disabled,labels:t,onReplace}:{dirty:boolean;reconcile:boolean;canAdopt:boolean;disabled:boolean;labels:CalendarLabels;onReplace():void}) {
  return <>
    {dirty&&<p role="status">{t.draftDirty}</p>}
    {reconcile&&<p role="status">{t.reconcile}</p>}
    {canAdopt&&(dirty||reconcile)&&<Button label={t.replace} isDisabled={disabled} onClick={onReplace}/>}
  </>
}
function CalendarPanelView({locale,labels:t,feedback,headingRef,focusOnEntry,children}:{locale:Locale;labels:CalendarLabels;feedback:string|null;headingRef:{current:HTMLHeadingElement|null};focusOnEntry:boolean;children:ReactNode}) {
  return <section className="sparra-form-section" aria-labelledby="calendar-heading"><Heading ref={headingRef} level={2} id="calendar-heading" tabIndex={focusOnEntry?-1:undefined} aria-describedby={feedback?'calendar-feedback':undefined}>{t.title}</Heading>
    {children}
    <p><a href="/confidentialite">{locale==='fr'?'Confidentialité et utilisation de Google Agenda':'Privacy and Google Calendar data use'}</a></p>
    {feedback&&<p id="calendar-feedback" role="status" aria-live="polite">{feedback}</p>}
  </section>
}
function useCalendarActionFeedback(t:CalendarLabels,callbackFailed:Props['callbackFailed']) {
  const [pendingAction,setPendingAction]=useState<CalendarAction|null>(null),[reconcile,setReconcile]=useState(false),[canAdopt,setCanAdopt]=useState(true),[feedback,setFeedback]=useState<string|null>(callbackFailed?t.callbackFailed:null)
  return {pendingAction,setPendingAction,reconcile,setReconcile,canAdopt,setCanAdopt,feedback,setFeedback}
}
function useCalendarPanelLifecycle({locale,state,callbackFailed,focusOnEntry,onConnect,onSave,onDisconnect,onRead,onNavigationStateChange,onBeforeConnect,onNavigate}:Pick<Props,'locale'|'state'|'callbackFailed'|'onConnect'|'onSave'|'onDisconnect'|'onRead'|'onNavigationStateChange'|'onBeforeConnect'|'onNavigate'>&{focusOnEntry:boolean}) {
  const t=calendarMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(state),[draft,setDraft]=useState(()=>calendarDraft(state)),[known,setKnown]=useState(()=>calendarDraft(state))
  const {pendingAction,setPendingAction,reconcile,setReconcile,canAdopt,setCanAdopt,feedback,setFeedback}=useCalendarActionFeedback(t,callbackFailed)
  const operation=useRef<AbortController|null>(null),busy=useRef(false)
  const headingRef=useRef<HTMLHeadingElement|null>(null)
  const navigationCallback=useRef(onNavigationStateChange)
  useEffect(()=>{navigationCallback.current=onNavigationStateChange})
  const pending=pendingAction!==null,connecting=pendingAction==='connect',dirty=JSON.stringify(draft)!==JSON.stringify(known)
  useEffect(()=>{navigationCallback.current?.({dirty,pending,reconcile,connecting})},[dirty,pending,reconcile,connecting])
  useEffect(()=>{if(hydrated&&focusOnEntry)headingRef.current?.focus()},[hydrated,focusOnEntry])
  useEffect(()=>()=>operation.current?.abort(),[])
  const disabled=!hydrated||pending
  function accept(next:CalendarState,adopt=false){
    setCurrent(next);setCanAdopt(true)
    if(!adopt){setReconcile(previous=>previous||JSON.stringify(calendarDraft(next))!==JSON.stringify(known));return}
    const nextDraft=calendarDraft(next);setDraft(nextDraft);setKnown(nextDraft);setReconcile(false)
  }
  function replace(){const next=calendarDraft(current);setDraft(next);setKnown(next);setReconcile(false);setFeedback(null)}
  function run(action:CalendarAction) {return runCalendarAction(action,{locale,current,draft,hydrated,busy,operation,onConnect,onSave,onDisconnect,onRead,onBeforeConnect,accept,setReconcile:value=>{setReconcile(value);if(value)setCanAdopt(false)},setPending:value=>setPendingAction(value?action:null),setFeedback,navigate:onNavigate??(url=>window.location.assign(url))})}
  const editPolicy=(patch:Partial<SaveCalendarPolicy['policy']>)=>{setFeedback(null);setDraft({...draft,policy:{...draft.policy,...patch}})}
  const changeDraft=(patch:Partial<SaveCalendarPolicy>)=>{setFeedback(null);setDraft({...draft,...patch})}
  return {t,current,draft,reconcile,canAdopt,feedback,headingRef,dirty,disabled,replace,run,editPolicy,changeDraft}
}
export function CalendarPanel({locale,state,callbackFailed,focusOnEntry=false,onConnect,onSave,onDisconnect,onRead,onNavigationStateChange,onBeforeConnect,onNavigate}:Props) {
  const {t,current,draft,reconcile,canAdopt,feedback,headingRef,dirty,disabled,replace,run,editPolicy,changeDraft}=useCalendarPanelLifecycle({locale,state,callbackFailed,focusOnEntry,onConnect,onSave,onDisconnect,onRead,onNavigationStateChange,onBeforeConnect,onNavigate})
  return <CalendarPanelView locale={locale} labels={t} feedback={feedback} headingRef={headingRef} focusOnEntry={focusOnEntry}>
    {!current.available&&<p>{t.unavailable}</p>}
    {current.status!=='unavailable'&&<>
      <CalendarConnectionView current={current} labels={t} disabled={disabled} onAction={run}/>
      {current.status==='connected'&&<CalendarSettingsForm current={current} draft={draft} labels={t} disabled={disabled} editPolicy={editPolicy} changeDraft={changeDraft} onSave={()=>run('save')}/>}
    </>}
    <CalendarDraftStatus dirty={dirty} reconcile={reconcile} canAdopt={canAdopt} disabled={disabled} labels={t} onReplace={replace}/>
  </CalendarPanelView>
}
