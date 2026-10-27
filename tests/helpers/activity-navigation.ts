import type { Page } from 'playwright'
import { activityMessages } from '../../src/modules/sparra/messages'
import { resolveLocale } from '../../src/ui/auth/messages'

/** Native disabled ends before Astryx's 125ms opacity transition ends. */
export async function waitForActivityNavigation(page:Page){
  await page.locator('.sparra-guided-navigation button').first().click({trial:true})
  await page.waitForFunction(()=>{
    const buttons=document.querySelectorAll<HTMLButtonElement>('.sparra-guided-navigation button')
    return buttons.length===4&&[...buttons].every(button=>!button.disabled&&getComputedStyle(button).opacity==='1')
  })
}

/** Use the actual route locale, including after reloads and FR/EN switches. */
export async function showActivitySection(page:Page,section:'establishment'|'knowledge'|'handling'|'recap'){
  const locale=resolveLocale(new URL(page.url()).searchParams.get('lang'))
  const index=({establishment:0,knowledge:1,handling:2,recap:3} as const)[section]
  const button=page.getByRole('navigation',{name:activityMessages[locale].guidedNavigation,exact:true}).getByRole('button',{name:activityMessages[locale].guidedSections[index],exact:true})
  if(await button.getAttribute('aria-current')!=='step')await button.click()
}

/** Follow the real full-preview and human-attestation step before a test saves. */
export async function reviewActivity(page:Page){
  const save=page.locator('.sparra-business-form .sparra-form-submit')
  const attestation=page.locator('input[name="knowledgeAttestation"]')
  if(!await attestation.isVisible()){
    if(!await save.isEnabled())return
    await save.click()
  }
  if(await attestation.isVisible()&&await attestation.isEnabled())await attestation.check()
}
