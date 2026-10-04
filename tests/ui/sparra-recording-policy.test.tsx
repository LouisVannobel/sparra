import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { ActivityState } from '../../src/modules/sparra/sparra.functions'

const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}
test('company audio control renders OFF initially and the saved policy in both locales before hydration',async()=>{
  const { ActivityPanel }=await import('../../src/ui/sparra/activity-panel')
  for(const locale of ['fr','en'] as const) for(const recordingEnabled of [undefined,false,true]){
    const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Company'},configuration:recordingEnabled===undefined?null:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:1,savedAt:'2026-10-04T10:00:00.000Z',businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,...{recordingEnabled}}}
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/>)
    expect(html).toContain(locale==='fr'?'Conserver l’audio des prochains appels pendant 30 jours':'Keep audio from future calls for 30 days')
    expect(html).toContain('Telnyx')
    expect(html).toContain(locale==='fr'?'après enregistrement':'after saving')
    const checkbox=[...html.matchAll(/<input\b([^>]*)>/g)].find(input=>input[1]?.includes('type="checkbox"'))?.[1]
    expect(checkbox).toBeDefined()
    expect(checkbox).toContain('disabled=""')
    expect(checkbox?.includes('checked=""')).toBe(recordingEnabled===true)
  }
})
