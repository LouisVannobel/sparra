import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Icon } from '@astryxdesign/core/Icon'
import { Heading } from '@astryxdesign/core/Heading'
import { appMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'

export function AppShell({locale,children}:{locale:Locale;children:ReactNode}){
  const t=appMessages[locale]
  return <div className="sparra-app"><a className="sparra-app-skip" href="#app-content">{locale==='fr'?'Aller au contenu':'Skip to content'}</a>
    <div className="sparra-app-sidebar">
    <header className="sparra-app-header"><a className="sparra-app-brand" href={`/app?lang=${locale}`}>sparra<span aria-hidden="true">.</span></a><span className="sparra-app-label"><Icon icon="info" aria-hidden="true"/>{t.pilot}</span></header>
    <nav className="sparra-app-nav" aria-label={locale==='fr'?'Navigation principale':'Main navigation'}><Link to="/app" search={{lang:locale}} activeOptions={{exact:true,includeSearch:false}}><Icon icon="microphone" aria-hidden="true"/>{t.inbox}</Link><Link to="/app/entreprise" search={{lang:locale}} activeOptions={{includeSearch:false}}><Icon icon="wrench" aria-hidden="true"/>{t.business}</Link><Link to="/account" search={{lang:locale,firstPasskey:undefined,googleAccount:undefined}} activeOptions={{includeSearch:false}}><Icon icon="info" aria-hidden="true"/>{t.account}</Link><Link to="/workspace" reloadDocument search={{lang:locale}} activeOptions={{includeSearch:false}}><Icon icon="viewColumns" aria-hidden="true"/>{t.workspace}</Link></nav>
    <a className="sparra-app-home" href="/">{locale==='fr'?'Le site Sparra':'Sparra website'}<Icon icon="externalLink" aria-hidden="true"/></a>
    </div>
    <main id="app-content" className="sparra-app-content">{children}</main>
  </div>
}
export function PrivateUnavailable({locale,title=appMessages[locale].inbox}:{locale:Locale;title?:string}){return <section className="sparra-app-state"><Heading level={1}>{title}</Heading><p role="alert">{appMessages[locale].unavailable}</p><a href={`/login?lang=${locale}`}>{appMessages[locale].login}</a></section>}
// Start throws raw Responses during SSR and fulfills them during client RPC.
export async function privateResult<T>(operation:Promise<T|Response>):Promise<T>{
  const result=await operation
  if(result instanceof Response)throw result
  return result
}
export function observedDate(value:string,locale:Locale){return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Paris'}).format(new Date(value))}
