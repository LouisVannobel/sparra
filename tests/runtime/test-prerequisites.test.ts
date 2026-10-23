// Installer admission and browser ownership only; doubles do not qualify Chromium.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const controlled = vi.hoisted(() => ({ spawnSync: vi.fn(), launch: vi.fn(), close: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: controlled.spawnSync }))
vi.mock('playwright', () => ({ chromium: { launch: controlled.launch } }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
if(!platform)throw new Error('Missing test platform descriptor')
const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted' }
const missing = () => new Error("browserType.launch: Executable doesn't exist at /owned/missing-browser")
const modulePath = '../../scripts/test-prerequisites.mjs'
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  for (const key of Object.keys(hosted)) vi.stubEnv(key, '')
  controlled.spawnSync.mockReturnValue({ status: 0 })
  controlled.close.mockResolvedValue(undefined)
  controlled.launch.mockResolvedValue({ close: controlled.close })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs() })

test('canonical browser prerequisite awaits native launch and close without installing', async () => {
  await import(modulePath)
  expect(controlled.launch).toHaveBeenCalledExactlyOnceWith({ headless: true, timeout: 10000 })
  expect(controlled.close).toHaveBeenCalledTimes(1)
  expect(controlled.spawnSync.mock.calls.map(call => call[0])).toEqual(['ffmpeg', 'ffprobe'])
})

test.each([
  ['CI', 'false'], ['GITHUB_ACTIONS', 'false'], ['RUNNER_OS', 'Windows'],
  ['RUNNER_ENVIRONMENT', 'self-hosted'], ['platform', 'darwin'],
] as const)('missing browser cannot authorize installation when %s is %s', async (field, value) => {
  for (const [key, setting] of Object.entries(hosted)) vi.stubEnv(key, setting)
  if (field === 'platform') Object.defineProperty(process, 'platform', { ...platform, value })
  else vi.stubEnv(field, value)
  controlled.launch.mockRejectedValue(missing())
  await expect(import(modulePath)).rejects.toThrow('Tests require local Playwright Chromium; no local installation attempted')
  expect(controlled.spawnSync.mock.calls.map(call => call[0])).toEqual(['ffmpeg', 'ffprobe'])
  expect(controlled.close).not.toHaveBeenCalled()
})

test('exact hosted provenance installs declared native CLI and re-probes its headless browser', async () => {
  for (const [key, setting] of Object.entries(hosted)) vi.stubEnv(key, setting)
  controlled.launch.mockRejectedValueOnce(missing())
  await import(modulePath)
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js')
  expect(controlled.spawnSync).toHaveBeenNthCalledWith(3, process.execPath,
    [cli, 'install', '--with-deps', 'chromium'], { stdio: 'inherit', timeout: 120000, windowsHide: true })
  expect(controlled.launch).toHaveBeenCalledTimes(2)
  expect(controlled.close).toHaveBeenCalledTimes(1)
})

test('a non-missing launch failure never invokes an installer', async () => {
  for (const [key, setting] of Object.entries(hosted)) vi.stubEnv(key, setting)
  controlled.launch.mockRejectedValue(new Error('Controlled browser launch failed'))
  await expect(import(modulePath)).rejects.toThrow('Playwright Chromium prerequisite probe failed')
  expect(controlled.spawnSync.mock.calls.map(call => call[0])).toEqual(['ffmpeg', 'ffprobe'])
})

test('browser cleanup failure cannot be admitted or repaired by installation', async () => {
  controlled.close.mockRejectedValue(new Error('Controlled browser close failed'))
  await expect(import(modulePath)).rejects.toThrow('Playwright Chromium prerequisite cleanup failed')
  expect(controlled.close).toHaveBeenCalledTimes(1)
  expect(controlled.spawnSync.mock.calls.map(call => call[0])).toEqual(['ffmpeg', 'ffprobe'])
})

test('failed hosted installer refuses readiness without a second browser launch', async () => {
  for (const [key, setting] of Object.entries(hosted)) vi.stubEnv(key, setting)
  controlled.launch.mockRejectedValue(missing())
  controlled.spawnSync.mockImplementation(command => ({ status: command === process.execPath ? 1 : 0 }))
  await expect(import(modulePath)).rejects.toThrow('Hosted test browser installation failed')
  expect(controlled.launch).toHaveBeenCalledTimes(1)
})

test('a still-missing browser after installation refuses readiness without another install', async () => {
  for (const [key, setting] of Object.entries(hosted)) vi.stubEnv(key, setting)
  controlled.launch.mockRejectedValue(missing())
  await expect(import(modulePath)).rejects.toThrow('Hosted test browser prerequisites remain unavailable')
  expect(controlled.spawnSync.mock.calls.filter(call => call[0] === process.execPath)).toHaveLength(1)
  expect(controlled.launch).toHaveBeenCalledTimes(2)
})

const installerFailures=[
  {name:'nonzero',result:{status:37,signal:null},expected:{status:37,code:null,signal:null}},
  {name:'timeout',result:{status:null,error:{code:'ETIMEDOUT',message:'owned-private-message'},signal:'SIGTERM'},expected:{status:null,code:'ETIMEDOUT',signal:'SIGTERM'}},
  {name:'spawn-error',result:{status:null,error:{code:'ENOENT',message:'owned-private-message'},signal:null},expected:{status:null,code:'ENOENT',signal:null}},
  {name:'unsafe-fields',result:{status:1,error:{code:'owned-private-message\n',message:'owned-private-message'},signal:'owned-private-message'},expected:{status:1,code:null,signal:null}},
]
for(const stage of ['decoder-update','decoder-install','browser-install'] as const){
  test.each(installerFailures)('installer '+stage+' reports safe $name metadata and still refuses readiness',async({result,expected})=>{
    for(const [key,setting] of Object.entries(hosted))vi.stubEnv(key,setting)
    if(stage==='browser-install')controlled.launch.mockRejectedValueOnce(missing())
    controlled.spawnSync.mockImplementation((command,args)=>{
      if(stage!=='browser-install'&&command==='ffmpeg')return {status:1}
      const selected=stage==='browser-install'?command===process.execPath:command==='sudo'&&args[1]===(stage==='decoder-update'?'update':'install')
      return selected?result:{status:0}
    })
    const failure=await import(modulePath).then(()=>null,error=>error)
    expect(failure).toBeInstanceOf(Error)
    if(!(failure instanceof Error))throw new Error('Expected installer refusal')
    expect(failure.message).toContain(stage==='browser-install'?'Hosted test browser installation failed':'Hosted test decoder installation failed')
    expect(failure.message).toContain(JSON.stringify({stage,...expected}))
    expect(failure.message).not.toContain('owned-private-message')
    expect(controlled.close).not.toHaveBeenCalled()
    expect(controlled.launch).toHaveBeenCalledTimes(stage==='browser-install'?1:0)
    const installers=controlled.spawnSync.mock.calls.filter(([command])=>command==='sudo'||command===process.execPath)
    expect(installers).toHaveLength(stage==='decoder-install'?2:1)
    expect(installers.every(([, , options])=>options.timeout===120000)).toBe(true)
  })
}
