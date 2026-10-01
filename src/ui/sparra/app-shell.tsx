import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Icon } from '@astryxdesign/core/Icon'
import { appMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'

export function AppShell({locale,children}:{locale:Locale;children:ReactNode}){
  const t=appMessages[locale]
  return <div className="sparra-app"><a className="sparra-app-skip" href="#app-content">{locale==='fr'?'Aller au contenu':'Skip to content'}</a>
    <header className="sparra-app-header"><a className="sparra-app-brand" href={`/app?lang=${locale}`}>sparra<span>.</span></a><span className="sparra-app-label"><Icon icon="info" aria-hidden="true"/>{t.pilot}</span></header>
    <nav className="sparra-app-nav" aria-label={locale==='fr'?'Navigation principale':'Main navigation'}><Link to="/app" search={{lang:locale}}>{t.inbox}</Link><Link to="/app/entreprise" search={{lang:locale}}>{t.business}</Link><Link to="/account" search={{lang:locale,firstPasskey:undefined,googleAccount:undefined}}>{t.account}</Link></nav>
    <main id="app-content" className="sparra-app-content">{children}</main>
  </div>
}
export function PrivateUnavailable({locale}:{locale:Locale}){return <><p role="alert">{appMessages[locale].unavailable}</p><a href={`/login?lang=${locale}`}>{appMessages[locale].login}</a></>}
// Start throws raw Responses during SSR and fulfills them during client RPC.
export async function privateResult<T>(operation:Promise<T|Response>):Promise<T>{
  const result=await operation
  if(result instanceof Response)throw result
  return result
}
export function observedDate(value:string,locale:Locale){return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Paris'}).format(new Date(value))}
