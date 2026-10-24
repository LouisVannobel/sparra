import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createLintFixture } from '../helpers/ordinary-fixture-isolation'
import { workerOciFixture } from '../helpers/migrator-oci-fixture'
import { workerSourceManifest } from '../../scripts/worker-source-manifest.mjs'
import { verifyWorkerArtifact } from '../../scripts/verify-worker-release.mjs'

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const commit = 'a'.repeat(40)

test('checkout source receipt remains valid during lint fixture use and adverse cleanup', async () => {
  const repositoryRoot = process.cwd()
  const checkoutSource = await workerSourceManifest(repositoryRoot)
  const owned = mkdtempSync(join(tmpdir(), 'sparra-fixture-race-'))
  let lintFixture: ReturnType<typeof createLintFixture> | undefined
  try {
    for (const path of ['package.json', 'vite.worker.config.ts', 'pnpm-lock.yaml', 'Dockerfile',
      'patches/@hatchet-dev__typescript-sdk@1.28.2.patch', 'patches/nice-grpc@2.1.17.patch']) {
      const target = join(owned, path)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(repositoryRoot, path), target)
    }
    mkdirSync(join(owned, 'src'))
    const foreign = join(owned, 'src', 'foreign-marker.txt')
    writeFileSync(foreign, 'owned foreign source must survive\n')
    const artifact = join(owned, 'artifact')
    mkdirSync(artifact)
    process.chdir(owned)
    const initial = await workerSourceManifest()
    const image = await workerOciFixture(), sbom = JSON.stringify(image.sbom)
    const receipt = { ...initial, commit, image_id: image.imageId, platform: 'linux/amd64',
      archive_sha256: hash(image.archive), sbom_sha256: hash(sbom), run_id: 'owned-race-reproduction',
      checks: { closure: true, registration: true, clean_exit: true, cleanup: true, archive_reload: false } }
    writeFileSync(join(artifact, 'worker-image.tar'), image.archive)
    writeFileSync(join(artifact, 'worker-sbom.spdx.json'), sbom)
    writeFileSync(join(artifact, 'worker-receipt.json'), JSON.stringify(receipt))
    await expect(verifyWorkerArtifact(artifact, commit, 'candidate')).resolves.toEqual(receipt)
    lintFixture = createLintFixture(owned, repositoryRoot)
    expect(lintFixture.acceptedFiles.every(path => path.startsWith('src/'))).toBe(true)
    expect(lintFixture.rejectedFiles.every(path => path.startsWith('src/'))).toBe(true)
    expect(readFileSync(join(lintFixture.root, '.oxlintrc.json'))).toEqual(readFileSync(join(repositoryRoot, '.oxlintrc.json')))
    const verifyPluginCopy = (relativePath: string): void => {
      const source = join(repositoryRoot, relativePath), copy = join(lintFixture!.root, relativePath)
      const entries = readdirSync(source, { withFileTypes: true })
      expect(readdirSync(copy).sort()).toEqual(entries.map(entry => entry.name).sort())
      for (const entry of entries) {
        const path = join(relativePath, entry.name)
        if (entry.isDirectory()) verifyPluginCopy(path)
        else expect(readFileSync(join(lintFixture!.root, path))).toEqual(readFileSync(join(repositoryRoot, path)))
      }
    }
    verifyPluginCopy('tools/oxlint/anti-slop')
    expect(await workerSourceManifest(repositoryRoot)).toEqual(checkoutSource)
    await expect(verifyWorkerArtifact(artifact, commit, 'candidate')).resolves.toEqual(receipt)
    expect(await workerSourceManifest()).toEqual(initial)
    // Model a failed case after writing its fixture; owner cleanup still has to preserve foreign source.
    writeFileSync(join(lintFixture.root, lintFixture.acceptedFiles[0]!), 'adverse fixture mutation\n')
    lintFixture.cleanup(); lintFixture = undefined
    expect(await workerSourceManifest()).toEqual(initial)
    await expect(verifyWorkerArtifact(artifact, commit, 'candidate')).resolves.toEqual(receipt)
    expect(readFileSync(foreign, 'utf8')).toBe('owned foreign source must survive\n')
    expect(await workerSourceManifest(repositoryRoot)).toEqual(checkoutSource)
  } finally {
    try { lintFixture?.cleanup() } finally {
      process.chdir(repositoryRoot)
      const target = resolve(owned)
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('sparra-fixture-race-')) throw new Error('Non-owned race fixture cleanup')
      rmSync(target, { recursive: true })
    }
  }
}, 30000)
