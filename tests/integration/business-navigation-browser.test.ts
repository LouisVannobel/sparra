import { afterAll,beforeAll,expect,test } from 'vitest'
import { type Page } from 'playwright'
import { activityMessages } from '../../src/modules/sparra/messages'
import { getSectorPreset } from '../../src/modules/sparra/sectors'
import { createGuidedBrowserFixture } from '../helpers/guided-browser-coverage'
const fixture=createGuidedBrowserFixture('business-navigation')
let origin:string
beforeAll(async()=>{await fixture.start();origin=fixture.origin})
afterAll(async()=>{await fixture.close()})
async function open(mode='',lang:'fr'|'en'='fr'){
  const {context,page}=await fixture.newPage();page.setDefaultTimeout(5000)
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
  await page.goto(origin+'/tests/helpers/business-navigation.html?lang='+lang+'&mode='+mode)
  await page.getByRole('textbox',{name:new RegExp('^'+activityMessages[lang].businessName)}).waitFor()
  return {context,page}
}
async function section(page:Page,index:number,lang:'fr'|'en'='fr'){await page.getByRole('button',{name:activityMessages[lang].guidedSections[index],exact:true}).click()}
async function declineLanguage(page:Page){
  let dialogs=0
  const declined=page.waitForEvent('dialog')
  await Promise.all([page.getByRole('link',{name:'Language',exact:true}).click(),declined.then(async dialog=>{dialogs++;expect(dialog.type()).toBe('confirm');await dialog.dismiss()})])
  expect(dialogs).toBe(1);expect(new URL(page.url()).searchParams.get('lang')).toBe('fr')
}
test('immediate edit then language decline retains draft; accepted departure explicitly abandons it',async()=>{
  const {context,page}=await open();try{
    const name=page.getByRole('textbox',{name:/^Nom de l’établissement/});await name.fill('Draft name');await declineLanguage(page);expect(await name.inputValue()).toBe('Draft name')
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('link',{name:'Language'}).click();await page.waitForURL(/lang=en/)
    expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('Garage known')
  }finally{await fixture.closePage(context,page)}
})
test('all prepared FAQ answers survive sections, old sector and saved enterprise state',async()=>{
  const {context,page}=await open();try{
    await section(page,1);const question=getSectorPreset('garage','fr').faqQuestions[0]!
    await page.getByRole('button',{name:question,exact:true}).click();await page.getByRole('textbox',{name:activityMessages.fr.ownerAnswer,exact:true}).fill('Prepared garage answer')
    await section(page,0);await page.getByRole('combobox',{name:/^Secteur/}).click();await page.getByRole('option',{name:getSectorPreset('controle-technique','fr').label,exact:true}).click()
    await section(page,1);await page.getByRole('button',{name:getSectorPreset('controle-technique','fr').faqQuestions[0]!,exact:true}).click()
    await page.locator('.sparra-business-form').getByRole('button',{name:'Enregistrer',exact:true}).click();await page.getByText('Configuration enregistrée.',{exact:true}).waitFor()
    await declineLanguage(page);await section(page,0);await page.getByRole('combobox',{name:/^Secteur/}).click();await page.getByRole('option',{name:'Garage',exact:true}).click();await section(page,1);await page.getByRole('button',{name:question,exact:true}).click()
    expect(await page.getByRole('textbox',{name:activityMessages.fr.ownerAnswer,exact:true}).inputValue()).toBe('Prepared garage answer')
    expect(await page.getByLabel('Fixture events').textContent()).toBe('activity-save')
  }finally{await fixture.closePage(context,page)}
})
test.each(['pristine','restored','saved','empty'])('%s enterprise form leaves without a prompt',async mode=>{
  const {context,page}=await open(mode);try{
    const name=page.getByRole('textbox',{name:/^Nom de l’établissement/})
    if(mode==='restored'){await name.fill('Edit');await name.fill('Garage known')}
    if(mode==='saved'){await name.fill('Saved');await page.locator('.sparra-business-form').getByRole('button',{name:'Enregistrer',exact:true}).click();await page.getByText('Configuration enregistrée.',{exact:true}).waitFor()}
    let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss()});await page.getByRole('link',{name:'Language'}).click();await page.waitForURL(/lang=en/);expect(dialogs).toBe(0)
  }finally{await fixture.closePage(context,page)}
})
test('Calendar-only edits survive read until explicit replacement and protect language departure',async()=>{
  const {context,page}=await open();try{
    await section(page,2);await page.getByRole('textbox',{name:'Prestation 1 Required',exact:true}).fill('Calendar draft')
    await declineLanguage(page);await page.getByRole('button',{name:'Actualiser',exact:true}).click();await page.getByRole('button',{name:'Utiliser les derniers réglages',exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:'Prestation 1 Required',exact:true}).inputValue()).toBe('Calendar draft');await declineLanguage(page)
    await page.getByRole('button',{name:'Utiliser les derniers réglages',exact:true}).click();await page.getByRole('link',{name:'Language'}).click();await page.waitForURL(/lang=en/)
    expect(await page.getByLabel('Fixture events').textContent()).toBe('calendar-read')
  }finally{await fixture.closePage(context,page)}
})
test.each(['activity-pending','uncertain','calendar-read-held'])('%s refuses OAuth before disconnect or consent',async mode=>{
  const {context,page}=await open(mode);try{
    if(mode==='calendar-read-held'){await section(page,2);await page.getByRole('button',{name:'Actualiser',exact:true}).click()}
    else{await page.getByRole('textbox',{name:/^Nom de l’établissement/}).fill('Draft');await page.locator('.sparra-business-form').getByRole('button',{name:'Enregistrer',exact:true}).click();if(mode==='uncertain')await page.getByRole('alert').filter({hasText:'Le résultat'}).waitFor();await section(page,2)}
    if(mode==='calendar-read-held')expect(await page.getByRole('button',{name:'Reconnecter Google',exact:true}).isDisabled()).toBe(true)
    else{await page.getByRole('button',{name:'Reconnecter Google',exact:true}).click();await page.getByRole('alert').filter({hasText:'Google'}).waitFor()}
    expect(await page.getByLabel('Fixture events').textContent()).toBe(mode==='calendar-read-held'?'calendar-read':'activity-save')
  }finally{await fixture.closePage(context,page)}
})
test.each(['connect-held','connect-reject'])('%s locks enterprise edits only during approved OAuth preparation',async mode=>{
  const {context,page}=await open(mode);try{
    const name=page.getByRole('textbox',{includeHidden:true,name:/^Nom de l’établissement/});await name.fill('Kept work');await section(page,2)
    let prompts=0;page.on('dialog',async dialog=>{prompts++;await dialog.accept()});await page.getByRole('button',{name:'Reconnecter Google',exact:true}).click()
    await expect.poll(()=>page.getByLabel('Fixture events').textContent()).toBe('disconnect\nconnect');await section(page,0);expect(await name.isDisabled()).toBe(true);expect(await page.locator('.sparra-business-form').getByRole('button',{name:'Enregistrer',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('button',{name:'Release operation'}).click()
    if(mode==='connect-held'){await page.waitForURL(/mode=arrived/);expect(prompts).toBe(1)}
    else{await expect.poll(()=>name.isEnabled()).toBe(true);expect(await name.inputValue()).toBe('Kept work');page.removeAllListeners('dialog');await declineLanguage(page)}
  }finally{await fixture.closePage(context,page)}
})
test('OAuth decline makes zero effects; ordinary login is guarded and explicit auth refusal recovers',async()=>{
  const {context,page}=await open('refused');try{
    await page.getByRole('textbox',{name:/^Nom de l’établissement/}).fill('Private draft');await section(page,2)
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Reconnecter Google',exact:true}).click();expect(await page.getByLabel('Fixture events').textContent()).toBe('')
    let prompts=0;page.once('dialog',async dialog=>{prompts++;await dialog.dismiss()});await page.getByRole('link',{name:'Ordinary login'}).click();expect(prompts).toBe(1);expect(new URL(page.url()).pathname).toContain('business-navigation')
    page.on('dialog',async dialog=>{prompts++;await dialog.dismiss()});await page.locator('.sparra-business-form').getByRole('button',{name:'Enregistrer',exact:true}).click();await page.getByRole('heading',{name:'Login recovery'}).waitFor();expect(prompts).toBe(1)
  }finally{await fixture.closePage(context,page)}
  const calendar=await open();try{
    await section(calendar.page,2)
    const service=calendar.page.getByRole('textbox',{name:'Prestation 1 Required',exact:true})
    let prompts=0;calendar.page.once('dialog',async dialog=>{prompts++;expect(dialog.type()).toBe('confirm');await dialog.dismiss()})
    await service.fill('Calendar OAuth draft')
    await calendar.page.getByRole('button',{name:'Reconnecter Google',exact:true}).click()
    expect(prompts).toBe(1)
    expect(await calendar.page.getByLabel('Fixture events').textContent()).toBe('')
    expect(await service.inputValue()).toBe('Calendar OAuth draft')
    expect(new URL(calendar.page.url()).pathname).toContain('business-navigation')
  }finally{await fixture.closePage(calendar.context,calendar.page)}
})
test('document departure uses native beforeunload and declining retains work',async()=>{
  for(const source of ['enterprise','calendar']){
    const {context,page}=await open();try{
      if(source==='calendar')await section(page,2)
      const field=page.getByRole('textbox',source==='calendar'?{name:'Prestation 1 Required',exact:true}:{name:/^Nom de l’établissement/})
      let prompts=0;page.once('dialog',async dialog=>{prompts++;expect(dialog.type()).toBe('beforeunload');await dialog.dismiss()})
      await field.fill('Document draft')
      await page.getByRole('link',{name:'Document',exact:true}).click()
      expect(prompts).toBe(1);expect(await field.inputValue()).toBe('Document draft')
      expect(new URL(page.url()).pathname).toContain('business-navigation')
      expect(await page.getByLabel('Fixture events').textContent()).toBe('')
    }finally{await fixture.closePage(context,page)}
  }
})

test('Calendar uncertainty refuses OAuth; ordinary Calendar read and save keep enterprise independently editable',async()=>{
  for(const mode of ['calendar-uncertain','calendar-read-held','calendar-save-held']){
    const {context,page}=await open(mode);try{
      await section(page,2)
      if(mode==='calendar-read-held')await page.getByRole('button',{name:'Actualiser',exact:true}).click()
      else{await page.getByRole('textbox',{name:'Prestation 1 Required',exact:true}).fill('Changed service');await page.locator('.sparra-guided-calendar').getByRole('button',{name:'Enregistrer',exact:true}).click()}
      if(mode==='calendar-uncertain'){
        await page.getByText('Opération non confirmée. Actualisez pour vérifier son résultat.',{exact:true}).waitFor()
        await page.getByRole('button',{name:'Reconnecter Google',exact:true}).click();await page.getByRole('alert').filter({hasText:'Google'}).waitFor()
        expect(await page.getByLabel('Fixture events').textContent()).toBe('calendar-save')
      }
      await section(page,0);const name=page.getByRole('textbox',{name:/^Nom de l’établissement/});expect(await name.isEnabled()).toBe(true);await name.fill('Independent enterprise save')
      await page.locator('.sparra-business-form').getByRole('button',{name:'Enregistrer',exact:true}).click();await page.getByText('Configuration enregistrée.',{exact:true}).waitFor()
      expect(await page.getByLabel('Fixture events').textContent()).toBe((mode==='calendar-read-held'?'calendar-read':'calendar-save')+'\nactivity-save')
      if(mode!=='calendar-uncertain')await page.getByRole('button',{name:'Release operation'}).click()
    }finally{await fixture.closePage(context,page)}
  }
})

test('whitespace FAQ work and added answers remain protected, while guided sections never request abandonment',async()=>{
  const {context,page}=await open();try{
    let dialogs=0;const dismiss=async(dialog:import('playwright').Dialog)=>{dialogs++;await dialog.dismiss()};page.on('dialog',dismiss)
    await section(page,1);await page.getByRole('button',{name:getSectorPreset('garage','fr').faqQuestions[0]!,exact:true}).click();await page.getByRole('textbox',{name:activityMessages.fr.ownerAnswer,exact:true}).fill('   ')
    for(const index of [2,3,0,1])await section(page,index)
    expect(dialogs).toBe(0);page.off('dialog',dismiss);await declineLanguage(page)
    await page.getByRole('textbox',{name:activityMessages.fr.ownerAnswer,exact:true}).fill('Added answer');await page.getByRole('button',{name:activityMessages.fr.addOwnerAnswer,exact:true}).click();await declineLanguage(page)
    expect(await page.getByRole('textbox',{name:activityMessages.fr.faq,exact:true}).inputValue()).toContain('Added answer')
  }finally{await fixture.closePage(context,page)}
})

test('pending OAuth retains beforeunload guard and SPA departure remains guarded after rejection',async()=>{
  const {context,page}=await open('connect-reject');try{
    await page.getByRole('textbox',{name:/^Nom de l’établissement/}).fill('Still guarded');await section(page,2)
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reconnecter Google',exact:true}).click();await expect.poll(()=>page.getByLabel('Fixture events').textContent()).toBe('disconnect\nconnect')
    let native=0;page.once('dialog',async dialog=>{native++;expect(dialog.type()).toBe('beforeunload');await dialog.dismiss()});await page.getByRole('link',{name:'Document',exact:true}).click();expect(native).toBe(1)
    await page.getByRole('button',{name:'Release operation'}).click();await expect.poll(()=>page.getByRole('button',{name:'Reconnecter Google',exact:true}).isEnabled()).toBe(true)
    let spa=0;page.once('dialog',async dialog=>{spa++;await dialog.dismiss()});await page.getByRole('link',{name:'Other page',exact:true}).click();expect(spa).toBe(1);expect(new URL(page.url()).pathname).toContain('business-navigation')
  }finally{await fixture.closePage(context,page)}
})
