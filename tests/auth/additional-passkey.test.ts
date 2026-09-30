import { randomBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { AuthAttemptExceeded, createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { AdditionalPasskeyRejected, validateAdditionalPasskeyAuthorizeInput, validateAdditionalPasskeyFinishInput } from '../../src/modules/auth/additional-passkey.server'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'

const origin = 'https://app.example.test'
test('registration rejects browser-derived public-key fields outside the approved wire DTO', () => {
  const credential=registrationCredentialFixture({challenge:'fixture',rp:{id:'app.example.test'}},origin)
  const input={intentId:'f1307f5a-34b8-48e4-a62e-9b86d38746e0',response:credential.response}
  for(const derived of [{publicKeyAlgorithm:-7},{publicKey:'AQ'},{authenticatorData:'AQ'}]){
    let refused=false
    try{validateAdditionalPasskeyFinishInput({...input,response:{...input.response,response:{...input.response.response,...derived}}})}
    catch(error){refused=error instanceof AdditionalPasskeyRejected}
    expect(refused).toBe(true)
  }
})
test('additional ingress rejects cross-origin methods and native HTTP before work', async () => {
  let checkouts=0
  const owner=createTransactions({async connect():Promise<never>{checkouts++;throw new Error('Unexpected checkout')}},{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000})
  const limiter=createAuthRateLimiter(readRateLimitConfig({NODE_ENV:'test',REDIS_URL:'redis://:fixture@127.0.0.1:1',RATE_LIMIT_HMAC_SECRET:randomBytes(32).toString('hex'),RATE_LIMIT_KEY_ID:'additional-ingress',TRUSTED_PROXY_IPS:'127.0.0.1'}))
  const consume=vi.spyOn(limiter,'consumeAuthAttempt').mockResolvedValue(undefined)
  const app=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:origin,AUTH_SECRET:randomBytes(48).toString('hex')})!,limiter)
  try{
    for(const command of ['beginAdditionalPasskey','authorizeAdditionalPasskey','finishAdditionalPasskey'] as const){
      for(const [method,postedOrigin,site] of [['GET',origin,'same-origin'],['POST','https://other.example.test','same-origin'],['POST',origin,'cross-site']]){
        const request=Object.assign(new Request(origin+'/additional',{method,headers:{origin:postedOrigin,'sec-fetch-site':site,'x-real-ip':'192.0.2.44'}}),{runtime:{node:{req:{socket:{remoteAddress:'127.0.0.1'}}}}})
        Object.defineProperty(request,'appAuthDeadlineAtMs',{value:Date.now()+10000})
        const error=await app[command](request,{}).then(()=>undefined,error=>error)
        const refusal=app.additionalPasskeyErrorResponse(error)
        expect({status:refusal?.status,constantBody:await refusal?.text()==='Authentication rejected',
          noCookies:refusal?.headers.getSetCookie().length===0,noStore:refusal?.headers.get('cache-control')==='no-store'})
          .toEqual({status:401,constantBody:true,noCookies:true,noStore:true})
      }
    }
    for(const [path,method] of [['/passkey/generate-register-options','GET'],['/passkey/verify-registration','POST'],['/get-session','GET'],['/passkey/list-user-passkeys','GET']]){
      const response=await app.callback(new Request(origin+'/api/auth'+path,{method,headers:{origin}}))
      expect(response.status).toBe(404)
    }
    expect(checkouts).toBe(0);expect(consume).not.toHaveBeenCalled()
  }finally{await app.close();await limiter.close()}
})
test('registration preserves native credProps without accepting extension authority', () => {
  const credential = registrationCredentialFixture({ challenge: 'fixture', rp: { id: 'app.example.test' } }, origin)
  const input = { intentId: 'f1307f5a-34b8-48e4-a62e-9b86d38746e0', response: credential.response }
  for (const output of [{}, { credProps: {} }, { credProps: { rk: true } }, { credProps: { rk: false } }]) {
    let retained = false
    try {
      const decoded = validateAdditionalPasskeyFinishInput({ ...input, response: { ...input.response, clientExtensionResults: output } })
      retained = JSON.stringify(decoded.response.clientExtensionResults) === JSON.stringify(output)
    } catch {}
    expect(retained).toBe(true)
  }
  for (const output of [{ unknown: true }, { credProps: { unknown: true } }, { credProps: { rk: 'true' } }, { credProps: true }, { credProps: { rk: true }, uv: true }]) {
    let refused = false
    try { validateAdditionalPasskeyFinishInput({ ...input, response: { ...input.response, clientExtensionResults: output } }) }
    catch (error) { refused = error instanceof AdditionalPasskeyRejected }
    expect(refused).toBe(true)
  }
})
test('posted_authority_and_oversize_payloads_refuse', () => {
  const credential = registrationCredentialFixture({ challenge: 'fixture', rp: { id: 'app.example.test' } }, origin)
  const intentId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0'
  const input = { intentId, response: credential.authenticationResponse({ challenge: 'fixture', rpId: 'app.example.test' }) }
  let accepted = false
  try { accepted = validateAdditionalPasskeyAuthorizeInput(input).intentId === intentId } catch {}
  expect(accepted).toBe(true)
  expect(() => validateAdditionalPasskeyAuthorizeInput({ ...input, createSession: true })).toThrow(AdditionalPasskeyRejected)
  expect(() => validateAdditionalPasskeyAuthorizeInput({ ...input, response: { ...input.response, id: 'A'.repeat(16385) } })).toThrow(AdditionalPasskeyRejected)
  let registrationAccepted = false
  try { registrationAccepted = validateAdditionalPasskeyFinishInput({ intentId, response: credential.response }).intentId === intentId } catch {}
  expect(registrationAccepted).toBe(true)
  for (const extra of [{ userId: 'posted' }, { workspaceId: intentId }, { context: 'posted' }, { grant: 'posted' }]) {
    expect(() => validateAdditionalPasskeyFinishInput({ intentId, response: credential.response, ...extra })).toThrow(AdditionalPasskeyRejected)
  }
  expect(() => validateAdditionalPasskeyFinishInput({ intentId, response: { ...credential.response, response: {
    ...credential.response.response, attestationObject: 'A'.repeat(16385),
  } } })).toThrow(AdditionalPasskeyRejected)
})
test.each(['beginAdditionalPasskey', 'authorizeAdditionalPasskey', 'finishAdditionalPasskey'] as const)(
  'three_commands_charge_before_decoding_or_database: %s', async command => {
    let checkouts = 0
    const owner = createTransactions({ async connect(): Promise<never> { checkouts++; throw new Error('Unexpected checkout') } },
      { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://:fixture@127.0.0.1:1',
      RATE_LIMIT_HMAC_SECRET: randomBytes(32).toString('hex'), RATE_LIMIT_KEY_ID: 'additional-source', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockRejectedValue(new AuthAttemptExceeded(17))
    const app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!, limiter)
    try {
      expect(typeof Reflect.get(app, command)).toBe('function')
      const request = Object.assign(new Request(origin + '/additional', { method: 'POST', headers: {
        origin, 'sec-fetch-site': 'same-origin', 'x-real-ip': '192.0.2.41',
      } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
      Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
      const error = await app[command](request, { postedUser: 'forbidden' }).catch(error => error)
      expect(limiter.errorResponse(error)?.status).toBe(429)
      expect(checkouts).toBe(0)
      expect(consume).toHaveBeenCalledTimes(1)
      expect(consume.mock.calls[0][0]).toBe(command)
    } finally { await app.close(); await limiter.close() }
  })
