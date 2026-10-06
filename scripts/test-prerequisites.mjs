import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const hostedLinux = process.platform === 'linux' && process.env.CI === 'true'
  && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted'

const decoderAvailable = () => ['ffmpeg', 'ffprobe'].every(command =>
  spawnSync(command, ['-version'], { stdio: 'ignore', timeout: 10000, windowsHide: true }).status === 0)

if (!decoderAvailable()) {
  if (!hostedLinux) throw new Error('Tests require local ffmpeg and ffprobe; no local installation attempted')
  for (const args of [['apt-get', 'update'], ['apt-get', 'install', '--no-install-recommends', '-y', 'ffmpeg']]) {
    const result = spawnSync('sudo', args, { stdio: 'inherit', timeout: 120000 })
    if (result.status !== 0) throw new Error('Hosted test decoder installation failed')
  }
  if (!decoderAvailable()) throw new Error('Hosted test decoder prerequisites remain unavailable')
}

async function browserAvailable() {
  let browser
  try { browser = await chromium.launch({ headless: true, timeout: 10000 }) }
  catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist at")) return false
    throw new Error('Playwright Chromium prerequisite probe failed')
  }
  try { await browser.close() }
  catch { throw new Error('Playwright Chromium prerequisite cleanup failed') }
  return true
}

if (!await browserAvailable()) {
  if (!hostedLinux) throw new Error('Tests require local Playwright Chromium; no local installation attempted')
  const require = createRequire(import.meta.url), metadata = require('playwright/package.json')
  if (metadata.name !== 'playwright' || metadata.version !== '1.62.1' || metadata.bin?.playwright !== 'cli.js') {
    throw new Error('Native Playwright CLI pin mismatch')
  }
  const cli = join(dirname(require.resolve('playwright/package.json')), metadata.bin.playwright)
  const result = spawnSync(process.execPath, [cli, 'install', '--with-deps', 'chromium'], {
    stdio: 'inherit', timeout: 120000, windowsHide: true,
  })
  if (result.status !== 0) throw new Error('Hosted test browser installation failed')
  if (!await browserAvailable()) throw new Error('Hosted test browser prerequisites remain unavailable')
}
