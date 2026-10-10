import { useLayoutEffect, useState } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import type { ActivityState, ListRequestsInput, ListRequestsPage } from '../../modules/sparra/sparra.functions'
import { appMessages, requestMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'
import { observedDate, privateResult, PrivateUnavailable } from './app-shell'
import { useRequestAttempt } from './use-request-attempt'

export function mergeInboxPage(current: ListRequestsPage, next: ListRequestsPage): ListRequestsPage {
  // Only IDs from the already-loaded page suppress incoming rows.
  return { requests: [...current.requests, ...next.requests.filter(row => !current.requests.some(existing => existing.id === row.id))], nextCursor: next.nextCursor }
}

type Props={locale:Locale;state:ActivityState;page:ListRequestsPage;onMore(data:ListRequestsInput,signal:AbortSignal):Promise<ListRequestsPage|Response>;onRefused():Promise<void>}
const descriptions={fr:'Les demandes de vos appelants, au même endroit.',en:'Your callers’ requests, in one place.'} as const
type InboxPageEffects={setCurrent(page:ListRequestsPage):void;setPending(value:boolean):void;setFailed(value:boolean):void;setRefused(value:boolean):void;onRefused():Promise<void>}

async function settleInboxFailure(error:unknown,live:()=>boolean,{setFailed,setRefused,onRefused}:Pick<InboxPageEffects,'setFailed'|'setRefused'|'onRefused'>){
  if(!live())return
  if(error instanceof Response&&error.status===401){setRefused(true);await onRefused();return}
  setFailed(true)
}

export async function loadInboxPage(current:ListRequestsPage,begin:ReturnType<typeof useRequestAttempt>,onMore:Props['onMore'],effects:InboxPageEffects,kind:'more'|'refresh'='more'){
  const cursor=current.nextCursor
  const data=kind==='refresh'?{}:cursor?{cursor}:null
  if(!data)return
  const {signal,live}=begin()
  effects.setPending(true);effects.setFailed(false)
  try{
    const next=await privateResult(onMore(data,signal))
    if(live())effects.setCurrent(kind==='refresh'?next:mergeInboxPage(current,next))
  }catch(error){await settleInboxFailure(error,live,effects)}finally{if(live())effects.setPending(false)}
}

export function InboxPanel({locale,state,page,onMore,onRefused}:Props){
  const t=appMessages[locale],hydrated=useHydrated(),[current,setCurrent]=useState(page),[pending,setPending]=useState<'more'|'refresh'|null>(null),[failed,setFailed]=useState(false)
  const begin=useRequestAttempt()
  const [refused,setRefused]=useState(false)
  // A new loader page owns the whole first page, even when every ID is unchanged.
  // Retire reads before paint so old pagination cannot restore its captured rows.
  useLayoutEffect(()=>{begin();setCurrent(page);setPending(null);setFailed(false);setRefused(false)},[page])
  function read(kind:'more'|'refresh'){return loadInboxPage(current,begin,onMore,{setCurrent,setPending:value=>setPending(value?kind:null),setFailed,setRefused,onRefused},kind)}
  if(refused)return <PrivateUnavailable locale={locale}/>
  const labels=requestMessages[locale]
  return <><div className="sparra-page-heading"><Heading level={1}>{t.inbox}</Heading><p>{descriptions[locale]}</p><Button label={t.refresh} isDisabled={!hydrated} isLoading={pending==='refresh'} onClick={()=>void read('refresh')}/></div>{!state.configuration&&<p className="sparra-setup-note"><a href={`/app/entreprise?lang=${locale}`}>{t.configure}</a></p>}
    {current.requests.length===0?<div className="sparra-inbox-empty"><span className="sparra-empty-icon"><Icon icon="microphone" aria-hidden="true"/></span><p>{t.noCalls}</p></div>:<ul className="sparra-inbox">{current.requests.map(request=><li key={request.id}>
      <div className="sparra-inbox-row-heading">
      <a href={`/app/demandes/${request.id}?lang=${locale}`}>{request.summary??t.summaryUnavailable}</a>
      <p><time dateTime={request.admittedAt}>{observedDate(request.admittedAt,locale)}</time></p>
      </div>
      <p className="sparra-inbox-status">{t.status[request.status]}{request.treatedAt?` — ${t.treated}`:''}</p>
      {request.category&&<><strong>{labels.reason}</strong><p>{labels.category[request.category]}</p></>}
      {request.contact&&<>
        {request.contact.callback_e164&&<p>{request.contact.callback_e164}</p>}
        <p>{labels.callbackSource[request.contact.callback_source]}</p><p>{t.unconfirmed}</p>
      </>}
      {request.resultAvailability==='available'&&request.resultQuality==='partial'&&<span className="sparra-app-label">{t.partial}</span>}
    </li>)}</ul>}
    {current.nextCursor&&<Button label={t.more} isDisabled={!hydrated||pending!==null} isLoading={pending==='more'} onClick={()=>void read('more')}/>} {pending&&<p role="status">{t.loading}</p>}{failed&&<p role="alert">{t.unavailable}</p>}
  </>
}
