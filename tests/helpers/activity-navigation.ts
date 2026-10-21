import type { Page } from 'playwright'
import { activityMessages } from '../../src/modules/sparra/messages'
import { resolveLocale } from '../../src/ui/auth/messages'

/** Use the actual route locale, including after reloads and FR/EN switches. */
export async function showActivitySection(page:Page,section:'establishment'|'knowledge'|'handling'|'recap'){
  const locale=resolveLocale(new URL(page.url()).searchParams.get('lang'))
  const index=({establishment:0,knowledge:1,handling:2,recap:3} as const)[section]
  const button=page.getByRole('navigation',{name:activityMessages[locale].guidedNavigation,exact:true}).getByRole('button',{name:activityMessages[locale].guidedSections[index],exact:true})
  if(await button.getAttribute('aria-current')!=='step')await button.click()
}
