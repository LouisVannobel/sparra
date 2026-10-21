import { useEffect, useRef, useState } from 'react'
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

type Props={locale:Locale;state:CalendarState;callbackFailed?:boolean;onConnect(signal:AbortSignal):Promise<string|Response>;onSave(data:SaveCalendarPolicy,signal:AbortSignal):Promise<CalendarState|Response>;onDisconnect(signal:AbortSignal):Promise<void|Response>;onRead(signal:AbortSignal):Promise<CalendarState|Response>}
export function calendarDraft(state:CalendarState):SaveCalendarPolicy {
  return {expectedRevision:state.revision,calendarId:state.selectedCalendar?.id??'',enabled:state.enabled,policy:state.policy??{version:1,timeZone:'Europe/Paris',services:[],weeklyHours:[],bufferMinutes:0,noticeMinutes:0}}
}
export function calendarFailure(error:unknown):'conflict'|'invalid'|'unavailable' {
  return error instanceof Response&&error.status===409?'conflict':error instanceof Response&&error.status===400?'invalid':'unavailable'
}
function NumericField({label,value,onChange,min,max,step=1,disabled}:{label:string;value:number;onChange(value:number):void;min:number;max:number;step?:number;disabled:boolean}) {
  return <label className="sparra-calendar-number">{label}<input type="number" required min={min} max={max} step={step} value={Number.isFinite(value)?value:''} disabled={disabled} onChange={event=>onChange(event.target.valueAsNumber)}/></label>
}
export function CalendarPanel({locale,state,callbackFailed,onConnect,onSave,onDisconnect,onRead}:Props) {
  const t=calendarMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(state),[draft,setDraft]=useState(()=>calendarDraft(state)),[pending,setPending]=useState(false),[feedback,setFeedback]=useState<string|null>(callbackFailed?t.callbackFailed:null)
  const operation=useRef<AbortController|null>(null),busy=useRef(false)
  useEffect(()=>()=>operation.current?.abort(),[])
  const disabled=!hydrated||pending
  function accept(next:CalendarState){setCurrent(next);setDraft(calendarDraft(next))}
  async function run(action:'connect'|'disconnect'|'save'|'read') {
    if(busy.current||!hydrated)return
    busy.current=true;const controller=new AbortController();operation.current=controller;setPending(true);setFeedback(null)
    try {
      if(action==='connect') {
        if(current.status==='connected'||current.status==='reconnect_required')await privateResult(onDisconnect(controller.signal))
        const url=await privateResult(onConnect(controller.signal));if(!controller.signal.aborted)window.location.assign(url)
      } else if(action==='disconnect') {await privateResult(onDisconnect(controller.signal));accept(await privateResult(onRead(controller.signal)))}
      else if(action==='save'){accept(await privateResult(onSave(draft,controller.signal)));setFeedback(t.saved)}
      else accept(await privateResult(onRead(controller.signal)))
    } catch(error) {if(!controller.signal.aborted){const kind=calendarFailure(error);setFeedback(kind==='conflict'?t.conflict:kind==='invalid'?t.invalid:t.failure)}}
    finally {busy.current=false;if(!controller.signal.aborted)setPending(false)}
  }
  const editPolicy=(patch:Partial<SaveCalendarPolicy['policy']>)=>{setFeedback(null);setDraft({...draft,policy:{...draft.policy,...patch}})}
  const connected=current.status==='connected'
  return <section className="sparra-form-section" aria-labelledby="calendar-heading"><Heading level={2} id="calendar-heading">{t.title}</Heading>
    {!current.available&&<p>{t.unavailable}</p>}
    {current.status!=='unavailable'&&<>
      <p>{current.accountEmail?`${t.connected} : ${current.accountEmail}`:t.disconnected}</p>
      {current.status==='connecting'&&<p role="status">{t.connecting}</p>}
      {current.status==='revoking'&&<p role="status">{t.revoking}</p>}
      <p>{current.enabled?t.active:t.disabled}</p>
      <p className="sparra-form-hint">{t.access} {t.privacy}</p>
      <div className="sparra-calendar-actions">
        {current.status!=='revoking'&&<Button label={connected||current.status==='reconnect_required'?t.reconnect:t.connect} isDisabled={disabled} onClick={()=>void run('connect')}/>}
        {current.status!=='disconnected'&&<Button label={t.disconnect} isDisabled={disabled} onClick={()=>void run('disconnect')}/>}
        <Button label={t.read} isDisabled={disabled} onClick={()=>void run('read')}/>
      </div>
      {connected&&<form onSubmit={event=>{event.preventDefault();void run('save')}}>
        <Selector label={t.choose} description={t.chooseHint} value={draft.calendarId||null} hasClear options={current.calendars.map(calendar=>({value:calendar.id,label:current.calendars.some(other=>other.id!==calendar.id&&other.summary===calendar.summary)?`${calendar.summary} (${calendar.id})`:calendar.summary}))} onChange={value=>setDraft({...draft,calendarId:value??''})} isRequired isDisabled={disabled} width="100%"/>
        <TextInput label={t.timeZone} value={draft.policy.timeZone} onChange={timeZone=>editPolicy({timeZone})} isRequired isDisabled={disabled}/>
        <fieldset className="sparra-form-section" disabled={disabled}><legend>{t.services}</legend>
          {draft.policy.services.map((service,index)=><div key={service.id} className="sparra-calendar-row"><TextInput label={`${t.service} ${index+1}`} value={service.name} isRequired isDisabled={disabled} onChange={name=>editPolicy({services:draft.policy.services.map(item=>item.id===service.id?{...item,name}:item)})}/><NumericField label={`${t.duration} ${index+1}`} value={service.durationMinutes} min={5} max={480} step={5} disabled={disabled} onChange={durationMinutes=>editPolicy({services:draft.policy.services.map(item=>item.id===service.id?{...item,durationMinutes}:item)})}/><Button label={`${t.remove} ${index+1}`} isDisabled={disabled} onClick={()=>editPolicy({services:draft.policy.services.filter(item=>item.id!==service.id)})}/></div>)}
          <Button label={t.addService} isDisabled={disabled||draft.policy.services.length>=30} onClick={()=>editPolicy({services:[...draft.policy.services,{id:crypto.randomUUID(),name:'',durationMinutes:30}]})}/>
        </fieldset>
        <fieldset className="sparra-form-section" disabled={disabled}><legend>{t.hours}</legend>
          {[1,2,3,4,5,6,0].map(day=>{const entry=draft.policy.weeklyHours.find(item=>item.day===day);return <div key={day} className="sparra-calendar-day"><strong>{t.days[day]}</strong>
            {entry?.ranges.map((range,index)=><div className="sparra-calendar-row" key={index}>
              {(['start','end'] as const).map(field=><label key={field}>{`${t.days[day]} ${t[field]} ${index+1}`}<input type="time" required value={range[field]} disabled={disabled} onChange={event=>editPolicy({weeklyHours:draft.policy.weeklyHours.map(item=>item.day===day?{...item,ranges:item.ranges.map((time,i)=>i===index?{...time,[field]:event.target.value}:time)}:item)})}/></label>)}
              <Button label={`${t.remove} ${t.days[day]} ${index+1}`} isDisabled={disabled} onClick={()=>editPolicy({weeklyHours:draft.policy.weeklyHours.flatMap(item=>item.day!==day?[item]:item.ranges.length===1?[]:[{...item,ranges:item.ranges.filter((_,i)=>i!==index)}])})}/>
            </div>)}
            <Button label={`${t.addRange} — ${t.days[day]}`} isDisabled={disabled||(entry?.ranges.length??0)>=2} onClick={()=>editPolicy({weeklyHours:entry?draft.policy.weeklyHours.map(item=>item.day===day?{...item,ranges:[...item.ranges,{start:'',end:''}]}:item):[...draft.policy.weeklyHours,{day,ranges:[{start:'',end:''}]}]})}/>
          </div>})}
        </fieldset>
        <div className="sparra-calendar-row"><NumericField label={t.buffer} value={draft.policy.bufferMinutes} min={0} max={120} disabled={disabled} onChange={bufferMinutes=>editPolicy({bufferMinutes})}/><NumericField label={t.notice} value={draft.policy.noticeMinutes} min={0} max={10080} disabled={disabled} onChange={noticeMinutes=>editPolicy({noticeMinutes})}/></div>
        <CheckboxInput label={t.enable} value={draft.enabled} onChange={enabled=>setDraft({...draft,enabled})} isDisabled={disabled||!current.available||!draft.calendarId||!draft.policy.services.length||!draft.policy.weeklyHours.length}/>
        {!current.policy&&<p>{t.unsaved}</p>}
        <Button type="submit" label={t.save} isDisabled={disabled||!current.available||!draft.calendarId||!draft.policy.services.length||!draft.policy.weeklyHours.length}/>
      </form>}
    </>}
    <p><a href="/confidentialite">{locale==='fr'?'Confidentialité et utilisation de Google Agenda':'Privacy and Google Calendar data use'}</a></p>
    {feedback&&<p role="status" aria-live="polite">{feedback}</p>}
  </section>
}
