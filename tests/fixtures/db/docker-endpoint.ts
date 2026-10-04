import { lstat } from 'node:fs/promises'

type FixtureDockerEndpoint = Readonly<{ args: readonly string[]; endpoint: string }>
export function fixtureDockerEndpoint(platform: NodeJS.Platform): FixtureDockerEndpoint {
  if (platform === 'win32') return { args: ['--context', 'desktop-linux'], endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine' }
  if (platform === 'linux') return { args: ['--host', 'unix:///var/run/docker.sock'], endpoint: 'unix:///var/run/docker.sock' }
  throw new Error('Disposable fixture requires Windows or Linux local Docker transport')
}

export function fixtureDockerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE'].flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]]]))
}

/** Linux private bind files remain 0700/0600 and readable only by their creator. */
export function fixtureDockerFileUser(platform: NodeJS.Platform, uid: number | undefined, gid: number | undefined): readonly string[] {
  fixtureDockerEndpoint(platform)
  if (platform === 'win32') return []
  if (uid === undefined || gid === undefined || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid < 0) {
    throw new Error('Linux private fixture files require a known nonroot creator UID and GID')
  }
  return ['--user', `${uid}:${gid}`]
}

export async function assertFixtureDockerEndpoint(platform: NodeJS.Platform, endpoint: string): Promise<void> {
  if (endpoint !== fixtureDockerEndpoint(platform).endpoint) throw new Error('Fixture Docker endpoint is not the authorized local transport')
  if (platform === 'linux') {
    try {
      const socket = await lstat('/var/run/docker.sock')
      if (socket.isSymbolicLink() || !socket.isSocket()) throw new Error()
    } catch { throw new Error('Fixture requires a nonsymlink local Unix Docker socket') }
  }
}
