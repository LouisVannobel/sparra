// Controlled boundaries mount the production panel; this proves no provider or auth behavior.
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { RequestPanel } from '../../src/ui/sparra/request-panel'
import type { ActivityConfigurationDto, ActivityState, RequestDetailDto, SaveActivityInput } from '../../src/modules/sparra/sparra.functions'
import type { Locale } from '../../src/ui/auth/messages'
import '../../src/ui/auth/auth.css'

export const configuration:ActivityConfigurationDto={workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:7,savedAt:'2026-10-26T10:00:00.000Z',businessName:'Current business',sector:'controle-technique',knowledge:{openingHours:'Current hours',services:'Current services',prices:'Current prices',faq:'Current FAQ',instructions:'Current instructions'},transferDestination:'+33123456789',recordingEnabled:false,recordingPolicy:'local_30d',recordingContactPhone:'+33234567890'}
const callConfiguration:ActivityConfigurationDto={...configuration,revision:2,businessName:'Call business',knowledge:{openingHours:'Call hours',services:'Call services',prices:'Call prices',faq:'Call FAQ',instructions:'Call instructions'},transferDestination:null,recordingPolicy:'off',recordingContactPhone:null}
const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:'2026-10-01T10:01:00.000Z',status:'closed',configurationRevision:2,treatedAt:null,resultAvailability:'available',resultQuality:'complete',category:'information',conversationExcerpt:null,summary:'Private call summary',contact:null,nextAction:null,configuration:callConfiguration,transcript:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',ordinal:1,role:'user',text:'Private caller words',interrupted:false,startedAt:'2026-10-01T10:00:00.000Z'}],transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null}
const reads:{signal:AbortSignal;resolve(value:ActivityState|Response):void}[]=[]
const saves:{data:SaveActivityInput;signal:AbortSignal;resolve(value:ActivityConfigurationDto|Response):void;reject(error:Error):void}[]=[]
let refusals=0,treatments=0,erasures=0
const root=createRoot(document.getElementById('root')!)
function render(locale:Locale='en',snapshot=true){root.render(<Theme theme={neutralTheme} mode="light"><div className="sparra-app" style={{gridTemplateColumns:'minmax(0,1fr)'}}><main className="sparra-app-content"><RequestPanel key={locale+snapshot} locale={locale} loaded={{detail:{...detail,configuration:snapshot?callConfiguration:null},receipt:null}}
  onReadActivity={signal=>new Promise(resolve=>{reads.push({signal,resolve})})}
  onSaveActivity={(data,signal)=>new Promise((resolve,reject)=>{saves.push({data,signal,resolve,reject})})}
  onTreat={async()=>{treatments++;return {requestId:detail.id,treatedAt:'2026-10-26T10:01:00.000Z'}}}
  onErase={async()=>{erasures++;return {requestId:detail.id,state:'queued'}}}
  onRefused={async()=>{refusals++}}/></main></div></Theme>)}
const fixture={
  publish:render,
  read(index:number,value:ActivityConfigurationDto|null|number){reads[index].resolve(typeof value==='number'?new Response(null,{status:value}):{workspace:value?{id:value.workspaceId,displayName:'Owned fixture'}:null,configuration:value,localAudioAvailable:true})},
  save(index:number,value:ActivityConfigurationDto|number,error?:'workspace-changed'){saves[index].resolve(typeof value==='number'?new Response(null,{status:value,headers:error?{'x-sparra-activity-error':error}:undefined}):value)},
  reject(index:number){saves[index].reject(new Error('Owned unknown save result'))},
  unmount(){root.unmount()},
  snapshot(){return {reads:reads.map(read=>({aborted:read.signal.aborted})),saves:saves.map(save=>({data:save.data,aborted:save.signal.aborted})),refusals,treatments,erasures}},
}
declare global{interface Window{correctionFixture:typeof fixture}}
window.correctionFixture=fixture
render()
