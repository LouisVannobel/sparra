import { afterAll,beforeAll,expect,test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer,type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium,type Browser,type Page } from 'playwright'
import type { ActivityConfigurationDto,RequestDetailDto } from '../../src/modules/sparra/sparra.functions'
import type {} from '../helpers/request-correction-fixture'
import { RequestPanel } from '../../src/ui/sparra/request-panel'

const current:ActivityConfigurationDto={workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:7,savedAt:'2026-10-26T10:00:00.000Z',businessName:'Current business',sector:'controle-technique',knowledge:{openingHours:'Current hours',services:'Current services',prices:'Current prices',faq:'Current FAQ',instructions:'Current instructions'},transferDestination:'+33123456789',recordingEnabled:false,recordingPolicy:'local_30d',recordingContactPhone:'+33234567890'}
const saved=(text='Correct hours',revision=8):ActivityConfigurationDto=>({...current,revision,knowledge:{...current.knowledge,openingHours:text}})
let server:ViteDevServer,browser:Browser,origin:string
beforeAll(async()=>{
  server=await createServer({configFile:false,envDir:false,envPrefix:'CORRECTION_FIXTURE_PUBLIC_',plugins:[react()],server:{host:'127.0.0.1',port:0}})
  await server.listen();const address=server.httpServer?.address()
  if(!address||typeof address==='string')throw new Error('Owned correction listener unavailable')
  origin=`http://127.0.0.1:${address.port}`;browser=await chromium.launch({headless:true})
},30000)
afterAll(async()=>{const failures:unknown[]=[];for(const close of [()=>browser?.close(),()=>server?.close()])try{await close()}catch(error){failures.push(error)}if(failures.length)throw new AggregateError(failures,'Owned correction cleanup failed')})
async function mounted(){const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(3000);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin+'/tests/helpers/request-correction-fixture.html');await page.getByRole('button',{name:'Review a problem',exact:true}).waitFor();return {context,page}}
async function count(page:Page,kind:'reads'|'saves',value:number){await expect.poll(()=>page.evaluate(kind=>window.correctionFixture.snapshot()[kind].length,kind)).toBe(value)}
async function read(page:Page,value:ActivityConfigurationDto|null|number=current,index=0){await page.evaluate(({index,value})=>window.correctionFixture.read(index,value),{index,value})}
async function chooseKnowledge(page:Page){await page.getByRole('button',{name:'Review a problem',exact:true}).click();await page.getByRole('button',{name:'Incorrect information or instruction',exact:true}).click();await count(page,'reads',1);await read(page);await page.getByRole('button',{name:'Opening hours',exact:true}).click()}
async function prepare(page:Page,text='Correct hours'){await chooseKnowledge(page);await page.getByRole('textbox',{name:'Proposed text',exact:true}).fill(text);await page.getByRole('button',{name:'Review this change',exact:true}).click()}
async function save(page:Page){await page.getByRole('button',{name:'Save for future calls',exact:true}).click();await count(page,'saves',1)}
const noOperation=async():Promise<never>=>{throw new Error('SSR must remain passive')}

test('SSR correction is passive with disabled opening controls in both languages',()=>{
  const detail:RequestDetailDto={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',admittedAt:'2026-10-01T10:00:00.000Z',endedAt:null,status:'closed',configurationRevision:2,treatedAt:null,resultAvailability:'unavailable',resultQuality:null,category:null,conversationExcerpt:null,summary:null,contact:null,nextAction:null,configuration:null,transcript:[],transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,transcriptLossCount:0,erasureState:null}
  for(const locale of ['fr','en'] as const){const html=renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onReadActivity={noOperation} onSaveActivity={noOperation} onTreat={noOperation} onErase={noOperation} onRefused={noOperation}/>);const correction=html.match(/<section class="sparra-request-correction"[\s\S]*?<\/section>/)?.[0]??'';expect(correction).toContain(locale==='fr'?'Examiner un problème':'Review a problem');expect(correction).toMatch(/<button[^>]*disabled/);expect(correction).not.toContain('Current hours')}
})
test('preparation writes nothing and explicit double confirmation saves only the chosen field from the current base',async()=>{
  const {context,page}=await mounted();try{
    expect((await page.evaluate(()=>window.correctionFixture.snapshot())).reads).toHaveLength(0)
    await prepare(page);expect((await page.evaluate(()=>window.correctionFixture.snapshot())).saves).toHaveLength(0)
    const comparison=page.getByRole('region',{name:'Compare this change',exact:true});expect(await comparison.textContent()).toContain('Current hours');expect(await comparison.textContent()).toContain('Correct hours')
    expect(await page.getByText('Call version: 2',{exact:true}).count()).toBe(1);expect(await page.getByText('Current version: 7',{exact:true}).count()).toBe(1)
    await page.getByRole('button',{name:'Save for future calls',exact:true}).evaluate(button=>{if(!(button instanceof HTMLButtonElement))throw new Error('Expected a save button');button.click();button.click()});await count(page,'saves',1)
    const snapshot=await page.evaluate(()=>window.correctionFixture.snapshot());expect(snapshot.saves[0].data).toEqual({expectedWorkspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedRevision:7,businessName:'Current business',sector:'controle-technique',knowledge:{openingHours:'Correct hours',services:'Current services',prices:'Current prices',faq:'Current FAQ',instructions:'Current instructions'},transferDestination:'+33123456789',recordingEnabled:false,recordingPolicy:'local_30d',recordingContactPhone:'+33234567890'})
    expect(await page.getByRole('button',{name:'Mark as treated',exact:true}).isDisabled()).toBe(true);expect(await page.getByRole('button',{name:'Erase this call',exact:true}).isDisabled()).toBe(true)
    await page.evaluate(value=>window.correctionFixture.save(0,value),saved());await page.getByText('Change saved for future calls.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:/test.*(audio|conversation)/i}).count()).toBe(0)
  }finally{await context.close()}
})
test('returning a field to its call value preserves every other current setting',async()=>{
  const {context,page}=await mounted();try{await chooseKnowledge(page);await page.getByRole('button',{name:'Frequently asked questions',exact:true}).click();await page.getByRole('button',{name:'Use this field’s call value',exact:true}).click();expect(await page.getByRole('textbox',{name:'Proposed text',exact:true}).inputValue()).toBe('Call FAQ');await page.getByRole('button',{name:'Review this change',exact:true}).click();await save(page);const data=(await page.evaluate(()=>window.correctionFixture.snapshot())).saves[0].data;expect(data.businessName).toBe('Current business');expect(data.knowledge).toEqual({openingHours:'Current hours',services:'Current services',prices:'Current prices',faq:'Call FAQ',instructions:'Current instructions'});expect(data.recordingPolicy).toBe('local_30d')}finally{await context.close()}
})
test('a conflict retains the candidate and rereading requires a fresh comparison with the new base',async()=>{
  const {context,page}=await mounted();try{await prepare(page);await save(page);await page.evaluate(()=>window.correctionFixture.save(0,409));await page.getByText('The configuration changed. Read the current version before reviewing again.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Save for future calls',exact:true}).count()).toBe(0);await page.getByRole('button',{name:'Read current version',exact:true}).click();await count(page,'reads',2);await read(page,{...current,revision:9,knowledge:{...current.knowledge,services:'Concurrent service'}},1);expect(await page.getByRole('textbox',{name:'Proposed text',exact:true}).inputValue()).toBe('Correct hours');expect(await page.getByRole('button',{name:'Save for future calls',exact:true}).count()).toBe(0);await page.getByRole('button',{name:'Review this change',exact:true}).click();await page.getByRole('button',{name:'Save for future calls',exact:true}).click();await count(page,'saves',2);const data=(await page.evaluate(()=>window.correctionFixture.snapshot())).saves[1].data;expect(data.expectedRevision).toBe(9);expect(data.knowledge.services).toBe('Concurrent service')}finally{await context.close()}
})
test('an unknown result blocks writes through a failed reread and requires the exact next revision',async()=>{
  const {context,page}=await mounted();try{await prepare(page);await save(page);await page.evaluate(()=>window.correctionFixture.reject(0));await page.getByText('Save outcome unknown. Read the current version before any new save.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Review this change',exact:true}).isDisabled()).toBe(true);await page.getByRole('button',{name:'Read current version',exact:true}).click();await count(page,'reads',2);await read(page,503,1);await page.getByText('Configuration unavailable. Try reading again.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Review this change',exact:true}).isDisabled()).toBe(true);await page.getByRole('button',{name:'Read current version',exact:true}).click();await count(page,'reads',3);await read(page,saved('Correct hours',9),2);await page.getByText('The attempted save could not be confirmed. Review against the current version.',{exact:true}).waitFor();expect(await page.getByText('Change saved for future calls.',{exact:true}).count()).toBe(0);expect((await page.evaluate(()=>window.correctionFixture.snapshot())).saves).toHaveLength(1)}finally{await context.close()}
})
test('an unknown save reread observes a matching next revision without attributing the write',async()=>{
  const {context,page}=await mounted();try{await prepare(page);await save(page);await page.evaluate(()=>window.correctionFixture.reject(0));await page.getByRole('button',{name:'Read current version',exact:true}).click();await count(page,'reads',2);await read(page,saved(),1);await page.getByText('The current version contains the proposed configuration.',{exact:true}).waitFor();expect(await page.getByText('Change saved for future calls.',{exact:true}).count()).toBe(0);expect((await page.evaluate(()=>window.correctionFixture.snapshot())).saves).toHaveLength(1)}finally{await context.close()}
})
test('stopping a save retires its response and keeps reread mandatory before any retry',async()=>{
  const {context,page}=await mounted();try{await prepare(page);await save(page);await page.getByRole('button',{name:'Stop waiting',exact:true}).click();expect((await page.evaluate(()=>window.correctionFixture.snapshot())).saves[0].aborted).toBe(true);await page.evaluate(()=>window.correctionFixture.save(0,401));await page.getByText('Save outcome unknown. Read the current version before any new save.',{exact:true}).waitFor();expect((await page.evaluate(()=>window.correctionFixture.snapshot())).refusals).toBe(0);await page.getByRole('button',{name:'Read current version',exact:true}).click();await count(page,'reads',2);await read(page,current,1);await page.getByRole('button',{name:'Review this change',exact:true}).click();await page.getByRole('button',{name:'Save for future calls',exact:true}).click();await count(page,'saves',2)}finally{await context.close()}
})
test('a current unauthorized operation masks call and correction data and uses the existing refusal path',async()=>{
  const {context,page}=await mounted();try{await prepare(page);await save(page);await page.evaluate(()=>window.correctionFixture.save(0,401));await page.getByRole('link',{name:'Go to sign in',exact:true}).waitFor();expect((await page.evaluate(()=>window.correctionFixture.snapshot())).refusals).toBe(1);expect(await page.locator('#root').textContent()).not.toMatch(/Private call summary|Private caller words|Correct hours|Current business|Call business/)}finally{await context.close()}
})
test('confirmation binds the compared Workspace and a changed authority masks the whole call without rebasing',async()=>{
  const {context,page}=await mounted();try{
    await prepare(page);await save(page)
    expect((await page.evaluate(()=>window.correctionFixture.snapshot())).saves[0].data).toMatchObject({expectedWorkspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedRevision:7})
    await page.evaluate(()=>window.correctionFixture.save(0,409,'workspace-changed'))
    await page.getByRole('link',{name:'Go to sign in',exact:true}).waitFor()
    const snapshot=await page.evaluate(()=>window.correctionFixture.snapshot())
    expect(snapshot.refusals).toBe(1);expect(snapshot.reads).toHaveLength(1);expect(snapshot.saves).toHaveLength(1)
    expect(await page.locator('#root').textContent()).not.toMatch(/Private call summary|Private caller words|Correct hours|Current business|Call business/)
    expect(await page.getByRole('button',{name:'Read current version',exact:true}).count()).toBe(0)
  }finally{await context.close()}
})
test('other symptoms guide diagnosis without reads, writes or a pretend test in French and English',async()=>{
  const {context,page}=await mounted();try{for(const locale of ['en','fr'] as const){await page.evaluate(locale=>window.correctionFixture.publish(locale),locale);await page.getByRole('button',{name:locale==='fr'?'Examiner un problème':'Review a problem',exact:true}).click();for(const label of locale==='fr'?['Transcription','Prononciation','Résumé','Action ou rendez-vous','Cause inconnue']:['Transcription','Pronunciation','Summary','Action or appointment','Unknown cause']){await page.getByRole('button',{name:label,exact:true}).click();await page.getByText(locale==='fr'?'Cette relecture n’est pas un test de conversation ou d’audio.':'This review is not a conversation or audio test.',{exact:true}).waitFor()}expect(await page.getByRole('button',{name:/^(Test|Tester|Retest)/i}).count()).toBe(0)}const snapshot=await page.evaluate(()=>window.correctionFixture.snapshot());expect(snapshot.reads).toHaveLength(0);expect(snapshot.saves).toHaveLength(0)}finally{await context.close()}
})
test('missing current configuration stays read-only, and unmount retires a pending private response',async()=>{
  const {context,page}=await mounted();try{await page.evaluate(()=>window.correctionFixture.publish('en',false));await page.getByRole('button',{name:'Review a problem',exact:true}).click();await page.getByRole('button',{name:'Incorrect information or instruction',exact:true}).click();await count(page,'reads',1);await read(page,null);await page.getByRole('link',{name:'Open business settings',exact:true}).waitFor();expect(await page.getByRole('button',{name:'Save for future calls',exact:true}).count()).toBe(0);await page.getByRole('button',{name:'Read current version',exact:true}).click();await count(page,'reads',2);await page.evaluate(()=>window.correctionFixture.unmount());expect((await page.evaluate(()=>window.correctionFixture.snapshot())).reads[1].aborted).toBe(true);await read(page,401,1);expect((await page.evaluate(()=>window.correctionFixture.snapshot())).refusals).toBe(0);expect(await page.locator('#root').textContent()).toBe('')}finally{await context.close()}
})
