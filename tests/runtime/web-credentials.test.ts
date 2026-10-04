import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const files = vi.hoisted(() => ({ value: 'synthetic-credential-'.repeat(3), mutation: '', reads: 0, values: new Map<string,string>(),mode:0o100440,uid:0,gid:10001,regular:true,buffers:new Array<Buffer>() }))
vi.mock('node:fs/promises', () => {
  const content=(path:string)=>files.values.get(path.split('/').at(-1)??'')??files.value
  const stat = (path:string) => ({ isDirectory: () => path==='/run/secrets', isFile: () => path!=='/run/secrets'&&files.regular, isSymbolicLink: () => false,
    mode: path==='/run/secrets' ? 0o40750 : files.mode, uid: path==='/run/secrets'?0:files.uid, gid: path==='/run/secrets'?10001:files.gid, ino: path==='/run/secrets' ? 1 : files.mutation==='replacement'&&files.reads ? 3:2, dev: 1,
    size: path==='/run/secrets' ? 0 : Buffer.byteLength(content(path)), mtimeMs: 1, ctimeMs: 1 })
  return { realpath: async (path: string) => files.mutation === 'parent-link' && path === '/run/secrets' ? '/other' : path,
    lstat: async (path: string) => { if (files.mutation === 'missing') throw new Error('synthetic-only-sentinel'); return stat(path) },
    open: async (path:string) => ({ stat: async () => stat(path), close: async () => {}, read: async (buffer: Buffer, offset: number) => {
      files.buffers.push(buffer)
      if (offset) return { bytesRead: 0 }; const bytes = Buffer.from(content(path)); bytes.copy(buffer); files.reads++; return { bytesRead: bytes.length }
    } }) }
})
const keys = ['DATABASE_URL', 'REDIS_URL', 'RATE_LIMIT_HMAC_SECRET', 'AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
beforeEach(() => { vi.resetModules(); files.mutation = ''; files.reads = 0;files.values.clear();files.mode=0o100440;files.uid=0;files.gid=10001;files.regular=true;files.buffers=[]; files.value = 'synthetic-credential-'.repeat(3); for (const key of [...keys, 'MIGRATION_DATABASE_URL', 'AUTH_MAIL_KEYS_JSON']) vi.stubEnv(key, undefined) })
afterEach(() => vi.unstubAllEnvs())

test.each(keys)('direct_env_even_empty_is_ambiguous: %s', async key => {
  const { loadWebCredentials } = await import('../../scripts/web-credentials.mjs')
  vi.stubEnv(key, '')
  await expect(loadWebCredentials()).rejects.toThrow()
  expect(files.reads).toBe(0)
  for (const other of keys.filter(value => value !== key)) expect(process.env[other]).toBeUndefined()
})
test.each(['MIGRATION_DATABASE_URL', 'AUTH_MAIL_KEYS_JSON'])('cross_scope_authority_is_refused: %s', async key => {
  const { loadWebCredentials } = await import('../../scripts/web-credentials.mjs'); vi.stubEnv(key, '')
  await expect(loadWebCredentials()).rejects.toThrow(); expect(files.reads).toBe(0)
})
test.each(['', 'bad\n', 'bad\r', 'bad\0', ' outer', 'outer ', 'x'.repeat(16385), 'not-a-postgres-url'])('invalid_file_never_partially_assigns', async value => {
  files.value = value
  const { loadWebCredentials } = await import('../../scripts/web-credentials.mjs')
  await expect(loadWebCredentials()).rejects.toThrow()
  for (const key of keys) expect(process.env[key]).toBeUndefined()
})
test('parent_symlink_is_refused_before_read', async () => {
  files.mutation = 'parent-link'
  const { readFixedCredentialFile } = await import('../../scripts/fixed-credential-file.mjs')
  await expect(readFixedCredentialFile('app_auth_secret')).rejects.toThrow(); expect(files.reads).toBe(0)
})
test('unknown_fixed_file_cannot_expand_scope', async () => {
  const { readFixedCredentialFile } = await import('../../scripts/fixed-credential-file.mjs')
  await expect(readFixedCredentialFile('../provider_api_key')).rejects.toThrow(); expect(files.reads).toBe(0)
})
const valid=[['app_database_url','postgresql://synthetic:synthetic@pg:5432/auth'],['app_redis_url','redis://:synthetic@redis:6379/0'],
  ['app_rate_limit_hmac_secret','h'.repeat(32)],['app_auth_secret','a'.repeat(32)],['app_google_client_id','synthetic-client'],['app_google_client_secret','synthetic-secret']]
test('all_six_assign_only_after_complete_validation',async()=>{
  for(const [name,value]of valid)files.values.set(name,value)
  const {loadWebCredentials}=await import('../../scripts/web-credentials.mjs');await loadWebCredentials()
  for(const [index,key]of keys.entries())expect(process.env[key]).toBe(valid[index][1])
  expect(files.buffers.every(buffer=>buffer.every(byte=>byte===0))).toBe(true)
})
test.each(valid.map(([name])=>name))('late_missing_or_empty_file_never_partially_assigns: %s',async name=>{
  for(const [key,value]of valid)files.values.set(key,value);files.values.set(name,'')
  const {loadWebCredentials}=await import('../../scripts/web-credentials.mjs')
  await expect(loadWebCredentials()).rejects.toThrow()
  for(const key of keys)expect(process.env[key]).toBeUndefined()
})
test('replacement_during_descriptor_read_is_refused',async()=>{
  files.mutation='replacement'
  const {readFixedCredentialFile}=await import('../../scripts/fixed-credential-file.mjs')
  await expect(readFixedCredentialFile('app_auth_secret')).rejects.toThrow()
})
test.each([0o100400,0o100640,0o100444])('exact_linux_file_mode_is_required: %i',async mode=>{
  files.mode=mode;const {readFixedCredentialFile}=await import('../../scripts/fixed-credential-file.mjs')
  await expect(readFixedCredentialFile('app_auth_secret')).rejects.toThrow()
})
test.each(['uid','gid','regular'] as const)('root_group_regular_admission_is_required: %s',async mutation=>{
  if(mutation==='uid')files.uid=10001;else if(mutation==='gid')files.gid=0;else files.regular=false
  const {readFixedCredentialFile}=await import('../../scripts/fixed-credential-file.mjs')
  await expect(readFixedCredentialFile('app_auth_secret')).rejects.toThrow()
})
