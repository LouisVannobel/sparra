import {expect,test} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import type {RequestDetailDto} from '../../src/modules/sparra/sparra.functions'
import {RequestPanel} from '../../src/ui/sparra/request-panel'

const noOperation=async():Promise<never>=>{throw new Error('SSR must remain passive')}

test('SSR correction is passive with disabled opening controls in both languages',()=>{
  const detail:RequestDetailDto={workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'closed',configurationRevision:2,treatedAt:null,followUp:{publicationRevision:1,decisionToken:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reviewedRevision:0,declarationActive:false,collectionClosed:true,contentReadable:true,firstDeclaredAt:null},resultAvailability:'unavailable',resultQuality:null,category:null,conversationExcerpt:null,summary:null,contact:null,nextAction:null,configuration:null,transcript:[],transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null,evidence:[],callerPhone:null,collectionGaps:[],audioCoverage:'unknown'}
  for(const locale of ['fr','en'] as const){const html=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onReadActivity={noOperation} onConfirmActivity={noOperation} onLookupActivityConfirmation={noOperation} onTreat={noOperation} onErase={noOperation} onRefused={noOperation}/>);const correction=html.match(/<section class="sparra-request-correction"[\s\S]*?<\/section>/)?.[0]??'';expect(correction).toContain(locale==='fr'?'Examiner un problème':'Review a problem');expect(correction).toMatch(/<button[^>]*disabled/);expect(correction).not.toContain('Current hours')}
})
