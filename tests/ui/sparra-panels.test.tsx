import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { ActivityState, RequestDetailDto } from '../../src/modules/sparra/sparra.functions'

const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}
test('configured activity SSR preserves the observed revision, editor values and disabled actions in both locales',async()=>{
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const state:ActivityState={workspace:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Observed workspace'},localAudioAvailable:false,configuration:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:7,savedAt:'2026-10-01T10:00:00.000Z',businessName:'Observed inspection centre',sector:'controle-technique',knowledge:{openingHours:'09:00–17:00',services:'Vehicle inspection',prices:'80 euros',faq:'Bring the vehicle papers',instructions:'Ask before proceeding'},transferDestination:null,recordingPolicy:'off',recordingContactPhone:null}}
  for(const locale of ['fr','en'] as const){
    const html=renderToStaticMarkup(<ActivityPanel locale={locale} state={state} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/> )
    expect(html).toMatch(new RegExp('<p\\b[^>]*>'+(locale==='fr'?'Version enregistrée':'Saved version')+': 7</p>'))
    expect(html).toContain('value="Observed inspection centre"')
    expect(html).toContain(locale==='fr'?'Contrôle technique':'Vehicle inspection')
    const inputs=[...html.matchAll(/<input\b([^>]*)>/g)]
    expect(inputs).toHaveLength(4)
    expect(inputs[0]?.[1]).toContain('aria-required="true"')
    expect(inputs[1]?.[1]).toContain('value=""')
    const areas=[...html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)]
    expect(areas.map(area=>area[2])).toEqual(['09:00–17:00','Vehicle inspection','80 euros','Bring the vehicle papers','Ask before proceeding'])
    const labels=locale==='fr'?['Horaires','Prestations','Tarifs','Questions fréquentes','Consignes de réponse']:['Opening hours','Services','Prices','Frequently asked questions','Response instructions']
    for(const label of labels)expect(html).toContain(label)
    const controls=[...html.matchAll(/<(?:input|textarea|button)\b([^>]*)>/g)]
    expect(controls).toHaveLength(11)
    for(const control of controls)expect(control[1]).toContain('disabled=""')
    expect(html).not.toContain(locale==='fr'?'Configuration enregistrée.':'Configuration saved.')
    expect(html).not.toContain(locale==='fr'?'Créer mon espace':'Create my workspace')
  }
})

test('private panels render truthful empty and partial states in FR/EN without invoking mutations',async()=>{
  expect(existsSync('src/ui/sparra/activity-panel.tsx'),'actual business editor required').toBe(true)
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const {InboxPanel}=await import('../../src/ui/sparra/inbox-panel')
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'pending',configurationRevision:null,treatedAt:null,resultAvailability:'unavailable',resultQuality:null,category:null,summary:null,contact:null,nextAction:null,configuration:null,transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null}
  for(const locale of ['fr','en'] as const){
    const activity=renderToStaticMarkup(<ActivityPanel locale={locale} state={{workspace:null,configuration:null,localAudioAvailable:false}} onEnsure={unavailable} onSave={unavailable} onRead={unavailable} onRefused={unavailable}/> )
    expect(activity).toContain(locale==='fr'?'Créer mon espace':'Create my workspace')
    expect(activity).not.toContain('textarea')
    const inbox=renderToStaticMarkup(<InboxPanel locale={locale} state={{workspace:null,configuration:null,localAudioAvailable:false}} page={{requests:[],nextCursor:null}} onMore={unavailable} onRefused={unavailable}/> )
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

// fallow-ignore-next-line complexity -- reviewed SSR A; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003
test('detail and inbox preserve the translated native category and observed number source in both locales',async()=>{
  const {InboxPanel}=await import('../../src/ui/sparra/inbox-panel')
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  const categories=[['callback','Demande de rappel','Callback request'],['information','Demande d’information','Information request'],['appointment_to_confirm','Rendez-vous à confirmer','Appointment to confirm'],['declared_urgent','Urgence déclarée','Declared urgent request']] as const
  const sources=[['caller','+33123456789','Numéro déclaré par l’appelant','Number stated by the caller'],['provider','+33234567890','Numéro fourni par le fournisseur téléphonique','Number supplied by the phone provider'],['missing',null,'Aucun numéro disponible','No number available']] as const
  for(const locale of ['fr','en'] as const)for(const [category,frCategory,enCategory] of categories)for(const [source,number,frSource,enSource] of sources){
    const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'closing',configurationRevision:null,treatedAt:null,resultAvailability:'available',resultQuality:'partial',category,summary:'Demande fictive',contact:{name:null,callback_e164:number,preference:null,callback_source:source,callback_confirmed:false},nextAction:'Vérifier la demande',configuration:null,transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null}
    const request=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    const inbox=renderToStaticMarkup(<InboxPanel locale={locale} state={{workspace:null,configuration:null,localAudioAvailable:false}} page={{requests:[detail],nextCursor:null}} onMore={unavailable} onRefused={unavailable}/> )
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

const requestDetail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:'2026-10-01T10:03:00.000Z',status:'closed',configurationRevision:7,treatedAt:null,resultAvailability:'available',resultQuality:'partial',category:'information',summary:'Observed request text',contact:{name:'Camille',callback_e164:'+33123456789',preference:'Afternoon',callback_source:'caller',callback_confirmed:false},nextAction:'Check the request',configuration:{workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:7,savedAt:'2026-09-30T10:00:00.000Z',businessName:'Pinned garage',sector:'garage',knowledge:{openingHours:'09:00–17:00',services:'Oil change',prices:'',faq:'Bring the vehicle papers',instructions:'Ask before proceeding'},transferDestination:null,recordingPolicy:'off',recordingContactPhone:null},transcript:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',ordinal:1,role:'user',text:'Caller turn',interrupted:false,startedAt:'2026-10-01T10:00:00.000Z'},{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',ordinal:2,role:'assistant',text:'Assistant turn',interrupted:true,startedAt:'2026-10-01T10:01:00.000Z'}],transcriptAvailability:'partial',unavailableTurnCount:2,moreTurns:true,transcriptLossCount:3,erasureState:null}

// fallow-ignore-next-line complexity -- reviewed SSR B; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003
test('request detail keeps observed metadata, ordered partial turns, pinned knowledge and disabled SSR actions in both locales',async()=>{
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  for(const locale of ['fr','en'] as const){
    const html=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:requestDetail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    expect(html).toContain('<time dateTime="2026-10-01T10:00:00.000Z">')
    expect(html).toContain(locale==='fr'?'Fin détectée: 1 oct. 2026, 12:03':'End detected: Oct 1, 2026, 12:03 PM')
    expect(html).toContain(locale==='fr'?'aria-label="Résumé"':'aria-label="Summary"')
    for(const text of ['Observed request text','Check the request','Camille — +33123456789 — Afternoon'])expect(html).toContain(text)
    expect(html).toContain(locale==='fr'?'Transcription partielle: 2 tours indisponibles.':'Partial transcript: 2 unavailable turns.')
    expect(html).toContain(locale==='fr'?'3 tours capturés perdus.':'3 captured turns lost.')
    expect(html).toContain(locale==='fr'?'La transcription affichée est limitée aux 200 premiers tours.':'The displayed transcript is limited to the first 200 turns.')
    expect(html).toContain('<ol class="sparra-call-transcript"><li><p><strong>'+(locale==='fr'?'Appelant':'Caller')+'</strong></p><p>Caller turn</p></li><li><p><strong>Sparra</strong> — '+(locale==='fr'?'Interrompu':'Interrupted')+'</p><p>Assistant turn</p></li></ol>')
    expect(html).toContain(locale==='fr'?'Pinned garage — Version enregistrée 7':'Pinned garage — Saved version 7')
    expect(html.match(/<dt>/g)).toHaveLength(5)
    for(const text of ['09:00–17:00','Oil change','Bring the vehicle papers','Ask before proceeding'])expect(html).toContain('<dd>'+text+'</dd>')
    expect(html).toContain('<dt>'+(locale==='fr'?'Tarifs':'Prices')+'</dt><dd>—</dd>')
    const buttons=[...html.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)]
    expect(buttons).toHaveLength(2)
    for(const button of buttons)expect(button[1]).toContain('disabled=""')
  }
})

// fallow-ignore-next-line complexity -- reviewed SSR C; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003
test('request detail retains empty contact and absent snapshot fallbacks without treating complete quality as partial',async()=>{
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  for(const locale of ['fr','en'] as const){
    const detail:RequestDetailDto={...requestDetail,resultQuality:'complete',summary:null,category:null,nextAction:null,contact:{name:null,callback_e164:null,preference:null,callback_source:'missing',callback_confirmed:false},configuration:null,transcript:[],transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,treatedAt:'2026-10-01T11:00:00.000Z'}
    const html=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    expect(html).toContain(locale==='fr'?'Résumé indisponible':'Summary unavailable')
    expect(html).not.toContain(locale==='fr'?'Résumé partiel':'Partial summary')
    expect(html).toContain('<h3>Contact</h3><p>—</p>')
    expect(html).toContain(locale==='fr'?'Aucun numéro disponible':'No number available')
    expect(html).toContain(locale==='fr'?'Configuration non associée à cet appel.':'No configuration is associated with this call.')
    expect(html).toContain('<ol class="sparra-call-transcript"></ol>')
    expect(html).not.toContain(locale==='fr'?'Transcription indisponible':'Transcript unavailable')
    expect(html).not.toContain(locale==='fr'?'Transcription partielle':'Partial transcript')
    expect(html).not.toContain('<dl>')
    expect(html).toContain('<p role="status">'+(locale==='fr'?'Traité':'Treated')+'</p>')
    expect(html).not.toContain(locale==='fr'?'Marquer comme traité':'Mark as treated')
  }
})

// fallow-ignore-next-line complexity -- reviewed SSR D; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003
test('queued and completed erasure receipts take precedence over loaded private detail in both locales',async()=>{
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  for(const locale of ['fr','en'] as const)for(const state of ['queued','completed'] as const){
    const html=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:requestDetail,receipt:{requestId:requestDetail.id,state}}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    const text=state==='queued'?(locale==='fr'?'Effacement en attente. Les autres copies restent à supprimer.':'Erasure queued. Other copies are awaiting deletion.'):(locale==='fr'?'Effacement terminé.':'Erasure completed.')
    expect(html).toContain('<p role="status">'+text+'</p>')
    for(const privateText of ['Observed request text','Caller turn','Pinned garage','+33123456789'])expect(html).not.toContain(privateText)
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<section')
  }
})
