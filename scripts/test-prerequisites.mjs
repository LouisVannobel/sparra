import { spawnSync } from 'node:child_process'

const decoderAvailable = () => ['ffmpeg', 'ffprobe'].every(command =>
  spawnSync(command, ['-version'], { stdio: 'ignore', timeout: 10000, windowsHide: true }).status === 0)

if (!decoderAvailable()) {
  const hostedLinux = process.platform === 'linux' && process.env.CI === 'true'
    && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  if (!hostedLinux) throw new Error('Tests require local ffmpeg and ffprobe; no local installation attempted')
  for (const args of [['apt-get', 'update'], ['apt-get', 'install', '--no-install-recommends', '-y', 'ffmpeg']]) {
    const result = spawnSync('sudo', args, { stdio: 'inherit', timeout: 120000 })
    if (result.status !== 0) throw new Error('Hosted test decoder installation failed')
  }
  if (!decoderAvailable()) throw new Error('Hosted test decoder prerequisites remain unavailable')
}
