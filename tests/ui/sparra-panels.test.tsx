import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { RequestDetailDto } from '../../src/modules/sparra/sparra.functions'

const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}
test('private panels render truthful empty and partial states in FR/EN without invoking mutations',async()=>{
  expect(existsSync('src/ui/sparra/activity-panel.tsx'),'actual business editor required').toBe(true)
  const {ActivityPanel}=await import('../../src/ui/sparra/activity-panel')
  const {InboxPanel}=await import('../../src/ui/sparra/inbox-panel')
  const {RequestPanel}=await import('../../src/ui/sparra/request-panel')
  const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'pending',configurationRevision:null,treatedAt:null,resultAvailability:'unavailable',resultQuality:null,category:null,summary:null,contact:null,nextAction:null,configuration:null,transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:0,moreTurns:false,erasureState:null}
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
    const receipt=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:null,receipt:{requestId:detail.id,state:'queued'}}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable}/> )
    expect(receipt).toContain(locale==='fr'?'Les autres copies restent à supprimer':'Other copies are awaiting deletion')
    expect(receipt).not.toContain('Mark as treated')
  }
})
