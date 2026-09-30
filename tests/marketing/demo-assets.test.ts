import { expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { demoScenarios } from '../../src/modules/marketing/demo-scenarios.generated'

test('both real MP3 illustrations decode and match their cues, text, receipt and provenance', () => {
  const source = JSON.parse(readFileSync('docs/demos/scenarios.fr.json', 'utf8'))
  const provenance = JSON.parse(readFileSync('docs/demos/audio-provenance.json', 'utf8'))
  expect(demoScenarios.map(s => s.id)).toEqual(['garage', 'controle-technique'])
  for (const scenario of demoScenarios) {
    const path = resolve('public' + scenario.audioSrc)
    const decoded = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', path], { encoding: 'utf8' }))
    expect(decoded.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: '24000', channels: 1 })
    expect(Number(decoded.streams[0].bit_rate)).toBe(64000)
    expect(Math.abs(Number(decoded.format.duration) - scenario.durationSeconds)).toBeLessThanOrEqual(.3)
    execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: 'pipe' })
    expect(scenario.cues[0].text).toContain('agent IA')
    let previous = 0
    for (const [index, cue] of scenario.cues.entries()) {
      expect(cue.startSeconds).toBeGreaterThanOrEqual(previous)
      if (index > 0) expect(cue.startSeconds - previous).toBeCloseTo(.35, 4)
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds)
      expect(cue.endSeconds).toBeLessThanOrEqual(scenario.durationSeconds)
      previous = cue.endSeconds
    }
    const editorial = source.find((s: { id: string }) => s.id === scenario.id)
    expect(scenario.cues.map(({ speaker, text }) => ({ speaker, text }))).toEqual(editorial.turns)
    expect(scenario.receipt).toEqual(editorial.receipt)
    const allText = JSON.stringify(scenario)
    expect(allText).not.toMatch(/\b(?:0\d(?:[ .-]?\d){8}|\+33\d{9})\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)
    expect(scenario.receipt.phone).toContain('fictif')
    expect(scenario.receipt.nextAction).toContain('confirmer')
    expect(scenario.receipt.summary).toMatch(scenario.id === 'garage' ? /révision/ : /contrôle technique/)
    expect(scenario.cues.map(c => c.text).join(' ')).toMatch(scenario.id === 'garage' ? /révision/ : /contrôle technique/)
    const proof = provenance.assets.find((a: { id: string }) => a.id === scenario.id)
    expect(proof.sha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'))
    expect(proof.durationSeconds).toBe(scenario.durationSeconds)
  }
  expect(provenance.scenarioSha256).toBe(createHash('sha256').update(readFileSync('docs/demos/scenarios.fr.json')).digest('hex'))
}, 30000)

test('offline generation preview preserves deliverables and lists exactly ten verbatim French turns', () => {
  const paths = ['src/modules/marketing/demo-scenarios.generated.ts', 'docs/demos/audio-provenance.json', 'public/demos/garage-revision.mp3', 'public/demos/controle-technique.mp3']
  const before = paths.map(path => readFileSync(path))
  const preview = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/generate-demo-audio.ps1', '-DryRun'], { encoding: 'utf8' }))
  const source = JSON.parse(readFileSync('docs/demos/scenarios.fr.json', 'utf8'))
  expect(preview.model).toBe('x-ai/grok-voice-tts-1.0')
  expect(preview.requestCount).toBe(10)
  // Delivered request identities must remain non-billable even when build erased old raw caches.
  expect(preview.cachedTurns + preview.recoveryRequired).toBe(10)
  expect(preview.uncachedCalls).toBe(0)
  expect(preview.requests.map((turn: { scenario: string; voice: string; characters: number }) => [turn.scenario, turn.voice, turn.characters])).toEqual(
    source.flatMap((scenario: { id: string; turns: { speaker: string; text: string }[] }) => scenario.turns.map(turn => [scenario.id, turn.speaker === 'sparra' ? 'ara' : 'sal', turn.text.length])),
  )
  expect(paths.map(path => readFileSync(path))).toEqual(before)
}, 30000)

test('generation refuses oversized text before changing deliverables', () => {
  const source = JSON.parse(readFileSync('docs/demos/scenarios.fr.json', 'utf8'))
  source[0].turns[1].text = 'Bonjour '.repeat(100)
  const paths = ['src/modules/marketing/demo-scenarios.generated.ts', 'docs/demos/audio-provenance.json', 'public/demos/garage-revision.mp3', 'public/demos/controle-technique.mp3']
  const before = paths.map(path => readFileSync(path))
  const directory = mkdtempSync(resolve('.output/demo-invalid-'))
  try {
    const sourcePath = resolve(directory, 'oversized.json')
    writeFileSync(sourcePath, JSON.stringify(source))
    let rejection = ''
    try {
      execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/generate-demo-audio.ps1', '-SourcePath', sourcePath, '-DryRun'], { stdio: 'pipe' })
    } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error) rejection = String(error.stderr)
    }
    expect(rejection).toContain('Dialogue text exceeds')
    expect(paths.map(path => readFileSync(path))).toEqual(before)
  } finally { rmSync(directory, { recursive: true }) }
}, 30000)

test('an uncertain synthesis attempt blocks preview until recover-only assessment', () => {
  const source = JSON.parse(readFileSync('docs/demos/scenarios.fr.json', 'utf8'))
  source[0].turns[0].text += ' Cet exemple reste fictif.'
  const directory = mkdtempSync(resolve('.output/demo-invalid-'))
  let marker: string | undefined
  try {
    const sourcePath = resolve(directory, 'uncertain.json')
    writeFileSync(sourcePath, JSON.stringify(source))
    const args = ['-NoProfile', '-File', 'scripts/generate-demo-audio.ps1', '-SourcePath', sourcePath, '-DryRun']
    const preview = JSON.parse(execFileSync('pwsh', args, { encoding: 'utf8' }))
    const turn = preview.requests[0]
    mkdirSync('.demo-audio-cache/segments', { recursive: true })
    const candidate = resolve(`.demo-audio-cache/segments/${turn.scenario}-${turn.index}-${turn.requestSha256}.json`)
    expect(existsSync(candidate)).toBe(false)
    writeFileSync(candidate, JSON.stringify({ state: 'attempted' }), { flag: 'wx' }); marker = candidate
    let rejection = ''
    try { execFileSync('pwsh', args, { stdio: 'pipe' }) } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error) rejection = String(error.stderr)
    }
    expect(rejection).toContain('recover-only assessment')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ state: 'attempted' })
  } finally {
    if (marker) rmSync(marker)
    rmSync(directory, { recursive: true })
  }
}, 30000)

test.each(['unknown', 'duplicate', 'escape', 'case'])('generator rejects %s before changing any output', kind => {
  const source = JSON.parse(readFileSync('docs/demos/scenarios.fr.json', 'utf8'))
  if (kind === 'unknown') source[0].id = 'autre'
  if (kind === 'case') source[0].id = 'Garage'
  if (kind === 'duplicate') source[1].id = source[0].id
  if (kind === 'escape') source[0].audioSrc = '/../../escaped.mp3'
  const paths = ['src/modules/marketing/demo-scenarios.generated.ts', 'docs/demos/audio-provenance.json', 'public/demos/garage-revision.mp3', 'public/demos/controle-technique.mp3']
  const before = paths.map(path => readFileSync(path))
  mkdirSync('.output/demo-generation', { recursive: true })
  const marker = '.output/demo-generation/validation-marker'
  writeFileSync(marker, 'must survive rejected input')
  const directory = mkdtempSync(resolve('.output/demo-invalid-'))
  try {
    const sourcePath = resolve(directory, 'invalid.json')
    writeFileSync(sourcePath, JSON.stringify(source))
    let rejection = ''
    try {
      execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/generate-demo-audio.ps1', '-SourcePath', sourcePath], { stdio: 'pipe' })
    } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error) rejection = String(error.stderr)
    }
    expect(rejection).toContain(kind === 'escape' ? 'Audio target must match' : 'Unknown or duplicate scenario ID')
    expect(paths.map(path => readFileSync(path))).toEqual(before)
    expect(readFileSync(marker, 'utf8')).toBe('must survive rejected input')
  } finally {
    // Preserve owned deliverables even when a regression makes invalid input reach generation.
    paths.forEach((path, index) => { if (!readFileSync(path).equals(before[index]!)) writeFileSync(path, before[index]!) })
    rmSync(directory, { recursive: true }); rmSync(marker, { force: true })
  }
}, 30000)
