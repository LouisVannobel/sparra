import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixtureDockerEndpoint, fixtureDockerEnvironment } from '../fixtures/db/docker-endpoint'
const exec = promisify(execFile)
export async function nativeImage(target: 'web' | 'migrator') {
  const selected = target === 'migrator' ? process.env.SPARRA_TEST_MIGRATOR_IMAGE_ID : process.env.SPARRA_TEST_WEB_IMAGE_ID
  if (selected !== undefined && !/^sha256:[0-9a-f]{64}$/.test(selected)) throw new Error('Immutable test image required')
  const args = fixtureDockerEndpoint(process.platform).args
  if (selected) {
    const result = await exec('docker', [...args, 'image', 'inspect', selected, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}'], { env: fixtureDockerEnvironment(), windowsHide: true })
    if (result.stdout.trim() !== selected + '|linux/amd64') throw new Error('Loaded image mismatch')
    return selected
  }
  const tag = 'sparra-' + target + ':qualification'
  await exec('docker', [...args, 'build', '--platform', 'linux/amd64', '--target', target, '--tag', tag, '.'], { env: { ...fixtureDockerEnvironment(), ...(process.platform === 'win32' ? { ProgramFiles: process.env.ProgramFiles } : {}) }, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 })
  const id = (await exec('docker', [...args, 'image', 'inspect', tag, '--format', '{{.Id}}'], { env: fixtureDockerEnvironment(), windowsHide: true })).stdout.trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error('Immutable image ID missing')
  console.log('NATIVE_IMAGE_ID ' + target + ' ' + id)
  return id
}
