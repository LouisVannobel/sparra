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
    const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},configuration:recordingEnabled===undefined?null:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:1,savedAt:'2026-10-04T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,...{recordingEnabled}}}
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    expect(html).toContain(locale==='fr'?'Conserver l’audio des prochains appels pendant 30 jours':'Keep audio from future calls for 30 days')
    expect(html).toContain(locale==='fr'?'indisponible sur ce pilote':'unavailable in this pilot')
    expect(html).toContain(locale==='fr'?'Les transcriptions sont conservées 30 jours.':'Call transcripts are kept for 30 days.')
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).toBeDefined()
    expect(checkbox).toContain('disabled=""')
    expect(checkbox?.includes('checked=""')).toBe(recordingEnabled===true)
  }
})

test.each([false,true])('pilot audio guard preserves saved %s and only permits an existing ON policy to be turned OFF',async recordingEnabled=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  for(const locale of ['fr','en'] as const){
    const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},configuration:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:1,savedAt:'2026-10-04T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled}}
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).toBeDefined()
    expect(checkbox?.includes('checked=""')).toBe(recordingEnabled)
    expect(checkbox?.includes('disabled=""')||checkbox?.includes('aria-disabled="true"')).toBe(!recordingEnabled)
  }
})

test('retained pilot audio ON blocks the submit action while keeping its checked value and correction control available',async()=>{
  hydration.value=true
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},configuration:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:1,savedAt:'2026-10-04T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:true}}
  for(const locale of ['fr','en'] as const){
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    const submit=[...html.matchAll(/<button\b([^>]*)>/g)].find(button=>button[1]?.includes('type="submit"'))?.[1]
    expect(submit).toContain('disabled=""')
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).toContain('checked=""')
    expect(checkbox).not.toContain('disabled=""')
  }
})
