import { Effect } from 'effect'
import { expect,test,vi } from 'vitest'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createWebResources } from '../../src/platform/runtime.server'
vi.mock('../../src/platform/db/resources.server',()=>({acquireDatabase:()=>Effect.succeed({transactions:createTransactions({async connect(){throw new Error('No SQL allowed in startup fixture')}},{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000}),stop(){},isReady:()=>true})}))
vi.mock('../../src/modules/auth/rate-limit.server',async importOriginal=>({...await importOriginal<typeof import('../../src/modules/auth/rate-limit.server')>(),createAuthRateLimiter:()=>({async connect(){},async close(){},isReady:()=>true})}))
vi.mock('../../src/modules/auth/auth.server',()=>({readAuthConfig:()=>({}),createApplicationAuth:()=>({async close(){}})}))
const env={NODE_ENV:'test',APP_ORIGIN:'https://sparra.example',DATABASE_URL:'postgres://fixture:synthetic@127.0.0.1/fixture',REDIS_URL:'redis://:synthetic@127.0.0.1',RATE_LIMIT_HMAC_SECRET:'fixture-at-least-thirty-two-characters',RATE_LIMIT_KEY_ID:'fixture',TRUSTED_PROXY_IPS:'127.0.0.1'}
test.each([{}, {SPARRA_GOOGLE_CALENDAR_CLIENT_ID:'partial'}, {SPARRA_GOOGLE_CALENDAR_CLIENT_ID:'fixture',SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET:'fixture',SPARRA_CALENDAR_TOKEN_KEY:'bad'}])('optional invalid Calendar configuration leaves native web ready without Calendar SQL/provider I/O (%j)',async calendar=>{
  const owner=createWebResources({...env,...calendar})
  try{const resources=await owner.ready();expect(resources.isReady()).toBe(true);expect(resources.auth).not.toBeNull();expect(resources.calendar?.callbackUrl).toBeNull();expect(await resources.calendar?.read({userId:'fixture',sessionId:'fixture',name:'Fixture',email:'fixture@example.test'})).toMatchObject({available:false,status:'unavailable'})}
  finally{await owner.dispose()}
})
