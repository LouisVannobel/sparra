import { afterEach, expect, test, vi } from 'vitest'
import { nativeImage } from '../helpers/native-image'
const boundary=vi.hoisted(()=>({exec:vi.fn()}))
vi.mock('node:child_process',()=>({execFile:Object.assign(()=>{throw new Error('Real Docker prohibited')},{[Symbol.for('nodejs.util.promisify.custom')]:boundary.exec})}))
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks()})
const reference='ghcr.io/louisvannobel/sparra-web@sha256:'+'b'.repeat(64),id='sha256:'+'c'.repeat(64)
test('immutable_published_reference_uses_previously_pulled_object_without_rebuild',async()=>{
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE',reference)
  boundary.exec.mockImplementation(async(_file:string,args:string[])=>{if(!args.includes(reference)||args.includes('build'))throw new Error('Unexpected build or authority');return {stdout:id+'|linux/amd64\n',stderr:''}})
  expect(await nativeImage('web')).toBe(id)
})
test.each(['ghcr.io/louisvannobel/sparra-web:latest','ghcr.io/louisvannobel/foreign@sha256:'+'b'.repeat(64),''])('mutable_or_foreign_reference_is_refused_before_Docker: %s',async reference=>{
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE',reference);boundary.exec.mockRejectedValue(new Error('Unexpected Docker'))
  await expect(nativeImage('web')).rejects.toThrow('Immutable')
  expect(boundary.exec).not.toHaveBeenCalled()
})
test('two_image_authorities_or_wrong_loaded_platform_fail_closed',async()=>{
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE',reference);vi.stubEnv('SPARRA_TEST_WEB_IMAGE_ID',id)
  await expect(nativeImage('web')).rejects.toThrow('Ambiguous');expect(boundary.exec).not.toHaveBeenCalled()
  vi.stubEnv('SPARRA_TEST_WEB_IMAGE_ID',undefined)
  boundary.exec.mockResolvedValue({stdout:id+'|linux/arm64\n',stderr:''})
  await expect(nativeImage('web')).rejects.toThrow('mismatch')
})
