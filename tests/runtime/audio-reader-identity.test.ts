import { hostname } from 'node:os'
import { beforeEach, expect, test, vi } from 'vitest'

// Rejection models only. Successful identity requires the actual owned Docker
// create/inspect/provision/start consumer; no mocked hostname grants readiness.
const fixture=vi.hoisted(()=>({mode:0o440,uid:0,opens:0,containerId:''}))
vi.mock('node:fs/promises',()=>({
  lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:Buffer.byteLength(JSON.stringify(proof())),
    mode:fixture.mode,uid:fixture.uid,ino:1,dev:1}),
  realpath:async()=>'/run/sparra/audio-reader-incarnation.json',
  open:async()=>{
    fixture.opens++
    return {stat:async()=>({ino:1,dev:1}),read:async(buffer:Buffer)=>{
      const bytes=Buffer.from(JSON.stringify(proof()));bytes.copy(buffer);return {bytesRead:bytes.length,buffer}
    },close:async()=>{}}
  },
}))
function proof(){return {schema_version:1,incarnation:'11111111-1111-4111-8111-111111111111',
  deployment_id:'negative-reader-fixture',container_id:fixture.containerId}}
const references={SPARRA_AUDIO_READER_INCARNATION:'11111111-1111-4111-8111-111111111111',
  SPARRA_AUDIO_READER_DEPLOYMENT_ID:'negative-reader-fixture'}
beforeEach(()=>{
  fixture.mode=0o440;fixture.uid=0;fixture.opens=0
  fixture.containerId=(hostname().startsWith('a')?'b':'a').repeat(64)
})
test('manifest identity cannot replace actual kernel hostname, including a forged HOSTNAME env',async()=>{
  const {readAudioIncarnation}=await import('../../src/modules/sparra/audio-reader.server')
  expect(await readAudioIncarnation({...references,HOSTNAME:fixture.containerId.slice(0,12)})).toBeNull()
  expect(fixture.opens).toBe(1)
})
test.each([{mode:0o460,uid:0},{mode:0o440,uid:10001}])('writable or non-root manifest is refused before opening: %j',async invalid=>{
  Object.assign(fixture,invalid)
  const {readAudioIncarnation}=await import('../../src/modules/sparra/audio-reader.server')
  expect(await readAudioIncarnation(references)).toBeNull()
  expect(fixture.opens).toBe(0)
})
test('absent fixed incarnation/deployment references cannot discover or open a manifest',async()=>{
  const {readAudioIncarnation}=await import('../../src/modules/sparra/audio-reader.server')
  expect(await readAudioIncarnation({})).toBeNull()
  expect(await readAudioIncarnation({SPARRA_AUDIO_READER_INCARNATION:references.SPARRA_AUDIO_READER_INCARNATION})).toBeNull()
  expect(fixture.opens).toBe(0)
})
