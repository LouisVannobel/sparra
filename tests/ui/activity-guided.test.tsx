import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { ActivityPanel } from '../../src/ui/sparra/activity-panel'
import { CalendarPanel } from '../../src/ui/sparra/calendar-panel'
import { calendarMessages } from '../../src/ui/sparra/calendar-messages'
const forbidden=async():Promise<never>=>{throw new Error('Rendering must not mutate')}

test('an absent Workspace renders only explicit creation and never mounts an Activity or Calendar form',()=>{
  const mutation=vi.fn(forbidden)
  const html=renderToStaticMarkup(<ActivityPanel locale="en" state={{workspace:null,configuration:null,localAudioAvailable:false}} onEnsure={mutation} onSave={mutation} onRead={mutation} onRefused={mutation} calendarSlot={<form aria-label="Calendar must wait for Workspace"/>}/>)
  expect(html).toContain('Create your workspace')
  expect(html).not.toContain('<form')
  expect(html).not.toContain('data-activity-section=')
  expect(html).not.toContain('sparra-version-note')
  expect(html).not.toContain('Calendar must wait for Workspace')
  expect(html.match(/<button\b[^>]*>/)?.[0]).toContain('disabled=""')
  expect(mutation).not.toHaveBeenCalled()
})

test.each(['establishment','knowledge','handling','recap'] as const)('initial %s retains every field while Calendar follows only handling and recap',initialSection=>{
  const html=renderToStaticMarkup(<ActivityPanel locale="en" initialSection={initialSection} state={{workspace:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',displayName:'Owner'},configuration:null,localAudioAvailable:true}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden} calendarSlot={<form aria-label="Independent Calendar"/>}/>)
  expect(html.match(/data-activity-section=/g)).toHaveLength(4)
  for(const section of ['establishment','knowledge','handling','recap']){
    const wrapper=html.match(new RegExp(`<div id="activity-${section}"[^>]*>`))?.[0]
    expect(wrapper).toBeDefined()
    expect(wrapper?.includes('hidden=""')).toBe(section!==initialSection)
  }
  expect(html.match(/<textarea\b/g)).toHaveLength(5)
  expect(html.match(/<input\b/g)?.length).toBeGreaterThanOrEqual(3)
  expect(html).toContain('Business name');expect(html).toContain('Transfer number')
  expect(html.match(/<div class="sparra-guided-calendar"[^>]*>/)?.[0]?.includes('hidden=""')).toBe(initialSection!=='handling'&&initialSection!=='recap')
  expect(html.indexOf('<form aria-label="Independent Calendar"')).toBeGreaterThan(html.indexOf('</form>'))
})
test.each(['fr','en'] as const)('guided editor %s keeps four mounted sections, global save and a single Calendar form outside its form',locale=>{
  const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={{workspace:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',displayName:'Owner'},configuration:null,localAudioAvailable:false}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden} calendarSlot={<form aria-label="Independent Calendar"><button type="submit">Calendar save</button></form>}/> )
  expect(html).toContain('<nav')
  expect(html.match(/aria-current="step"/g)).toHaveLength(1)
  expect(html.match(/data-activity-section=/g)).toHaveLength(4)
  expect(html.match(/hidden=""/g)).toHaveLength(4) // three activity panels and Calendar
  expect(html).toContain('noValidate=""')
  expect(html).toContain(locale==='fr'?'La ligne téléphonique reste à valider séparément.':'The phone line still needs separate validation.')
  expect(html.match(/Independent Calendar/g)).toHaveLength(1)
  const businessEnd=html.indexOf('</form>'),calendarStart=html.indexOf('<form aria-label="Independent Calendar"')
  expect(calendarStart).toBeGreaterThan(businessEnd)
  expect(html.slice(0,businessEnd)).toContain('type="submit"')
})
test.each(['fr','en'] as const)('Calendar return in %s opens actual success/failure content without inventing connection state',locale=>{
  const t=calendarMessages[locale]
  for(const {failed,connected} of [{failed:false,connected:true},{failed:true,connected:false},{failed:false,connected:false}]){
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} initialSection="handling" state={{workspace:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',displayName:'Owner'},configuration:null,localAudioAvailable:false}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden} calendarSlot={<CalendarPanel locale={locale} focusOnEntry callbackFailed={failed} state={{available:true,status:connected?'connected':'disconnected',accountEmail:connected?'owner@example.test':null,selectedCalendar:null,calendars:[],enabled:false,policy:null,revision:0}} onConnect={forbidden} onDisconnect={forbidden} onRead={forbidden} onSave={forbidden}/>}/> )
    const calendarWrapper=html.match(/<div class="sparra-guided-calendar"[^>]*>/)?.[0],handlingWrapper=html.match(/<div id="activity-handling"[^>]*>/)?.[0]
    expect(calendarWrapper).toBeDefined();expect(calendarWrapper).not.toContain('hidden=')
    expect(handlingWrapper).toBeDefined();expect(handlingWrapper).not.toContain('hidden=')
    expect(html.match(/<h2\b[^>]*id="calendar-heading"[^>]*>/)?.[0]).toContain('tabindex="-1"')
    expect(html).toContain(t.disabled)
    if(failed){expect(html).toContain(t.callbackFailed);expect(html).toContain('aria-describedby="calendar-feedback"')}
    if(connected)expect(html).toContain(t.connected+' : owner@example.test')
    else{expect(html).toContain(t.disconnected);expect(html).not.toContain(t.connected+' : ')}
  }
})
test('a saved legacy audio blocker keeps its explanation and settings shortcut outside hidden sections',()=>{
  const configuration={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision:1,savedAt:'2026-10-21T10:00:00Z',businessName:'Existing garage',sector:'garage' as const,knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:true,recordingPolicy:'off' as const,recordingContactPhone:null}
  const html=renderToStaticMarkup(<ActivityPanel locale="en" state={{workspace:{id:configuration.workspaceId,displayName:'Owner'},configuration,localAudioAvailable:false}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden}/> )
  const global=html.slice(html.indexOf('class="sparra-save-blocker"'),html.indexOf('class="sparra-save-summary"'))
  expect(global).toContain('An old audio setting is saved.')
  expect(global).toContain('Review call settings')
  expect(global).not.toContain('hidden=""')
  expect(html.match(/An old audio setting is saved\./g)).toHaveLength(1)
})
