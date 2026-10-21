import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ActivityPanel } from '../../src/ui/sparra/activity-panel'
const forbidden=async():Promise<never>=>{throw new Error('Rendering must not mutate')}
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
test('a saved legacy audio blocker keeps its explanation and settings shortcut outside hidden sections',()=>{
  const configuration={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision:1,savedAt:'2026-10-21T10:00:00Z',businessName:'Existing garage',sector:'garage' as const,knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:true,recordingPolicy:'off' as const,recordingContactPhone:null}
  const html=renderToStaticMarkup(<ActivityPanel locale="en" state={{workspace:{id:configuration.workspaceId,displayName:'Owner'},configuration,localAudioAvailable:false}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden}/> )
  const global=html.slice(html.indexOf('class="sparra-save-blocker"'),html.indexOf('class="sparra-save-summary"'))
  expect(global).toContain('An old audio setting is saved.')
  expect(global).toContain('Review call settings')
  expect(global).not.toContain('hidden=""')
  expect(html.match(/An old audio setting is saved\./g)).toHaveLength(1)
})
