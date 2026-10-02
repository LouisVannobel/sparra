#requires -Version 7
param([string]$SourcePath = 'docs/demos/scenarios.fr.json', [switch]$DryRun, [switch]$RecordKnownSuccesses)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = New-Object Text.UTF8Encoding($false)
function Assert-Contained([string]$Path, [string]$Directory) {
  $absolute = [IO.Path]::GetFullPath($Path)
  $separator = [IO.Path]::DirectorySeparatorChar
  $parent = [IO.Path]::GetFullPath($Directory).TrimEnd($separator)
  $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  if ($absolute.TrimEnd($separator).Equals($parent, $comparison) -or -not $absolute.StartsWith($parent + $separator, $comparison)) { throw 'Output target escapes its owned directory' }
  $cursor = $absolute
  while ($cursor -and $cursor.Length -ge $repo.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a redirected filesystem target' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return $absolute
}
$sourceCandidate = if ([IO.Path]::IsPathRooted($SourcePath)) { $SourcePath } else { Join-Path $repo $SourcePath }
$source = Assert-Contained $sourceCandidate $repo
if ((Get-Item -LiteralPath $source).Length -gt 16384) { throw 'Scenario input exceeds 16 KiB' }
$scenarios = Get-Content -LiteralPath $source -Raw -Encoding UTF8 | ConvertFrom-Json
$destinations = @{ 'garage' = '/demos/garage-revision.mp3'; 'controle-technique' = '/demos/controle-technique.mp3' }
$ids = @{}
if ($scenarios.Count -ne 2) { throw 'Exactly two complete scenarios are required' }
foreach ($scenario in $scenarios) {
  if ($scenario.id -cnotin @('garage', 'controle-technique') -or $ids.ContainsKey($scenario.id)) { throw 'Unknown or duplicate scenario ID' }
  $ids[$scenario.id] = $true
  if ($scenario.audioSrc -cne $destinations[$scenario.id]) { throw 'Audio target must match the approved scenario destination' }
  if (-not $scenario.label -or $scenario.turns.Count -ne 5 -or $scenario.turns[0].text -notmatch 'agent IA') { throw 'Exactly five disclosed turns per illustration are required' }
  foreach ($turn in $scenario.turns) {
    if ($turn.speaker -notin @('sparra', 'client') -or -not $turn.text) { throw 'Invalid dialogue turn' }
    if ($turn.text -isnot [string] -or $turn.text.Length -gt 500) { throw 'Dialogue text exceeds the 500-character bound or is not text' }
  }
  foreach ($field in @('status', 'contact', 'phone', 'summary', 'nextAction')) {
    if (-not $scenario.receipt.$field) { throw 'Incomplete illustrative receipt' }
  }
}
# All absolute destinations are checked before any write or owned-temp cleanup.
$ownedRoot = Assert-Contained (Join-Path $repo '.output/demo-generation') (Join-Path $repo '.output')
$durableRoot = Assert-Contained (Join-Path $repo '.demo-audio-cache') $repo
$cache = Assert-Contained (Join-Path $durableRoot 'segments') $durableRoot
$successRoot = Assert-Contained (Join-Path $durableRoot 'known-successes') $durableRoot
$temp = Assert-Contained (Join-Path $ownedRoot ('work-' + [guid]::NewGuid().ToString('N'))) $ownedRoot
$lockPath = Assert-Contained (Join-Path $durableRoot 'generation.lock') $durableRoot
$module = Assert-Contained (Join-Path $repo 'src/modules/marketing/demo-scenarios.generated.ts') (Join-Path $repo 'src/modules/marketing')
$provenancePath = Assert-Contained (Join-Path $repo 'docs/demos/audio-provenance.json') (Join-Path $repo 'docs/demos')
$audioTargets = @{}
foreach ($scenario in $scenarios) { $audioTargets[$scenario.id] = Assert-Contained (Join-Path $repo ('public' + $scenario.audioSrc)) (Join-Path $repo 'public/demos') }
$model = 'x-ai/grok-voice-tts-1.0'
$endpoint = 'https://openrouter.ai/api/v1/audio/speech'
$voices = @{ sparra = 'ara'; client = 'sal' }
function Read-KnownSuccessRecords {
  if (-not (Test-Path -LiteralPath $successRoot)) { return }
  foreach ($file in Get-ChildItem -LiteralPath $successRoot -File -Filter '*.json') {
    $path = Assert-Contained $file.FullName $successRoot
    if ($file.Length -gt 1024) { throw 'Invalid known-success record; recover-only assessment required' }
    try { $record = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Invalid known-success record; recover-only assessment required' }
    if ($record.state -cne 'recovery-required' -or $record.requestSha256 -cnotmatch '\A[0-9a-f]{64}\z' -or $file.BaseName -cne $record.requestSha256 -or $record.model -isnot [string] -or $record.model.Length -lt 1 -or $record.model.Length -gt 128) { throw 'Invalid known-success record; recover-only assessment required' }
    $record
  }
}
function Save-KnownSuccess([string]$RequestHash, [string]$SuccessModel) {
  $path = Assert-Contained (Join-Path $successRoot "$RequestHash.json") $successRoot
  # An immutable fence is evidence of a past success, not a fabricated completed segment.
  if (Test-Path -LiteralPath $path) { return }
  [IO.Directory]::CreateDirectory($successRoot) | Out-Null
  $record = [ordered]@{ state = 'recovery-required'; model = $SuccessModel; requestSha256 = $RequestHash }
  $file = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = $utf8.GetBytes(($record | ConvertTo-Json -Compress) + "`n")
    $file.Write($bytes, 0, $bytes.Length); $file.Flush($true)
  } finally { $file.Dispose() }
}
# A delivered success remains billable history even if its raw cache was lost.
# Never silently synthesize that same request identity again.
$knownSuccesses = @{}
foreach ($record in Read-KnownSuccessRecords) { $knownSuccesses[$record.requestSha256] = $record.model }
$provenanceSuccesses = @{}
if (Test-Path -LiteralPath $provenancePath) {
  if ((Get-Item -LiteralPath $provenancePath).Length -gt 65536) { throw 'Previous provenance exceeds its bound; recover-only assessment required' }
  try { $previousProof = Get-Content -LiteralPath $provenancePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Cannot assess previous provenance; no request sent' }
  if ($previousProof.model -is [string] -and $previousProof.model.Length -ge 1 -and $previousProof.model.Length -le 128) {
    foreach ($segmentProof in $previousProof.segments) {
      if ($segmentProof.requestSha256 -cmatch '\A[0-9a-f]{64}\z' -and $segmentProof.sha256 -cmatch '\A[0-9a-f]{64}\z' -and $segmentProof.generatedUtc) {
        $provenanceSuccesses[$segmentProof.requestSha256] = $previousProof.model
        $knownSuccesses[$segmentProof.requestSha256] = $previousProof.model
      }
    }
  }
}
function Hash-Text([string]$Text) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Text))).ToLowerInvariant()
}
# The cache identity contains every transmitted field. Never delete or retry an uncertain attempt.
$requests = @()
foreach ($scenario in $scenarios) {
  for ($index = 0; $index -lt $scenario.turns.Count; $index++) {
    $turn = $scenario.turns[$index]
    $body = [ordered]@{ model = $model; input = $turn.text; voice = $voices[$turn.speaker]; response_format = 'mp3' } | ConvertTo-Json -Compress
    if ($utf8.GetByteCount($body) -gt 2048) { throw 'Speech request exceeds 2 KiB' }
    $identity = Hash-Text $body
    $stem = "$($scenario.id)-$index-$identity"
    $requests += [pscustomobject]@{
      scenario = $scenario.id; index = $index; voice = $voices[$turn.speaker]; input = $turn.text
      body = $body; requestSha256 = $identity; inputSha256 = (Hash-Text $turn.text)
      raw = (Assert-Contained (Join-Path $cache "$stem.mp3") $cache)
      manifest = (Assert-Contained (Join-Path $cache "$stem.json") $cache)
      partial = (Assert-Contained (Join-Path $cache "$stem.partial") $cache)
      completed = $null
      recoveryRequired = $false
    }
  }
}
function Read-CompletedCache($Request) {
  if (-not (Test-Path -LiteralPath $Request.manifest)) {
    if ((Test-Path -LiteralPath $Request.raw) -or (Test-Path -LiteralPath $Request.partial)) { throw 'Uncertain synthesis artifact: explicit recover-only assessment is required; no request sent' }
    return $null
  }
  if ((Get-Item -LiteralPath $Request.manifest).Length -gt 8192) { throw 'Invalid cache manifest; recover-only assessment required' }
  try { $entry = Get-Content -LiteralPath $Request.manifest -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Invalid cache manifest; recover-only assessment required' }
  if ($entry.state -cne 'completed') { throw 'Uncertain synthesis attempt: explicit recover-only assessment is required; no request sent' }
  if ($entry.requestSha256 -cne $Request.requestSha256 -or $entry.model -cne $model -or $entry.voice -cne $Request.voice -or $entry.input -cne $Request.input -or $entry.inputSha256 -cne $Request.inputSha256 -or $entry.responseFormat -cne 'mp3') { throw 'Cache identity mismatch; recover-only assessment required' }
  if (-not (Test-Path -LiteralPath $Request.raw)) { throw 'Completed cache audio missing; recover-only assessment required' }
  $length = (Get-Item -LiteralPath $Request.raw).Length
  if ($length -lt 256 -or $length -gt 4194304 -or $length -ne $entry.bytes -or (Get-FileHash -LiteralPath $Request.raw -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256 -or -not $entry.generatedUtc) { throw 'Completed cache hash/size/date mismatch; recover-only assessment required' }
  return $entry
}
# Preflight all ten cache entries before any billable request or write.
foreach ($request in $requests) {
  $request.completed = Read-CompletedCache $request
  $request.recoveryRequired = $null -eq $request.completed -and $knownSuccesses.ContainsKey($request.requestSha256)
}
$pending = @($requests | Where-Object { $null -eq $_.completed -and -not $_.recoveryRequired })
$recovery = @($requests | Where-Object { $_.recoveryRequired })
if ($DryRun) {
  [ordered]@{
    dryRun = $true; endpoint = $endpoint; model = $model; requestCount = $requests.Count
    uncachedCalls = $(if ($recovery.Count -gt 0) { 0 } else { $pending.Count })
    cachedTurns = @($requests | Where-Object { $null -ne $_.completed }).Count
    recoveryRequired = $recovery.Count
    requests = @($requests | ForEach-Object { [ordered]@{ scenario = $_.scenario; index = $_.index; voice = $_.voice; characters = $_.input.Length; requestBytes = $utf8.GetByteCount($_.body); inputSha256 = $_.inputSha256; requestSha256 = $_.requestSha256 } })
  } | ConvertTo-Json -Depth 10
  exit 0
}
function Run-FFmpeg([string[]]$Arguments) {
  & ffmpeg -hide_banner -loglevel error @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Audio encoding failed' }
}
function Duration([string]$Path) {
  $value = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path
  if ($LASTEXITCODE -ne 0) { throw 'Audio duration probe failed' }
  $seconds = [double]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
  if (-not [double]::IsFinite($seconds) -or $seconds -lt 0.1 -or $seconds -gt 120) { throw 'Audio duration outside the finite 0.1–120 second bound' }
  return $seconds
}
function Write-Manifest($Request, $Entry) {
  $staging = Assert-Contained ($Request.manifest + '.new') $cache
  [IO.File]::WriteAllText($staging, ($Entry | ConvertTo-Json -Depth 10) + "`n", $utf8)
  [IO.File]::Move($staging, $Request.manifest, $true)
}
function Synthesize($Request, [Net.Http.HttpClient]$Client) {
  $entry = [ordered]@{ state = 'attempted'; model = $model; voice = $Request.voice; input = $Request.input; inputSha256 = $Request.inputSha256; requestSha256 = $Request.requestSha256; responseFormat = 'mp3'; attemptedUtc = [DateTime]::UtcNow.ToString('o') }
  Write-Manifest $Request $entry
  $message = $null; $response = $null; $stream = $null; $file = $null
  $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(90))
  try {
    $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $endpoint)
    $message.Content = [Net.Http.StringContent]::new($Request.body, $utf8, 'application/json')
    $response = $Client.SendAsync($message, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
    if ([int]$response.StatusCode -ne 200) { throw 'Speech response was not HTTP 200' }
    if ($response.Headers.Contains('X-Generation-Id')) {
      $generationIds = @($response.Headers.GetValues('X-Generation-Id'))
      if ($generationIds.Count -eq 1 -and $generationIds[0] -cmatch '\A[A-Za-z0-9._:-]{1,160}\z') { $entry.generationId = $generationIds[0] }
    }
    if ($response.Content.Headers.ContentType.MediaType -cne 'audio/mpeg') { throw 'Speech response was not audio/mpeg' }
    if ($null -ne $response.Content.Headers.ContentLength -and ($response.Content.Headers.ContentLength -lt 256 -or $response.Content.Headers.ContentLength -gt 4194304)) { throw 'Speech response size outside its bound' }
    $stream = $response.Content.ReadAsStreamAsync($deadline.Token).GetAwaiter().GetResult()
    $file = [IO.File]::Open($Request.partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = [byte[]]::new(8192); $count = 0
    while (($read = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
      $count += $read
      if ($count -gt 4194304) { throw 'Speech response exceeded 4 MiB' }
      $file.Write($buffer, 0, $read)
    }
    $file.Dispose(); $file = $null
    if ($count -lt 256 -or ($null -ne $response.Content.Headers.ContentLength -and $count -ne $response.Content.Headers.ContentLength)) { throw 'Speech response was truncated or empty' }
    $codec = & ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 $Request.partial 2>$null
    if ($LASTEXITCODE -ne 0 -or $codec -cne 'mp3') { throw 'Speech response did not decode as MP3' }
    $duration = Duration $Request.partial
    Run-FFmpeg @('-i', $Request.partial, '-f', 'null', '-')
    [IO.File]::Move($Request.partial, $Request.raw)
    $entry.state = 'completed'; $entry.generatedUtc = [DateTime]::UtcNow.ToString('o')
    $entry.bytes = $count; $entry.durationSeconds = $duration
    $entry.sha256 = (Get-FileHash -LiteralPath $Request.raw -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Manifest $Request $entry
    Save-KnownSuccess $Request.requestSha256 $model
    return [pscustomobject]$entry
  } catch {
    # Do not expose exceptions, response bodies, headers or credential-bearing request objects.
    throw "Synthesis did not complete for $($Request.scenario) turn $($Request.index). No automatic retry; explicit recover-only assessment of the attempted cache entry is required."
  } finally {
    if ($file) { $file.Dispose() }; if ($stream) { $stream.Dispose() }
    if ($response) { $response.Dispose() }; if ($message) { $message.Dispose() }; $deadline.Dispose()
  }
}
Get-Command ffmpeg, ffprobe -ErrorAction Stop | Out-Null
$client = $null; $handler = $null; $generationLock = $null
try {
  [IO.Directory]::CreateDirectory($durableRoot) | Out-Null
  try { $generationLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { throw 'Another audio generation owns the lock; no request sent' }
  # Archive actual known successes before another billable request or provenance replacement.
  foreach ($record in Read-KnownSuccessRecords) { $knownSuccesses[$record.requestSha256] = $record.model }
  foreach ($identity in $provenanceSuccesses.Keys) { Save-KnownSuccess $identity $provenanceSuccesses[$identity] }
  # Recheck after locking; another producer may have completed a turn during preview.
  foreach ($request in $requests) {
    $request.completed = Read-CompletedCache $request
    if ($null -ne $request.completed) {
      Save-KnownSuccess $request.requestSha256 $model
      $knownSuccesses[$request.requestSha256] = $model
    }
    $request.recoveryRequired = $null -eq $request.completed -and $knownSuccesses.ContainsKey($request.requestSha256)
  }
  if ($RecordKnownSuccesses) {
    [ordered]@{ recordOnly = $true; knownSuccesses = @($knownSuccesses.Keys).Count; networkCalls = 0 } | ConvertTo-Json
    exit 0
  }
  if (@($requests | Where-Object { $_.recoveryRequired }).Count -gt 0) { throw 'Completed raw segment cache missing for a known successful request. Explicit recover-only assessment required; no request sent' }
  $pending = @($requests | Where-Object { $null -eq $_.completed })
  if ($pending.Count -gt 0) {
    $key = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'Process')
    if ([string]::IsNullOrWhiteSpace($key)) { throw 'OPENROUTER_API_KEY process variable is required for uncached turns' }
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    try { $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $key) } catch { throw 'Invalid process credential format' } finally { $key = $null }
    $client.DefaultRequestHeaders.Accept.ParseAdd('audio/mpeg')
  }
  [IO.Directory]::CreateDirectory($cache) | Out-Null
  [IO.Directory]::CreateDirectory($ownedRoot) | Out-Null
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  foreach ($request in $requests) {
    if ($null -eq $request.completed) { $request.completed = Synthesize $request $client }
  }
foreach ($path in @($module, $provenancePath) + @($audioTargets.Values)) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null }
$generated = @(); $assets = @()
foreach ($scenario in $scenarios) {
  $cues = @(); $concat = @(); $offset = 0.0; $index = 0
  foreach ($turn in $scenario.turns) {
    $request = @($requests | Where-Object { $_.scenario -ceq $scenario.id -and $_.index -eq $index })[0]
    $raw = $request.raw
    $segment = Join-Path $temp "$($scenario.id)-$index.wav"
    Run-FFmpeg @('-y', '-i', $raw, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', $segment)
    $length = Duration $segment
    $cues += [ordered]@{ speaker = $turn.speaker; text = $turn.text; startSeconds = [Math]::Round($offset, 6); endSeconds = [Math]::Round($offset + $length, 6) }
    $concat += "file '$([IO.Path]::GetFileName($segment))'"; $offset += $length
    if ($index -lt $scenario.turns.Count - 1) {
      $silence = Join-Path $temp "$($scenario.id)-$index-silence.wav"
      Run-FFmpeg @('-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.35', '-c:a', 'pcm_s16le', $silence)
      $concat += "file '$([IO.Path]::GetFileName($silence))'"; $offset += (Duration $silence)
    }
    $index++
  }
  $list = Join-Path $temp "$($scenario.id)-concat.txt"
  [IO.File]::WriteAllLines($list, $concat, $utf8)
  $target = $audioTargets[$scenario.id]
  Run-FFmpeg @('-y', '-f', 'concat', '-safe', '1', '-i', $list, '-ac', '1', '-ar', '24000', '-b:a', '64k', '-map_metadata', '-1', $target)
  $duration = Duration $target
  $generated += [ordered]@{ id = $scenario.id; label = $scenario.label; audioSrc = $scenario.audioSrc; durationSeconds = $duration; cues = $cues; receipt = $scenario.receipt }
  $assets += [ordered]@{ id = $scenario.id; audioSrc = $scenario.audioSrc; durationSeconds = $duration; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$types = @'
// Generated by scripts/generate-demo-audio.ps1. Edit docs/demos/scenarios.fr.json.
export type DemoSectorId = 'garage' | 'controle-technique'
export interface DemoScenario {
  id: DemoSectorId
  label: string
  audioSrc: string
  durationSeconds: number
  cues: { speaker: 'sparra' | 'client'; text: string; startSeconds: number; endSeconds: number }[]
  receipt: { status: string; contact: string; phone: string; summary: string; nextAction: string }
}
export const demoScenarios: DemoScenario[] =
'@
[IO.File]::WriteAllText($module, $types + ($generated | ConvertTo-Json -Depth 20) + "`n", $utf8)
$ffmpegVersion = (& ffmpeg -version | Select-Object -First 1) -replace ' Copyright.*$', ''
$proof = [ordered]@{
  purpose = 'Local preview illustrations of fictional scenarios. Not qualified runtime calls.'
  publication = 'Pending applicable voice rights review or replacement with qualified runtime captures.'
  subjectiveListening = 'NOT VERIFIED: full human listening is required before qualification.'
  generator = 'Offline PowerShell 7 HttpClient producer; OpenRouter speech endpoint; ffmpeg'
  provider = 'OpenRouter / xAI'
  model = $model
  endpoint = $endpoint
  generatedUtc = [DateTime]::UtcNow.ToString('o')
  voices = $voices
  speed = 'Provider default (1.0); no time stretching or speed transform applied'
  externalProcessing = 'The ten verbatim fictional French turns were sent to OpenRouter/xAI for MP3 synthesis. ffmpeg decodes and normalizes sample format to mono 24 kHz PCM, inserts measured 0.35-second silence, then encodes mono 24 kHz MP3 at 64 kbps and removes metadata.'
  telephoneQualification = 'NOT VERIFIED: no real phone call, PCMU 8 kHz, latency, interruption or provider-policy qualification.'
  encoding = @{ codec = 'mp3'; channels = 1; sampleRate = 24000; bitrate = 64000; pauseSeconds = 0.35 }
  ffmpeg = $ffmpegVersion
  scenarioSource = 'docs/demos/scenarios.fr.json'
  scenarioSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  segments = @($requests | ForEach-Object { [ordered]@{ scenario = $_.scenario; index = $_.index; voice = $_.voice; inputSha256 = $_.inputSha256; requestSha256 = $_.requestSha256; sha256 = $_.completed.sha256; bytes = $_.completed.bytes; durationSeconds = $_.completed.durationSeconds; generatedUtc = $_.completed.generatedUtc } })
  assets = $assets
}
[IO.File]::WriteAllText($provenancePath, ($proof | ConvertTo-Json -Depth 20) + "`n", $utf8)
$assets | ForEach-Object { Write-Output "$($_.id): $($_.durationSeconds)s, sha256 $($_.sha256)" }
} finally {
  if ($client) { $client.Dispose() }; if ($handler) { $handler.Dispose() }
  if (Test-Path -LiteralPath $temp) {
    $checkedTemp = Assert-Contained $temp $ownedRoot
    Remove-Item -LiteralPath $checkedTemp -Recurse -Force
  }
  if ($generationLock) { $generationLock.Dispose() }
}
