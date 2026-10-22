import { afterAll,beforeAll,expect,test } from 'vitest'
import { createServer,type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium,type Browser } from 'playwright'
let server:ViteDevServer,browser:Browser,origin:string
beforeAll(async()=>{
  server=await createServer({configFile:false,envDir:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}})
  await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('Fixture listener missing')
  origin=`http://127.0.0.1:${address.port}`;browser=await chromium.launch({headless:true})
})
afterAll(async()=>{try{await browser?.close()}finally{await server?.close()}})
test('keyboard selects calendar, edits actual service and hours, and preserves draft after stale revision refusal',async()=>{
  const context=await browser.newContext(),page=await context.newPage()
  page.setDefaultTimeout(5000)
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html')
    const choice=page.getByRole('combobox',{name:'Booking calendar'});await choice.focus();await choice.press('Enter');await page.getByRole('option',{name:'Observed calendar',exact:true}).press('Enter')
    const add=page.getByRole('button',{name:'Add a service',exact:true});await add.focus();await add.press('Enter')
    await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('Vehicle drop-off')
    await page.getByLabel('Duration (minutes) 1',{exact:true}).fill('45')
    const hours=page.getByRole('button',{name:'Add a time range — Monday',exact:true});await hours.focus();await hours.press('Enter')
    await page.getByLabel('Monday Start 1',{exact:true}).fill('09:00');await page.getByLabel('Monday End 1',{exact:true}).fill('12:00')
    const enable=page.getByRole('checkbox',{name:'Enable bookings'});await enable.focus();await enable.press('Space')
    const save=page.getByRole('button',{name:'Save',exact:true});await save.focus();await save.press('Enter')
    await page.getByText('Settings changed or an operation is in progress. Refresh before retrying.').waitFor()
    expect(await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).inputValue()).toBe('Vehicle drop-off')
    expect(JSON.parse(await page.getByLabel('Fixture events').textContent()??'')).toMatchObject({expectedRevision:0,enabled:true,calendarId:'opaque-real-id',policy:{services:[{name:'Vehicle drop-off',durationMinutes:45}],weeklyHours:[{day:1,ranges:[{start:'09:00',end:'12:00'}]}]}})
  }finally{await context.close()}
})
test('keyboard reconnect waits for disconnect before issuing new consent',async()=>{
  const context=await browser.newContext(),page=await context.newPage()
  try{await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=reconnect');const button=page.getByRole('button',{name:'Reconnect Google',exact:true});await button.focus();await button.press('Enter');await page.waitForURL(/#connected$/);expect(await page.getByLabel('Fixture events').textContent()).toBe('disconnect\nconnect')}
  finally{await context.close()}
})
test('keyboard reconnect cannot issue replacement consent while revocation remains unresolved',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=reconnect-blocked')
    const button=page.getByRole('button',{name:'Reconnect Google',exact:true});await button.focus();await button.press('Enter')
    await page.getByText('Settings changed or an operation is in progress. Refresh before retrying.').waitFor()
    expect(await page.getByLabel('Fixture events').textContent()).toBe('disconnect')
    expect(new URL(page.url()).hash).toBe('')
    await button.press('Enter');await expect.poll(()=>page.getByLabel('Fixture events').textContent()).toBe('disconnect\ndisconnect')
    expect(new URL(page.url()).hash).toBe('')
  }finally{await context.close()}
})

test('duplicate calendar summaries expose identity and keyboard selection retains the intended ID',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=duplicates')
    const choice=page.getByRole('combobox',{name:'Booking calendar'});await choice.focus();await choice.press('Enter')
    expect(await page.getByRole('option',{name:'Appointments (calendar-b@example.test)',exact:true}).count()).toBe(1)
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter')
    await expect.poll(()=>choice.textContent()).toContain('Appointments (calendar-b@example.test)')
    await page.getByRole('button',{name:'Add a service',exact:true}).click()
    await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('Vehicle drop-off')
    await page.getByRole('button',{name:'Add a time range — Monday',exact:true}).click()
    await page.getByLabel('Monday Start 1',{exact:true}).fill('09:00');await page.getByLabel('Monday End 1',{exact:true}).fill('12:00')
    const save=page.getByRole('button',{name:'Save',exact:true});await save.focus();await page.keyboard.press('Enter')
    await expect.poll(async()=>page.getByLabel('Fixture events').textContent()).toContain('calendar-b@example.test')
    expect(JSON.parse(await page.getByLabel('Fixture events').textContent()??'')).toMatchObject({calendarId:'calendar-b@example.test'})
  }finally{await context.close()}
})


test.each(['draft-read','draft-conflict','draft-ambiguous'])('%s preserves every edited field and expected revision until explicit replacement',async mode=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode='+mode)
    const choice=page.getByRole('combobox',{name:'Booking calendar'});await choice.click();await page.getByRole('option',{name:'Other calendar',exact:true}).click()
    await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('My draft')
    await page.getByLabel('Duration (minutes) 1',{exact:true}).fill('45')
    await page.getByLabel('Time zone',{exact:false}).fill('Europe/Brussels')
    await page.getByLabel('Monday Start 1',{exact:true}).fill('10:00')
    await page.getByLabel('Buffer after appointment (minutes)',{exact:true}).fill('15')
    await page.getByLabel('Advance notice (minutes)',{exact:true}).fill('120')
    await page.getByRole('checkbox',{name:'Enable bookings'}).check()
    if(mode!=='draft-read'){
      await page.getByRole('button',{name:'Save',exact:true}).click()
      await page.getByText(mode==='draft-conflict'?'Settings changed or an operation is in progress. Refresh before retrying.':'Operation not confirmed. Refresh to check its outcome.').waitFor()
    }
    const writesBeforeRead=(await page.getByLabel('Fixture events').textContent()??'').split('\n').filter(line=>line.startsWith('{')).length
    await page.getByRole('button',{name:'Refresh',exact:true}).click()
    await expect.poll(()=>page.getByLabel('Fixture events').textContent()).toContain('read')
    expect((await page.getByLabel('Fixture events').textContent()??'').split('\n').filter(line=>line.startsWith('{'))).toHaveLength(writesBeforeRead)
    expect(await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).inputValue()).toBe('My draft')
    expect(await page.getByLabel('Duration (minutes) 1',{exact:true}).inputValue()).toBe('45')
    expect(await page.getByLabel('Time zone',{exact:false}).inputValue()).toBe('Europe/Brussels')
    expect(await page.getByLabel('Monday Start 1',{exact:true}).inputValue()).toBe('10:00')
    expect(await page.getByLabel('Buffer after appointment (minutes)',{exact:true}).inputValue()).toBe('15')
    expect(await page.getByLabel('Advance notice (minutes)',{exact:true}).inputValue()).toBe('120')
    expect(await page.getByRole('checkbox',{name:'Enable bookings'}).isChecked()).toBe(true)
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:true,pending:false,reconcile:true,connecting:false})
    await page.getByRole('button',{name:'Save',exact:true}).click()
    await expect.poll(()=>page.getByLabel('Fixture events').textContent()).toContain('expectedRevision')
    const writes=(await page.getByLabel('Fixture events').textContent()??'').split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
    expect(writes.at(-1)).toMatchObject({expectedRevision:3,calendarId:'other-calendar',enabled:true,policy:{services:[{name:'My draft',durationMinutes:45}]}})
    await page.getByText(mode==='draft-ambiguous'?'Operation not confirmed. Refresh to check its outcome.':'Settings changed or an operation is in progress. Refresh before retrying.').waitFor()
    await page.getByRole('button',{name:'Refresh',exact:true}).click()
    await page.getByRole('button',{name:'Use latest settings',exact:true}).click()
    expect(await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).inputValue()).toBe('Latest service')
    expect(await page.getByLabel('Time zone',{exact:false}).inputValue()).toBe('Europe/London')
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:false,pending:false,reconcile:false,connecting:false})
    await page.getByRole('button',{name:'Save',exact:true}).click()
    const replacedWrites=(await page.getByLabel('Fixture events').textContent()??'').split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
    expect(replacedWrites.at(-1).expectedRevision).toBe(7)
  }finally{await context.close()}
})

test('saved feedback clears after policy, activation and calendar edits',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-success')
    const save=page.getByRole('button',{name:'Save',exact:true}),success=page.getByText('Settings saved.',{exact:true})
    for(const edit of [async()=>page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('Changed'),async()=>page.getByRole('checkbox',{name:'Enable bookings'}).check(),async()=>{const choice=page.getByRole('combobox',{name:'Booking calendar'});await choice.click();await page.getByRole('option',{name:'Other calendar',exact:true}).click()}]){
      await save.click();await success.waitFor();await edit();expect(await success.count()).toBe(0)
      await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).dirty).toBe(true)
    }
  }finally{await context.close()}
})

test('connect guard refusal has no action and async navigation publishes connecting only while pending',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=guard')
    await page.getByRole('button',{name:'Reconnect Google',exact:true}).click()
    expect(await page.getByLabel('Fixture events').textContent()).toBe('guard')
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:false,pending:false,reconcile:false,connecting:false})
    await page.getByRole('button',{name:'Allow connect',exact:true}).click()
    await page.getByRole('button',{name:'Reconnect Google',exact:true}).click()
    await expect.poll(()=>page.getByLabel('Fixture events').textContent()).toBe('guard\nguard\ndisconnect\nconnect\nnavigate')
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:false,pending:true,reconcile:false,connecting:true})
    await page.getByRole('button',{name:'Finish navigation',exact:true}).click()
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).connecting).toBe(false)
  }finally{await context.close()}
})


test('an uncertain save requires a successful observation before latest adoption; a failed read creates no uncertainty',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-ambiguous')
    await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('Still mine')
    await page.getByRole('button',{name:'Save',exact:true}).click()
    await page.getByText('Operation not confirmed. Refresh to check its outcome.').waitFor()
    expect(await page.getByRole('button',{name:'Use latest settings',exact:true}).count()).toBe(0)
    await page.getByRole('button',{name:'Refresh',exact:true}).click()
    await page.getByRole('button',{name:'Use latest settings',exact:true}).waitFor()
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-ambiguous-read-failed')
    await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('Keep after read failure')
    await page.getByRole('button',{name:'Save',exact:true}).click()
    await page.getByText('Operation not confirmed. Refresh to check its outcome.').waitFor()
    await page.getByRole('button',{name:'Refresh',exact:true}).click()
    await page.getByText('Operation not confirmed. Refresh to check its outcome.').waitFor()
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).reconcile).toBe(true)
    expect(await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).inputValue()).toBe('Keep after read failure')
    expect(await page.getByRole('button',{name:'Use latest settings',exact:true}).count()).toBe(0)
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-read-failed')
    await page.getByRole('button',{name:'Refresh',exact:true}).click()
    await page.getByText('Operation not confirmed. Refresh to check its outcome.').waitFor()
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:false,pending:false,reconcile:false,connecting:false})
  }finally{await context.close()}
})


test('French refresh preserves prepared inputs until explicit adoption',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-read&locale=fr')
    await page.getByRole('textbox',{name:'Prestation 1 Required',exact:true}).fill('Mon brouillon')
    await page.getByRole('button',{name:'Actualiser',exact:true}).click()
    await page.getByRole('button',{name:'Utiliser les derniers réglages',exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:'Prestation 1 Required',exact:true}).inputValue()).toBe('Mon brouillon')
    expect(await page.getByLabel('Fixture events').textContent()).toBe('read')
    await page.getByRole('button',{name:'Utiliser les derniers réglages',exact:true}).click()
    expect(await page.getByRole('textbox',{name:'Prestation 1 Required',exact:true}).inputValue()).toBe('Latest service')
    expect(await page.getByLabel('Fixture events').textContent()).toBe('read')
  }finally{await context.close()}
})


test('an identical read after ambiguous save preserves uncertainty until explicit adoption',async()=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-ambiguous-identical')
    await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).fill('Uncertain draft')
    const save=page.getByRole('button',{name:'Save',exact:true}),read=page.getByRole('button',{name:'Refresh',exact:true})
    await save.click();await page.getByText('Operation not confirmed. Refresh to check its outcome.').waitFor()
    await read.click();await page.getByRole('button',{name:'Use latest settings',exact:true}).waitFor()
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:true,pending:false,reconcile:true,connecting:false})
    expect(await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).inputValue()).toBe('Uncertain draft')
    await save.click();await page.getByText('Operation not confirmed. Refresh to check its outcome.').waitFor()
    const writes=(await page.getByLabel('Fixture events').textContent()??'').split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({expectedRevision:3,policy:{services:[{name:'Uncertain draft'}]}})
    await read.click();await page.getByRole('button',{name:'Use latest settings',exact:true}).click()
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText())).toEqual({dirty:false,pending:false,reconcile:false,connecting:false})
    expect(await page.getByRole('textbox',{name:'Service 1 Required',exact:true}).inputValue()).toBe('Known service')
    expect((await page.getByLabel('Fixture events').textContent()??'').split('\n').filter(line=>line.startsWith('{'))).toHaveLength(2)
  }finally{await context.close()}
})

test.each(['en','fr'] as const)('%s visibly identifies dirty Calendar edits and returns to pristine when restored',async locale=>{
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(5000)
  try{
    await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=draft-success&locale='+locale)
    const unsaved=page.getByText(locale==='fr'?'Modifications non enregistrées.':'Unsaved changes.',{exact:true})
    const service=page.getByRole('textbox',{name:locale==='fr'?'Prestation 1 Required':'Service 1 Required',exact:true})
    const enabled=page.getByRole('checkbox',{name:locale==='fr'?'Activer les réservations':'Enable bookings'})
    const choice=page.getByRole('combobox',{name:locale==='fr'?'Agenda de réservation':'Booking calendar'})
    const select=async(name:string)=>{await choice.click();await page.getByRole('option',{name,exact:true}).click()}
    expect(await unsaved.count()).toBe(0)
    for(const [edit,restore] of [
      [async()=>service.fill('Changed service'),async()=>service.fill('Known service')],
      [async()=>enabled.check(),async()=>enabled.uncheck()],
      [async()=>select('Other calendar'),async()=>select('Observed calendar')],
    ]){
      await edit!();await unsaved.waitFor();await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).dirty).toBe(true)
      await restore!();expect(await unsaved.count()).toBe(0);await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).dirty).toBe(false)
    }
    expect(await page.getByLabel('Fixture events').textContent()).toBe('')
    await service.fill('Saved service');await unsaved.waitFor()
    await page.getByRole('button',{name:locale==='fr'?'Enregistrer':'Save',exact:true}).click()
    await page.getByText(locale==='fr'?'Réglages enregistrés.':'Settings saved.',{exact:true}).waitFor()
    expect(await unsaved.count()).toBe(0)
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).dirty).toBe(false)
    await service.fill('Discarded service');await unsaved.waitFor()
    await page.getByRole('button',{name:locale==='fr'?'Utiliser les derniers réglages':'Use latest settings',exact:true}).click()
    expect(await unsaved.count()).toBe(0)
    await expect.poll(async()=>JSON.parse(await page.getByLabel('Navigation state').innerText()).dirty).toBe(false)
  }finally{await context.close()}
})
