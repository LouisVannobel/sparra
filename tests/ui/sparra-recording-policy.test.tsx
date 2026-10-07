import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { ActivityState } from '../../src/modules/sparra/sparra.functions'

const hydration=vi.hoisted(()=>({value:false}))
vi.mock('@tanstack/react-router',async importOriginal=>({...await importOriginal<typeof import('@tanstack/react-router')>(),useHydrated:()=>hydration.value}))

const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}
test('company audio control renders OFF initially and the saved policy in both locales before hydration',async()=>{
  hydration.value=false
  const { ActivityPanel }=await import('../../src/ui/sparra/activity-panel')
  for(const locale of ['fr','en'] as const) for(const recordingEnabled of [undefined,false,true]){
    const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},localAudioAvailable:false,configuration:recordingEnabled===undefined?null:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:1,savedAt:'2026-10-04T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingPolicy:'off',recordingContactPhone:null,...{recordingEnabled}}}
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    expect(html).toContain(locale==='fr'?'Conserver l’audio des prochains appels pendant 30 jours':'Keep audio from future calls for 30 days')
    expect(html).toContain(locale==='fr'?'n’est pas disponible pour votre entreprise':'unavailable for your business')
    expect(html).toContain(locale==='fr'?'Les transcriptions sont conservées 30 jours.':'Call transcripts are kept for 30 days.')
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).toBeDefined()
    expect(checkbox).toContain('disabled=""')
    expect(checkbox?.includes('checked=""')).toBe(false)
  }
})

test.each(['off','local_30d'] as const)('native unavailable audio guard preserves saved local %s and only permits an existing ON policy to be turned OFF',async recordingPolicy=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  for(const locale of ['fr','en'] as const){
    const state=localState(recordingPolicy,false)
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).toBeDefined()
    expect(checkbox?.includes('checked=""')).toBe(recordingPolicy==='local_30d')
    expect(checkbox?.includes('disabled=""')||checkbox?.includes('aria-disabled="true"')).toBe(recordingPolicy==='off')
  }
})

test('retained historical audio blocks submit with local OFF visible and an explicit correction control available in both locales',async()=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},localAudioAvailable:false,configuration:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:1,savedAt:'2026-10-04T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingPolicy:'off',recordingContactPhone:null,recordingEnabled:true}}
  for(const locale of ['fr','en'] as const){
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    const submit=[...html.matchAll(/<button\b([^>]*)>/g)].find(button=>button[1]?.includes('type="submit"'))?.[1]
    expect(submit).toContain('disabled=""')
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).not.toContain('checked=""')
    expect(checkbox).toContain('disabled=""')
    const correction=[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(button=>button[2]?.includes(locale==='fr'?'Utiliser les réglages d’enregistrement local':'Use local recording settings'))
    expect(correction).toBeDefined()
    expect(correction?.[1]).not.toContain('disabled=""')
  }
})

function localState(recordingPolicy:'off'|'local_30d',localAudioAvailable:boolean):ActivityState{
  return {workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},localAudioAvailable,configuration:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:7,savedAt:'2026-10-07T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:'+33102030405',recordingEnabled:false,recordingPolicy,recordingContactPhone:recordingPolicy==='local_30d'?'+33123456789':null}}
}

test.each(['off','local_30d'] as const)('native available capability renders local %s distinctly from historical provider recording',async recordingPolicy=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const html=renderToStaticMarkup(<ActivityPanel locale="en" state={localState(recordingPolicy,true)} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
  const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
  expect(checkbox?.includes('checked=""')).toBe(recordingPolicy==='local_30d')
  expect(checkbox).not.toContain('disabled=""')
  expect(html).toContain('Recording contact phone')
  expect(html).toContain('Your business phone for requests about recordings.')
  expect(html).toContain('name="recordingContactPhone"')
  expect(html).toContain('does not configure call transfer')
  if(recordingPolicy==='local_30d')expect(html).toContain('value="+33123456789"')
})

test('saved local ON remains checked and permits explicit OFF when native capability is unavailable',async()=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const html=renderToStaticMarkup(<ActivityPanel locale="en" state={localState('local_30d',false)} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
  const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
  expect(checkbox).toContain('checked=""')
  expect(checkbox).not.toContain('disabled=""')
  const submit=[...html.matchAll(/<button\b([^>]*)>/g)].find(button=>button[1]?.includes('type="submit"'))?.[1]
  expect(submit).toContain('disabled=""')
  expect(html).toContain('Audio recording is unavailable for your business')
})

test('historical provider recording ON is never presented as local recording ON and requires explicit correction',async()=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const current=localState('off',true),state:ActivityState={...current,configuration:current.configuration?{...current.configuration,recordingEnabled:true}:null}
  const html=renderToStaticMarkup(<ActivityPanel locale="en" state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
  const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
  expect(checkbox).not.toContain('checked=""')
  const submit=[...html.matchAll(/<button\b([^>]*)>/g)].find(button=>button[1]?.includes('type="submit"'))?.[1]
  expect(submit).toContain('disabled=""')
  expect(html).toContain('Use local recording settings')
})
