import { expect, test } from 'vitest'
import { ActivityPanel } from '../../src/ui/sparra/activity-panel'
import { renderPrivatePanel } from '../helpers/private-panel-router'

test.each(['fr','en'] as const)('published selector and passive questions render in %s without becoming saved knowledge',async locale=>{
  const configuration={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision:1,savedAt:'2026-10-21T10:00:00Z',businessName:'Centre Martin',sector:'controle-technique' as const,knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:'Consigne choisie'},transferDestination:null,recordingEnabled:false,recordingPolicy:'off' as const,recordingContactPhone:null}
  const forbidden=async():Promise<never>=>{throw new Error('Passive hints must not save')}
  const html=await renderPrivatePanel(<ActivityPanel locale={locale} state={{workspace:{id:configuration.workspaceId,displayName:'Owner'},configuration,localAudioAvailable:false}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden}/>,`/app/entreprise?lang=${locale}`)
  expect(html).toContain(locale==='fr'?'Contrôle technique':'Vehicle inspection')
  expect(html).toContain(locale==='fr'?'Quel type de véhicule est concerné ?':'What type of vehicle is concerned?')
  expect(html).toContain('Consigne choisie</textarea>')
  const textareas=html.match(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g)??[]
  expect(textareas).toHaveLength(5)
  expect(textareas.join('')).not.toContain(locale==='fr'?'Quel type de véhicule':'What type of vehicle')
  expect(html).not.toContain('Diagnostic immobilier')
  expect(html).not.toContain('Property diagnostics')
  expect(html).not.toContain('Vidange')
  const values=[...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g)].map(match=>match[1])
  expect(values).toEqual(['','','','','Consigne choisie'])
})

test.each(['fr','en'] as const)('diagnostic selector and passive questions render in %s without becoming saved knowledge',async locale=>{
  const configuration={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision:1,savedAt:'2026-10-21T10:00:00Z',businessName:'Diagnostic Martin',sector:'diagnostic-immobilier' as const,knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:'Consigne choisie'},transferDestination:null,recordingEnabled:false,recordingPolicy:'off' as const,recordingContactPhone:null}
  const forbidden=async():Promise<never>=>{throw new Error('Passive hints must not save')}
  const html=await renderPrivatePanel(<ActivityPanel locale={locale} state={{workspace:{id:configuration.workspaceId,displayName:'Owner'},configuration,localAudioAvailable:false}} onEnsure={forbidden} onSave={forbidden} onRead={forbidden} onRefused={forbidden}/>,`/app/entreprise?lang=${locale}`)
  expect(html).toContain(locale==='fr'?'Diagnostic immobilier':'Property diagnostics')
  expect(html).toContain(locale==='fr'?'Quel type de bien est concerné ?':'What type of property is concerned?')
  const values=[...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g)].map(match=>match[1])
  expect(values).toEqual(['','','','','Consigne choisie'])
  expect(html).toContain(`placeholder="${locale==='fr'?'Établissement Martin':'Martin Business'}"`)
  expect(html).not.toContain('Vidange')
  expect(html).not.toContain('carte grise')
})
