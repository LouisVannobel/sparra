import { Redacted } from 'effect'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq } from 'drizzle-orm'
import { createAuthorizationURL, verifyProviderIdToken } from 'better-auth/oauth2'
import { generateRandomString, symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto'
import { google } from 'better-auth/social-providers'
import type { CalendarConfig } from './config.server'
import { createGoogleCalendarClient, GOOGLE_CALENDAR_SCOPES, hasRequiredCalendarGrants, CalendarProviderError, CalendarRevocationError, type GoogleCalendar } from './google.server'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { PersonalWorkspaceLease } from '../../platform/db/auth-pg-lease.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { calendarConnection } from './schema.server'
import { decryptCalendarTokens, encryptCalendarTokens, type CalendarTokens } from './token-crypto.server'
import { parseSaveCalendarPolicy, type CalendarPolicy } from './policy'

type IdentityProvider = Pick<ReturnType<typeof createGoogleCalendarClient>, 'signingKeys' | 'userInfo'>
export type CalendarOwnerProvider = Pick<ReturnType<typeof createGoogleCalendarClient>, 'exchangeCode' | 'refreshTokens' | 'revokeToken' | 'signingKeys' | 'userInfo' | 'listCalendars' | 'close'>
export type CalendarState = Readonly<{ available:boolean; status: typeof calendarConnection.$inferSelect.status | 'unavailable'; accountEmail:string|null; selectedCalendar:{id:string;summary:string}|null; calendars:readonly GoogleCalendar[]; enabled:boolean; policy:CalendarPolicy|null; revision:number }>
export class CalendarOperationError extends Error {
  constructor(readonly code:'unavailable'|'missing_workspace'|'conflict'|'busy'|'rejected') { super('Calendar '+code); this.name='CalendarOperationError' }
}
type Row = typeof calendarConnection.$inferSelect
const noState = { stateHash:null,stateSession:null,stateSecret:null,stateExpiresAt:null }
const noWork = { workId:null,workExpiresAt:null }
const writable = (calendar:GoogleCalendar) => ['writer','writerWithoutPrivateAccess','owner'].includes(calendar.accessRole)
const requiredScopes = ['openid','email',...GOOGLE_CALENDAR_SCOPES]
const hash = (value:string) => createHash('sha256').update(value).digest('hex')
const empty = (available:boolean):CalendarState => ({available,status:available?'disconnected':'unavailable',accountEmail:null,selectedCalendar:null,calendars:[],enabled:false,policy:null,revision:0})
function dto(row:Row, calendars:readonly GoogleCalendar[]=[]):CalendarState {
  return {available:true,status:row.status,accountEmail:row.accountEmail,selectedCalendar:row.calendarId&&row.calendarSummary?{id:row.calendarId,summary:row.calendarSummary}:null,calendars:calendars.filter(writable),enabled:row.enabled,policy:row.policy,revision:row.policyRevision}
}

export function createCalendarOperations(owner:AuthTransactions, config:CalendarConfig|null, suppliedProvider?:CalendarOwnerProvider) {
  const scope=new AsyncLocalStorage<CalendarOwnerProvider|null>()
  const shutdown=new AbortController()
  const active=new Set<Promise<unknown>>()
  let stopping=false
  const configured=()=>{const provider=scope.getStore();if(!config||!provider||stopping)throw new CalendarOperationError('unavailable');return {config,provider}}
  function track<A>(run:()=>Promise<A>,signal?:AbortSignal):Promise<A>{
    if(stopping)return Promise.reject(new CalendarOperationError('unavailable'))
    const provider=suppliedProvider??(config?createGoogleCalendarClient(config,AbortSignal.any([shutdown.signal,...(signal?[signal]:[])]),Date.now()+30000):null)
    const pending=scope.run(provider,run).finally(async()=>{if(!suppliedProvider)await provider?.close()})
    active.add(pending);void pending.finally(()=>active.delete(pending)).catch(()=>{});return pending
  }
  async function tx<A>(principal:AdmittedPrincipal, run:(lease:PersonalWorkspaceLease)=>Promise<A>,signal?:AbortSignal,deadlineAtMs=Date.now()+10000):Promise<A> {
    if(!principal?.userId||!principal.sessionId)throw new CalendarOperationError('rejected')
    return owner.withPersonalWorkspacePromise({deadlineAtMs,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID(),signal},principal,false,async lease=>{
      if(!lease)throw new CalendarOperationError('missing_workspace')
      return run(lease)
    })
  }
  async function row(lease:PersonalWorkspaceLease) { return (await lease.db.select().from(calendarConnection).where(eq(calendarConnection.workspaceId,lease.workspaceId)))[0] }
  function binding(value:Row){return {workspaceId:value.workspaceId,connectionId:value.id}}
  function intentionKey(value:Pick<Row,'workspaceId'|'id'|'generation'>) { return createHmac('sha256',Redacted.value(configured().config.tokenKey)).update(JSON.stringify(['calendar-intention',value.workspaceId,value.id,value.generation])).digest('base64url') }
  async function update(lease:PersonalWorkspaceLease, previous:Row, values:Partial<typeof calendarConnection.$inferInsert>) {
    const [changed]=await lease.db.update(calendarConnection).set(values).where(and(eq(calendarConnection.workspaceId,lease.workspaceId),eq(calendarConnection.generation,previous.generation))).returning()
    if(!changed)throw new CalendarOperationError('conflict')
    return changed
  }
  async function beginConnection(principal:AdmittedPrincipal,signal?:AbortSignal,locale:'fr'|'en'='fr') {
    const {config}=configured(),state=generateRandomString(48),verifier=generateRandomString(64),nonce=generateRandomString(48)
    const url=await createAuthorizationURL({id:'google-calendar',options:{clientId:Redacted.value(config.clientId)},authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',redirectURI:config.origin+'/api/calendar/google/callback',state,codeVerifier:verifier,nonce,scopes:requiredScopes,prompt:'consent',accessType:'offline'})
    await tx(principal,async lease=>{
      let current=await row(lease)
      if(current&&['connected','reconnect_required','revoking'].includes(current.status))throw new CalendarOperationError('busy')
      const id=current?.id??randomUUID(),generation=(current?.generation??0)+1
      const stateSecret=await symmetricEncrypt({key:intentionKey({id,workspaceId:lease.workspaceId,generation}),data:JSON.stringify({verifier,nonce,locale})})
      const values={id,workspaceId:lease.workspaceId,generation,status:'connecting' as const,stateHash:hash(state),stateSession:principal.sessionId,stateSecret,stateExpiresAt:new Date(Date.now()+600000),...noWork,enabled:false}
      if(current)await update(lease,current,values);else await lease.db.insert(calendarConnection).values(values)
    },signal)
    return url.toString()
  }
  async function claimConnectionIntent(principal:AdmittedPrincipal,state:string,signal?:AbortSignal):Promise<Row&{workId:string}> {
    return tx(principal,async lease=>{
      const current=await row(lease)
      if(!current||current.status!=='connecting'||current.stateHash!==hash(state)||current.stateSession!==principal.sessionId||!current.stateExpiresAt||current.stateExpiresAt.getTime()<=Date.now()||!current.stateSecret)throw new CalendarOperationError('rejected')
      const workId=randomUUID()
      await update(lease,current,{...noState,workId,workExpiresAt:new Date(Date.now()+30000)})
      // The updated row has no stateSecret; decryption needs the pre-update snapshot.
      return {...current,workId}
    },signal)
  }
  async function parseConnectionIntent(claimed:Row&{workId:string}):Promise<{verifier:string;nonce:string;locale:'fr'|'en'}> {
    const secret:unknown=JSON.parse(await symmetricDecrypt({key:intentionKey(claimed),data:claimed.stateSecret!}))
    if(!secret||typeof secret!=='object'||!('verifier'in secret)||typeof secret.verifier!=='string'||!('nonce'in secret)||typeof secret.nonce!=='string')throw new CalendarOperationError('rejected')
    return {verifier:secret.verifier,nonce:secret.nonce,locale:'locale'in secret&&secret.locale==='en'?'en':'fr'}
  }
  async function completeConnection(principal:AdmittedPrincipal,input:{state:string;code?:string;error?:string},signal?:AbortSignal):Promise<'fr'|'en'> {
    const {config,provider}=configured()
    if(typeof input.state!=='string'||input.state.length>256||!input.state||input.code!==undefined&&(typeof input.code!=='string'||!input.code||input.code.length>4096))throw new CalendarOperationError('rejected')
    const claimed=await claimConnectionIntent(principal,input.state,signal)
    try {
      if(input.error||!input.code)throw new CalendarOperationError('rejected')
      const secret=await parseConnectionIntent(claimed)
      const tokens=await provider.exchangeCode({code:input.code,codeVerifier:secret.verifier,redirectUri:config.origin+'/api/calendar/google/callback'})
      if(!tokens.refreshToken||!tokens.idToken||!tokens.expiresIn||!hasRequiredCalendarGrants(tokens.grantedScopes))throw new CalendarOperationError('rejected')
      const identity=await verifyCalendarIdentity(config,provider,tokens.idToken,secret.nonce,tokens.accessToken)
      const envelope=encryptCalendarTokens(config,binding(claimed),{accessToken:tokens.accessToken,refreshToken:tokens.refreshToken,expiresAt:Date.now()+tokens.expiresIn*1000,grantedScopes:tokens.grantedScopes})
      await tx(principal,async lease=>{
        const current=await row(lease)
        if(!current||current.generation!==claimed.generation||current.status!=='connecting'||current.workId!==claimed.workId)throw new CalendarOperationError('conflict')
        await update(lease,current,{status:'connected',googleSubject:identity.sub,accountEmail:identity.email,tokenEnvelope:envelope,...noWork})
      },signal)
      return secret.locale
    } catch(error) {
      // Never revoke a late exchange: Google's project-wide revocation could destroy a newer grant.
      await tx(principal,async lease=>{const current=await row(lease);if(current?.generation===claimed.generation&&current.status==='connecting'&&current.workId===claimed.workId)await update(lease,current,{status:'disconnected',...noWork})}).catch(()=>{})
      throw error instanceof CalendarOperationError?error:new CalendarOperationError('rejected')
    }
  }
  async function credentials(principal:AdmittedPrincipal,signal?:AbortSignal):Promise<{row:Row;tokens:CalendarTokens}> {
    const {config,provider}=configured()
    const claimed=await tx(principal,async lease=>{
      const current=await row(lease)
      if(!current||current.status!=='connected'||!current.tokenEnvelope)throw new CalendarOperationError('rejected')
      const tokens=decryptCalendarTokens(config,binding(current),current.tokenEnvelope)
      if(tokens.expiresAt>Date.now()+60000)return {row:current,tokens,refresh:false}
      if(current.workId&&current.workExpiresAt&&current.workExpiresAt.getTime()>Date.now())throw new CalendarOperationError('busy')
      return {row:await update(lease,current,{workId:randomUUID(),workExpiresAt:new Date(Date.now()+30000)}),tokens,refresh:true}
    },signal)
    if(!claimed.refresh)return claimed
    try {
      const result=await provider.refreshTokens(claimed.tokens.refreshToken)
      if(!result.expiresIn||!hasRequiredCalendarGrants(result.grantedScopes))throw new CalendarProviderError('unauthorized')
      const identity=await provider.userInfo(result.accessToken)
      if(identity.sub!==claimed.row.googleSubject||!identity.emailVerified)throw new CalendarProviderError('unauthorized')
      const tokens:CalendarTokens={accessToken:result.accessToken,refreshToken:result.refreshToken??claimed.tokens.refreshToken,expiresAt:Date.now()+result.expiresIn*1000,grantedScopes:result.grantedScopes}
      const tokenEnvelope=encryptCalendarTokens(config,binding(claimed.row),tokens)
      const settled=await tx(principal,async lease=>{
        const current=await row(lease)
        if(!current||current.generation!==claimed.row.generation||current.status!=='connected'||current.workId!==claimed.row.workId)throw new CalendarOperationError('conflict')
        return update(lease,current,{tokenEnvelope,...noWork})
      },signal)
      return {row:settled,tokens}
    } catch(error) {
      await tx(principal,async lease=>{const current=await row(lease);if(current?.generation===claimed.row.generation&&current.status==='connected'&&current.workId===claimed.row.workId)await update(lease,current,{...noWork,...(error instanceof CalendarProviderError&&error.code==='unauthorized'?{status:'reconnect_required',enabled:false,policyRevision:current.policyRevision+1}: {})})}).catch(()=>{})
      throw error instanceof CalendarOperationError?error:new CalendarOperationError('unavailable')
    }
  }
  async function read(principal:AdmittedPrincipal,signal?:AbortSignal):Promise<CalendarState> {
    if(!principal?.userId||!principal.sessionId)throw new CalendarOperationError('rejected')
    if(!config)return empty(false)
    let current:Row|undefined
    try { current=await tx(principal,row,signal) } catch(error) {if(error instanceof CalendarOperationError&&error.code==='missing_workspace')return empty(!!config);throw error}
    const {provider}=configured()
    if(!current)return empty(true)
    if(current.status!=='connected')return dto(current)
    let access:Awaited<ReturnType<typeof credentials>>
    try {access=await credentials(principal,signal)}
    catch(error) {
      if(!(error instanceof CalendarOperationError)||error.code!=='unavailable')throw error
      return tx(principal,async lease=>{const latest=await row(lease);if(!latest)throw new CalendarOperationError('conflict');return {...dto(latest),available:false}},signal)
    }
    let calendars:GoogleCalendar[]
    try {calendars=await provider.listCalendars(access.tokens.accessToken)}
    catch(error) {
      return tx(principal,async lease=>{
        const latest=await row(lease)
        if(!latest||latest.generation!==access.row.generation||latest.status!=='connected')throw new CalendarOperationError('conflict')
        const settled=error instanceof CalendarProviderError&&error.code==='unauthorized'?await update(lease,latest,{status:'reconnect_required',enabled:false,policyRevision:latest.policyRevision+1}):latest
        return {...dto(settled),available:false}
      },signal)
    }
    return tx(principal,async lease=>{
      const latest=await row(lease)
      if(!latest||latest.generation!==access.row.generation||latest.status!=='connected')throw new CalendarOperationError('conflict')
      if(latest.enabled&&!calendars.some(calendar=>calendar.id===latest.calendarId&&writable(calendar)))return dto(await update(lease,latest,{enabled:false,policyRevision:latest.policyRevision+1}),calendars)
      return dto(latest,calendars)
    },signal)
  }
  async function savePolicy(principal:AdmittedPrincipal,input:unknown,signal?:AbortSignal):Promise<CalendarState> {
    const parsed=parseSaveCalendarPolicy(input),{provider}=configured(),access=await credentials(principal,signal)
    const calendars=await provider.listCalendars(access.tokens.accessToken),selected=calendars.find(value=>value.id===parsed.calendarId&&writable(value))
    if(!selected)throw new CalendarOperationError('rejected')
    return tx(principal,async lease=>{
      const current=await row(lease)
      if(!current||current.status!=='connected'||current.generation!==access.row.generation||current.policyRevision!==parsed.expectedRevision)throw new CalendarOperationError('conflict')
      return dto(await update(lease,current,{policy:parsed.policy,policyRevision:current.policyRevision+1,calendarId:selected.id,calendarSummary:selected.summary,enabled:parsed.enabled}),calendars)
    },signal)
  }
  async function settleRevocation(principal:AdmittedPrincipal,claimed:Row):Promise<void> {
    // Remote retirement is already definitive. Join only local fenced cleanup, even if the browser left.
    const deadlineAtMs=Date.now()+10000
    for(let attempt=0;attempt<3;attempt++) {
      try {
        await tx(principal,async lease=>{
          const current=await row(lease)
          if(!current||current.id!==claimed.id||current.generation!==claimed.generation)throw new CalendarOperationError('conflict')
          // Read back a settlement whose COMMIT acknowledgement may have been lost.
          if(current.status==='disconnected'&&current.tokenEnvelope===null&&current.workId===null)return
          if(current.status!=='revoking'||current.workId!==claimed.workId)throw new CalendarOperationError('conflict')
          await update(lease,current,{status:'disconnected',tokenEnvelope:null,googleSubject:null,accountEmail:null,...noWork})
        },undefined,deadlineAtMs)
        return
      } catch(error) {
        if(error instanceof CalendarOperationError||attempt===2||Date.now()>=deadlineAtMs)throw error
      }
    }
  }
  async function disconnect(principal:AdmittedPrincipal,signal?:AbortSignal):Promise<void> {
    const {config,provider}=configured()
    const claimed=await tx(principal,async lease=>{
      const current=await row(lease)
      if(!current||current.status==='disconnected')return null
      // A revocation is never stolen by a timer: a paused sender must not revoke replacement credentials.
      if(current.status==='revoking'&&current.workId)throw new CalendarOperationError('busy')
      const revoke=!!current.tokenEnvelope
      return update(lease,current,{generation:current.generation+1,enabled:false,policyRevision:current.policyRevision+1,status:revoke?'revoking':'disconnected',...noState,workId:revoke?randomUUID():null,workExpiresAt:null})
    },signal)
    if(!claimed||claimed.status!=='revoking'||!claimed.tokenEnvelope)return
    try {
      const tokens=decryptCalendarTokens(config,binding(claimed),claimed.tokenEnvelope)
      const result=await provider.revokeToken(tokens.refreshToken)
      // An expired refresh token does not establish that its access token is unusable.
      if(result==='invalid_token')await provider.revokeToken(tokens.accessToken)
      await settleRevocation(principal,claimed)
    } catch(error) {
      // Local abort/join cannot prove that Google did not receive a revoke.
      // Only a typed refusal before dispatch releases ownership for another attempt.
      if(error instanceof CalendarRevocationError&&error.outcome==='not_sent')await tx(principal,async lease=>{const current=await row(lease);if(current?.generation===claimed.generation&&current.status==='revoking'&&current.workId===claimed.workId)await update(lease,current,noWork)}).catch(()=>{})
      throw error instanceof CalendarOperationError?error:new CalendarOperationError('unavailable')
    }
  }
  return {
    read:(principal:AdmittedPrincipal,signal?:AbortSignal)=>track(()=>read(principal,signal),signal),
    callbackUrl:config?config.origin+'/api/calendar/google/callback':null,
    beginConnection:(principal:AdmittedPrincipal,signal?:AbortSignal,locale:'fr'|'en'='fr')=>track(()=>beginConnection(principal,signal,locale),signal),
    completeConnection:(principal:AdmittedPrincipal,input:{state:string;code?:string;error?:string},signal?:AbortSignal)=>track(()=>completeConnection(principal,input,signal),signal),
    savePolicy:(principal:AdmittedPrincipal,input:unknown,signal?:AbortSignal)=>track(()=>savePolicy(principal,input,signal),signal),
    disconnect:(principal:AdmittedPrincipal,signal?:AbortSignal)=>track(()=>disconnect(principal,signal),signal),
    async stop(){stopping=true;shutdown.abort();await suppliedProvider?.close();await Promise.allSettled([...active])},
  }
}
export async function verifyCalendarIdentity(config: CalendarConfig, provider: IdentityProvider, idToken: string, nonce: string, accessToken: string): Promise<{ sub: string; email: string }> {
  try {
    if (!nonce || idToken.length > 16384) throw new Error()
    let subject: string | undefined
    const verified = await verifyProviderIdToken({ ...google({ clientId: Redacted.value(config.clientId) }), idToken: {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: Redacted.value(config.clientId), algorithms: ['RS256'], nonceComparison: 'exact',
      jwks: async header => {
        if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error()
        const key = (await provider.signingKeys()).find(candidate => candidate.kid === header.kid)
        if (!key) throw new Error()
        return crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      },
      verifyClaims: claims => {
        if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now()/1000 || (claims.azp !== undefined && claims.azp !== Redacted.value(config.clientId))) return false
        subject = claims.sub
        return true
      },
    } }, idToken, nonce)
    if (!verified || !subject) throw new Error()
    const identity = await provider.userInfo(accessToken)
    if (identity.sub !== subject || !identity.emailVerified) throw new Error()
    return { sub: subject, email: identity.email }
  } catch { throw new Error('Calendar identity rejected') }
}
