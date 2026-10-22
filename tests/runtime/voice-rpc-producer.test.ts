import { afterEach, expect, test, vi } from 'vitest'
import { nativeVoice } from '../helpers/sparra-voice-driver'

afterEach(()=>vi.unstubAllEnvs())

test('native RPC refuses an invalid explicitly selected producer before dispatch',async()=>{
  vi.stubEnv('SPARRA_VOICE_TEST_ROOT','relative-unqualified-source')
  await expect(nativeVoice({action:'aggregate_size',turns:{}})).rejects.toThrow('Voice producer requires an explicit absolute root')
})
