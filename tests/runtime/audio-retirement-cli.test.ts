import { afterEach, expect, test, vi } from 'vitest'

// Negative format/ordering witness only. This models a readonly proof file and
// refuses before Client construction; it is not actual Docker retirement proof.
const fixture=vi.hoisted<{proof:unknown;clients:number}>(()=>({proof:undefined,clients:0}))
vi.mock('pg',()=>({Client:class{
  constructor(){fixture.clients++;throw new Error('Unexpected database construction')}
}}))
vi.mock('node:fs/promises',()=>({
  lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,
    size:Buffer.byteLength(JSON.stringify(fixture.proof)),mode:0o444,ino:1,dev:1}),
  realpath:async()=>'/run/sparra/audio-retirement-proof.json',
  open:async()=>({
    stat:async()=>({ino:1,dev:1}),
    read:async(buffer:Buffer)=>{
      const bytes=Buffer.from(JSON.stringify(fixture.proof));bytes.copy(buffer)
      return {bytesRead:bytes.length,buffer}
    },
    close:async()=>{},
  }),
}))
const argv=[...process.argv],exitCode=process.exitCode
afterEach(()=>{process.argv=argv;process.exitCode=exitCode;vi.unstubAllEnvs();vi.restoreAllMocks()})
test.each(['exited','removed'] as const)('legacy %s proof without native retirement witnesses is refused before database construction',async state=>{
  vi.resetModules();fixture.clients=0
  fixture.proof={schema_version:1,incarnation:'11111111-1111-4111-8111-111111111111',
    container_id:'f'.repeat(64),deployment_id:'negative-fixture',restart_policy:'no',container_state:state}
  process.argv=['node','scripts/migrate.ts','retire-audio-readers']
  vi.stubEnv('NODE_ENV','test')
  vi.stubEnv('MIGRATION_DATABASE_URL','postgresql://migrator:fixture_only_password@127.0.0.1:5432/auth')
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true)
  const error=vi.spyOn(process.stderr,'write').mockImplementation(()=>true)
  await import('../../scripts/migrate.ts')
  expect(fixture.clients).toBe(0)
  expect(process.exitCode).toBe(1)
  expect(output).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledWith('Database migration failed\n')
})
