import type { WebResources } from '../../platform/resources.server'
type CallbackResources={auth:Pick<NonNullable<WebResources['auth']>,'requirePrincipal'>|null;calendar?:Pick<NonNullable<WebResources['calendar']>,'callbackUrl'|'completeConnection'>}
export async function calendarCallbackResponse(request:Request,resources:CallbackResources):Promise<Response>{
  const headers={'cache-control':'no-store','referrer-policy':'no-referrer'}
  if(!resources.auth)return new Response('Unauthorized',{status:401,headers})
  if(!resources.calendar?.callbackUrl)return new Response('Calendar unavailable',{status:503,headers})
  const url=new URL(request.url),query=url.searchParams
  if(request.method!=='GET'||url.origin+url.pathname!==resources.calendar.callbackUrl||query.getAll('state').length!==1||!query.get('state')||query.getAll('code').length>1||query.getAll('error').length>1||(!query.get('code')&&!query.get('error'))||!!query.get('code')&&!!query.get('error'))return new Response('Invalid callback',{status:400,headers})
  try{
    const principal=await resources.auth.requirePrincipal(request)
    const locale=await resources.calendar.completeConnection(principal,{state:query.get('state')!,...(query.get('code')?{code:query.get('code')!}:{}),...(query.get('error')?{error:query.get('error')!}:{})},request.signal)
    return new Response(null,{status:303,headers:{...headers,location:`/app/entreprise?lang=${locale}&calendar=returned`}})
  }catch(error){
    if(error instanceof Response&&error.status===401)return new Response('Unauthorized',{status:401,headers})
    return new Response(null,{status:303,headers:{...headers,location:'/app/entreprise?lang=fr&calendar=failed'}})
  }
}
