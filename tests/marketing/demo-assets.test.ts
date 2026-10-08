import { expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs'
import { resolve, sep, dirname, basename } from 'node:path'
import { demoScenarios } from '../../src/modules/marketing/demo-scenarios.generated'

const offlineEnv = Object.fromEntries(Object.keys(process.env).filter(name => name.toUpperCase() !== 'OPENROUTER_API_KEY').map(name => [name, process.env[name]]))

function nativeContainmentFailure(error: unknown) {
  const stderr = error && typeof error === 'object' && 'stderr' in error
    ? typeof error.stderr === 'string' ? error.stderr : Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : '' : ''
  // Eight fixed stages and nine fixed cases, bounded by the requested child budget.
  const phases = stderr.split(/\r?\n/).filter(line => {
    const match = /^(?:CONTAINMENT_STAGE (?:startup|cwd|parsed|found|loaded|read|read_done|json)|CONTAINMENT_CASE (?:descendant|trailing-parent|root|trailing-root|sibling-prefix|relative-escape|case-policy|hidden-ancestor|redirected-hidden-ancestor)) ([0-9]{1,5})$/.exec(line)
    return match !== null && Number(match[1]) <= 30000
  }).slice(0, 17)
  const reason = error && typeof error === 'object' && 'code' in error && error.code === 'ETIMEDOUT' ? 'timeout' : 'child'
  return new Error('Native containment failed: ' + reason + '\nContainment phases: ' + (phases.join('; ') || 'none'))
}

function readNativeContainmentResults(output: string): unknown {
  let result: unknown
  try { result = JSON.parse(output) } catch { throw new Error('Native containment failed: stdout') }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 2 || !('processingElapsedMs' in result) || !('results' in result)) throw new Error('Native containment failed: measurement')
  const elapsed = result.processingElapsedMs
  if (typeof elapsed !== 'number' || !Number.isSafeInteger(elapsed) || elapsed < 0) throw new Error('Native containment failed: measurement')
  if (elapsed > 10000) throw new Error('Native containment failed: processing-budget')
  return result.results
}

function assertNativeContainmentResults(results: unknown, cases: readonly { name: string; accepted: boolean }[]) {
  if (!Array.isArray(results) || results.length !== cases.length || !results.every((row, index) =>
    row !== null && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === 3 &&
    row.name === cases[index]!.name && row.accepted === cases[index]!.accepted &&
    row.rejection === (cases[index]!.accepted ? null : cases[index]!.name === 'redirected-hidden-ancestor' ? 'redirected' : 'escape'),
  )) throw new Error('Native containment failed: results')
}

test('native generator containment admits only descendants with the host path case policy', () => {
  const owned = mkdtempSync(resolve('.output/demo-containment-'))
  try {
  const hidden = resolve(owned, '.hidden'), destination = resolve(owned, 'target'), redirected = resolve(hidden, '.redirected')
  mkdirSync(hidden); mkdirSync(destination); symlinkSync(destination, redirected, 'junction')
  const cases = [
    { name: 'descendant', path: owned + sep + 'inside.json', directory: owned, accepted: true },
    { name: 'trailing-parent', path: owned + sep + 'inside.json', directory: owned + sep, accepted: true },
    { name: 'root', path: owned, directory: owned, accepted: false },
    { name: 'trailing-root', path: owned + sep, directory: owned, accepted: false },
    { name: 'sibling-prefix', path: owned + '-sibling' + sep + 'outside.json', directory: owned, accepted: false },
    { name: 'relative-escape', path: owned + sep + '..' + sep + 'outside.json', directory: owned, accepted: false },
    { name: 'case-policy', path: owned + sep + 'inside.json', directory: owned.toUpperCase(), accepted: process.platform === 'win32' },
    { name: 'hidden-ancestor', path: hidden + sep + 'inside.json', directory: owned, accepted: true },
    { name: 'redirected-hidden-ancestor', path: redirected + sep + 'inside.json', directory: owned, accepted: false },
  ]
  // Invoke the actual function AST only; metadata fixtures stay in this owned directory.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$timer = [Diagnostics.Stopwatch]::StartNew()
[Console]::Error.WriteLine('CONTAINMENT_STAGE startup ' + $timer.ElapsedMilliseconds)
$repo = [IO.Path]::GetFullPath([Environment]::CurrentDirectory)
[Console]::Error.WriteLine('CONTAINMENT_STAGE cwd ' + $timer.ElapsedMilliseconds)
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::Combine($repo, 'scripts/generate-demo-audio.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Generator parse failed' }
[Console]::Error.WriteLine('CONTAINMENT_STAGE parsed ' + $timer.ElapsedMilliseconds)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-Contained' }, $false)
if (-not $function) { throw 'Missing containment consumer' }
[Console]::Error.WriteLine('CONTAINMENT_STAGE found ' + $timer.ElapsedMilliseconds)
Invoke-Expression $function.Extent.Text
[Console]::Error.WriteLine('CONTAINMENT_STAGE loaded ' + $timer.ElapsedMilliseconds)
[Console]::Error.WriteLine('CONTAINMENT_STAGE read ' + $timer.ElapsedMilliseconds)
$caseInput = [Console]::In.ReadToEnd()
[Console]::Error.WriteLine('CONTAINMENT_STAGE read_done ' + $timer.ElapsedMilliseconds)
$cases = $caseInput | ConvertFrom-Json
[Console]::Error.WriteLine('CONTAINMENT_STAGE json ' + $timer.ElapsedMilliseconds)
if ($IsWindows) {
  $hidden = [IO.Path]::GetDirectoryName(($cases | Where-Object name -CEQ 'hidden-ancestor').path)
  [IO.File]::SetAttributes($hidden, ([IO.File]::GetAttributes($hidden) -bor [IO.FileAttributes]::Hidden))
}
$results = foreach ($case in $cases) {
  [Console]::Error.WriteLine('CONTAINMENT_CASE ' + $case.name + ' ' + $timer.ElapsedMilliseconds)
  $accepted = $false; $rejection = $null
  try { $null = Assert-Contained $case.path $case.directory; $accepted = $true }
  catch {
    if ($_.Exception.Message -ceq 'Output target escapes its owned directory') { $rejection = 'escape' }
    elseif ($_.Exception.Message -ceq 'Refusing a redirected filesystem target') { $rejection = 'redirected' }
    else { throw 'Unexpected containment failure' }
  }
  @{ name = $case.name; accepted = $accepted; rejection = $rejection }
}
$resultsJson = ConvertTo-Json -InputObject @($results) -Compress
$timer.Stop()
# Only the tiny measurement envelope formatting/emission is outside processing.
'{"processingElapsedMs":' + $timer.ElapsedMilliseconds + ',"results":' + $resultsJson + '}'
`
  let output: string
  try {
    // Requested child deadline includes startup; processing keeps its own 10 s gate.
    output = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: 'pipe', input: JSON.stringify(cases), timeout: 30000, maxBuffer: 16384, env: { ...offlineEnv, POWERSHELL_TELEMETRY_OPTOUT: '1' } })
  } catch (error) {
    throw nativeContainmentFailure(error)
  }
  assertNativeContainmentResults(readNativeContainmentResults(output), cases)
  } finally {
    const cleanup = resolve(owned)
    if (dirname(cleanup) !== resolve('.output') || !basename(cleanup).startsWith('demo-containment-')) throw new Error('Non-owned containment fixture cleanup')
    rmSync(cleanup, { recursive: true })
  }
}, 35000)

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
  const preview = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/generate-demo-audio.ps1', '-DryRun'], { encoding: 'utf8', env: offlineEnv }))
  const source = JSON.parse(readFileSync('docs/demos/scenarios.fr.json', 'utf8'))
  expect(preview.model).toBe('microsoft/mai-voice-2.1-flash')
  expect(preview.requestCount).toBe(10)
  // Delivered request identities must remain non-billable even when build erased old raw caches.
  expect(preview.cachedTurns + preview.recoveryRequired).toBe(10)
  expect(preview.uncachedCalls).toBe(0)
  expect(preview.requests.map((turn: { scenario: string; voice: string; characters: number }) => [turn.scenario, turn.voice, turn.characters])).toEqual(
    source.flatMap((scenario: { id: string; turns: { speaker: string; text: string }[] }) => scenario.turns.map(turn => [scenario.id, turn.speaker === 'sparra' ? 'fr-FR-Soleil:MAI-Voice-2.1-Flash' : 'fr-FR-Marc:MAI-Voice-2.1-Flash', turn.text.length])),
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

function copyAvailableSuccessRecords(source: string, target: string) {
  if (!existsSync(source)) return
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) copyFileSync(resolve(source, name), resolve(target, name))
}

function generatorRejection(script: string, args: readonly string[]) {
  try { execFileSync('pwsh', ['-NoProfile', '-File', script, ...args], { stdio: 'pipe', env: offlineEnv }) } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) return String(error.stderr)
  }
  return ''
}

test('lost successful requests remain fenced after current provenance changes model and then returns', () => {
  const relativePaths = ['src/modules/marketing/demo-scenarios.generated.ts', 'docs/demos/audio-provenance.json', 'public/demos/garage-revision.mp3', 'public/demos/controle-technique.mp3']
  const realBefore = relativePaths.map(path => readFileSync(path))
  const fixture = mkdtempSync(resolve('.output/demo-fence-'))
  try {
    for (const relative of [...relativePaths, 'docs/demos/scenarios.fr.json', 'scripts/generate-demo-audio.ps1']) {
      const target = resolve(fixture, relative)
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(relative, target)
    }
    const paths = relativePaths.map(path => resolve(fixture, path))
    const before = paths.map(path => readFileSync(path))
    const delivered = JSON.parse(before[1]!.toString('utf8'))
    const recordsDirectory = resolve(fixture, '.demo-audio-cache/known-successes')
    mkdirSync(recordsDirectory, { recursive: true })
    copyAvailableSuccessRecords(resolve('docs/demos/known-successes'), resolve(fixture, 'docs/demos/known-successes'))
    copyAvailableSuccessRecords('.demo-audio-cache/known-successes', recordsDirectory)
    const prior = readdirSync(recordsDirectory).map(name => [name, readFileSync(resolve(recordsDirectory, name))] as const)
    const script = resolve(fixture, 'scripts/generate-demo-audio.ps1')
    let seedOutput = ''
    try { seedOutput = execFileSync('pwsh', ['-NoProfile', '-File', script, '-RecordKnownSuccesses'], { encoding: 'utf8', stdio: 'pipe', env: offlineEnv }) } catch { /* Preserve the original failure witness for missing success seeding. */ }
    expect(seedOutput).toContain('"recordOnly": true')
    for (const segment of delivered.segments) {
      const record = JSON.parse(readFileSync(resolve(recordsDirectory, `${segment.requestSha256}.json`), 'utf8'))
      expect(record).toEqual({ state: 'recovery-required', model: delivered.model, requestSha256: segment.requestSha256 })
    }
    expect(paths.map(path => readFileSync(path))).toEqual(before)
    // This owned replacement describes no generation or success; no synthetic completed receipt is created.
    writeFileSync(paths[1]!, JSON.stringify({ model: 'offline-test/replacement', segments: [], fixture: 'No provider calls or audio generation' }))
    const archiveBefore = readdirSync(recordsDirectory).map(name => [name, readFileSync(resolve(recordsDirectory, name))])
    const preview = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', script, '-DryRun'], { encoding: 'utf8', env: offlineEnv }))
    expect(preview.recoveryRequired).toBe(10)
    expect(preview.uncachedCalls).toBe(0)
    expect(readdirSync(recordsDirectory).map(name => [name, readFileSync(resolve(recordsDirectory, name))])).toEqual(archiveBefore)
    const rejection = generatorRejection(script, [])
    expect(rejection).toMatch(/recover-only assessment required;\s*(?:\|\s*)?no request sent/)
    expect(rejection).not.toContain('process variable is required')
    expect(paths.filter(path => path !== paths[1]).map(path => readFileSync(path))).toEqual(before.filter((_, index) => index !== 1))
    for (const [name, content] of prior) expect(readFileSync(resolve(recordsDirectory, name))).toEqual(content)
    writeFileSync(paths[1]!, before[1]!)
    expect(paths.map(path => readFileSync(path))).toEqual(before)
    const returned = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', script, '-DryRun'], { encoding: 'utf8', env: offlineEnv }))
    expect(returned.recoveryRequired).toBe(10)
    expect(returned.uncachedCalls).toBe(0)
    // Current complete caches never participate in this intentionally cache-empty fixture.
    expect(relativePaths.map(path => readFileSync(path))).toEqual(realBefore)
    const conflictPath = resolve(fixture, 'docs/demos/known-successes', `${delivered.segments[0].requestSha256}.json`)
    const historicalRecord = readFileSync(conflictPath)
    const conflict = JSON.parse(historicalRecord.toString('utf8'))
    conflict.model = 'offline-test/conflicting-success'
    writeFileSync(conflictPath, JSON.stringify(conflict))
    const conflictRejection = generatorRejection(script, ['-DryRun'])
    expect(conflictRejection).toContain('Conflicting known-success records; recover-only assessment required')
    expect(paths.map(path => readFileSync(path))).toEqual(before)
    writeFileSync(conflictPath, historicalRecord)
    // Historical refusal fences also work in a fresh clone without ignored current records.
    for (const name of readdirSync(recordsDirectory)) rmSync(resolve(recordsDirectory, name))
    const fromHistory = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', script, '-DryRun'], { encoding: 'utf8', env: offlineEnv }))
    expect(fromHistory.recoveryRequired).toBe(10)
    expect(fromHistory.uncachedCalls).toBe(0)
  } finally {
    const cleanup = resolve(fixture)
    if (dirname(cleanup) !== resolve('.output') || !basename(cleanup).startsWith('demo-fence-')) throw new Error('Non-owned lost-cache fixture cleanup')
    rmSync(cleanup, { recursive: true })
  }
  expect(relativePaths.map(path => readFileSync(path))).toEqual(realBefore)
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
