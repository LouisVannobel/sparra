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
    expect(JSON.parse(await page.getByLabel('Fixture events').innerText())).toMatchObject({expectedRevision:0,enabled:true,calendarId:'opaque-real-id',policy:{services:[{name:'Vehicle drop-off',durationMinutes:45}],weeklyHours:[{day:1,ranges:[{start:'09:00',end:'12:00'}]}]}})
  }finally{await context.close()}
})
test('keyboard reconnect waits for disconnect before issuing new consent',async()=>{
  const context=await browser.newContext(),page=await context.newPage()
  try{await page.goto(origin+'/tests/helpers/calendar-panel.html?mode=reconnect');const button=page.getByRole('button',{name:'Reconnect Google',exact:true});await button.focus();await button.press('Enter');await page.waitForURL(/#connected$/);expect(await page.getByLabel('Fixture events').textContent()).toBe('disconnect\nconnect')}
  finally{await context.close()}
})
