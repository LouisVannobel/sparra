import { expect,test } from 'vitest'
import { calendarCallbackResponse } from '../../src/modules/calendar/calendar-http.server'
const principal={userId:'owner',sessionId:'session',name:'Owner',email:'owner@example.test'}
test('callback refuses absent login and duplicate state without provider exchange',async()=>{
  let calls=0
  const calendar={callbackUrl:'https://sparra.example/api/calendar/google/callback',async completeConnection(){calls++;return 'en' as const}}
  const request=new Request(calendar.callbackUrl+'?state=first&state=second&code=code')
  expect((await calendarCallbackResponse(request,{auth:{requirePrincipal:async()=>principal},calendar})).status).toBe(400)
  expect((await calendarCallbackResponse(new Request(calendar.callbackUrl+'?state=first&code=code'),{auth:null,calendar})).status).toBe(401)
  expect(calls).toBe(0)
})
test('successful callback keeps locale, errors are opaque and destination cannot be redirected by input',async()=>{
  const calendar={callbackUrl:'https://sparra.example/api/calendar/google/callback',async completeConnection(){return 'en' as const}}
  const auth={requirePrincipal:async()=>principal}
  const response=await calendarCallbackResponse(new Request(calendar.callbackUrl+'?state=first&code=code&returnTo=https://attacker.invalid'),{auth,calendar})
  expect(response.status).toBe(303);expect(response.headers.get('location')).toBe('/app/entreprise?lang=en&calendar=returned')
  const failure=await calendarCallbackResponse(new Request(calendar.callbackUrl+'?state=first&code=code'),{auth,calendar:{...calendar,async completeConnection(){throw new Error('raw-secret-provider-error')}}})
  expect(failure.headers.get('location')).toBe('/app/entreprise?lang=fr&calendar=failed');expect(await failure.text()).not.toContain('raw-secret')
})
test.each(['fr','en'] as const)('successful %s callback carries only a return presentation marker',async locale=>{
  const calendar={callbackUrl:'https://sparra.example/api/calendar/google/callback',async completeConnection(){return locale}}
  const response=await calendarCallbackResponse(new Request(calendar.callbackUrl+'?state=first&code=code'),{auth:{requirePrincipal:async()=>principal},calendar})
  expect(response.headers.get('location')).toBe('/app/entreprise?lang='+locale+'&calendar=returned')
  expect(response.headers.get('cache-control')).toBe('no-store')
})
