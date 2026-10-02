import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { RequestDetailDto } from '../../src/modules/sparra/sparra.functions'
import { PrivateUnavailable } from '../../src/ui/sparra/app-shell'
import { appMessages } from '../../src/modules/sparra/messages'

test.each(['fr', 'en'] as const)('private failure retains its announcement and recovery below a localized title in %s', locale => {
  const html = renderToStaticMarkup(<PrivateUnavailable locale={locale} />)
  expect(html).toMatch(new RegExp(`<h1[^>]*>${appMessages[locale].inbox}</h1>`))
  expect(html).toContain('role="alert"')
  expect(html).toContain(appMessages[locale].unavailable)
  expect(html).toContain(`href="/login?lang=${locale}"`)
})

const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}

test.each(['fr', 'en'] as const)('plain contact and end labels retain uncertainty and source information in %s', async locale => {
  const { RequestPanel } = await import('../../src/ui/sparra/request-panel')
  const detail: RequestDetailDto = { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt:'2026-10-01T10:00:00.000Z', endedAt:'2026-10-01T10:01:00.000Z', status:'closed', configurationRevision:null, treatedAt:null, resultAvailability:'available', resultQuality:'partial', category:null, summary:'Test-only partial summary', contact:{name:null,callback_e164:'+33123456789',preference:null,callback_source:'caller',callback_confirmed:false}, nextAction:null, configuration:null, transcript:[], transcriptAvailability:'unavailable', unavailableTurnCount:0, moreTurns:false, transcriptLossCount:0, erasureState:null }
  const html = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  expect(html).toContain('<h3>Contact</h3>')
  expect(html).toContain(locale === 'fr' ? 'Fin détectée:' : 'End detected:')
  expect(html).toContain(appMessages[locale].unconfirmed)
  expect(html).toContain(locale === 'fr' ? 'Numéro déclaré par l’appelant' : 'Number stated by the caller')
  expect(html).toContain(appMessages[locale].partial)
  expect(html).not.toContain(locale === 'fr' ? 'Appel terminé' : 'Call completed')
  const unknown = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:{...detail,endedAt:null},receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  expect(unknown).toContain(appMessages[locale].noEnd)
  expect(unknown).not.toContain(locale === 'fr' ? 'Fin détectée:' : 'End detected:')
})
test('private panels render truthful empty and partial states in FR/EN without invoking mutations',async()=>{
  expect(existsSync('src/ui/sparra/activity-panel.tsx'),'actual business editor required').toBe(true)
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const {InboxPanel}=await import('../../src/ui/sparra/inbox-panel')
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'pending',configurationRevision:null,treatedAt:null,resultAvailability:'unavailable',resultQuality:null,category:null,summary:null,contact:null,nextAction:null,configuration:null,transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null}
  for(const locale of ['fr','en'] as const){
    const activity=renderToStaticMarkup(<ActivityPanel locale={locale} state={{workspace:null,configuration:null}} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/> )
    expect(activity).toContain(locale==='fr'?'Créer mon espace':'Create my workspace')
    expect(activity).not.toContain('textarea')
    const inbox=renderToStaticMarkup(<InboxPanel locale={locale} state={{workspace:null,configuration:null}} page={{requests:[],nextCursor:null}} onMore={unavailable} onRefused={unavailable}/> )
    expect(inbox).toContain(locale==='fr'?'Configurez votre entreprise':'Configure your business')
    const request=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    expect(request).toContain(locale==='fr'?'Transcription indisponible':'Transcript unavailable')
    expect(request).not.toContain('Partial summary')
    expect(request).not.toContain('Call completed')
    const loss=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:{...detail,transcriptLossCount:3},receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    expect(loss).toContain(locale==='fr'?'3 tours capturés perdus':'3 captured turns lost')
    expect(loss).toContain(locale==='fr'?'Transcription indisponible':'Transcript unavailable')
    const receipt=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:null,receipt:{requestId:detail.id,state:'queued'}}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    expect(receipt).toContain(locale==='fr'?'Les autres copies restent à supprimer':'Other copies are awaiting deletion')
    expect(receipt).not.toContain('Mark as treated')
  }
})

test('detail and inbox preserve the translated native category and observed number source in both locales',async()=>{
  const {InboxPanel}=await import('../../src/ui/sparra/inbox-panel')
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  const categories=[['callback','Demande de rappel','Callback request'],['information','Demande d’information','Information request'],['appointment_to_confirm','Rendez-vous à confirmer','Appointment to confirm'],['declared_urgent','Urgence déclarée','Declared urgent request']] as const
  const sources=[['caller','+33123456789','Numéro déclaré par l’appelant','Number stated by the caller'],['provider','+33234567890','Numéro fourni par le fournisseur téléphonique','Number supplied by the phone provider'],['missing',null,'Aucun numéro disponible','No number available']] as const
  for(const locale of ['fr','en'] as const)for(const [category,frCategory,enCategory] of categories)for(const [source,number,frSource,enSource] of sources){
    const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'closing',configurationRevision:null,treatedAt:null,resultAvailability:'available',resultQuality:'partial',category,summary:'Demande fictive',contact:{name:null,callback_e164:number,preference:null,callback_source:source,callback_confirmed:false},nextAction:'Vérifier la demande',configuration:null,transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null}
    const request=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    const inbox=renderToStaticMarkup(<InboxPanel locale={locale} state={{workspace:null,configuration:null}} page={{requests:[detail],nextCursor:null}} onMore={unavailable} onRefused={unavailable}/> )
    for(const html of [request,inbox]){
      expect(html).toContain(locale==='fr'?frCategory:enCategory)
      expect(html).toContain(locale==='fr'?frSource:enSource)
      if(number)expect(html).toContain(number)
      expect(html).toContain(locale==='fr'?'Résumé partiel':'Partial summary')
      expect(html).toContain(locale==='fr'?'Demande et numéro non confirmés.':'Request and number are unconfirmed.')
      expect(html).not.toContain('Appointment booked')
    }
  }
})
