#requires -Version 7
param([string]$SourcePath = 'docs/demos/scenarios.fr.json')
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = New-Object Text.UTF8Encoding($false)
function Assert-Contained([string]$Path, [string]$Directory) {
  $absolute = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
  if (-not $absolute.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output target escapes its owned directory' }
  $cursor = $absolute
  while ($cursor -and $cursor.Length -ge $repo.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a redirected filesystem target' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return $absolute
}
$sourceCandidate = if ([IO.Path]::IsPathRooted($SourcePath)) { $SourcePath } else { Join-Path $repo $SourcePath }
$source = Assert-Contained $sourceCandidate $repo
$scenarios = Get-Content -LiteralPath $source -Raw -Encoding UTF8 | ConvertFrom-Json
$destinations = @{ 'garage' = '/demos/garage-revision.mp3'; 'controle-technique' = '/demos/controle-technique.mp3' }
$ids = @{}
if ($scenarios.Count -ne 2) { throw 'Exactly two complete scenarios are required' }
foreach ($scenario in $scenarios) {
  if ($scenario.id -cnotin @('garage', 'controle-technique') -or $ids.ContainsKey($scenario.id)) { throw 'Unknown or duplicate scenario ID' }
  $ids[$scenario.id] = $true
  if ($scenario.audioSrc -cne $destinations[$scenario.id]) { throw 'Audio target must match the approved scenario destination' }
  if (-not $scenario.label -or $scenario.turns.Count -lt 2 -or $scenario.turns[0].text -notmatch 'agent IA') { throw 'Incomplete or undisclosed illustration' }
  foreach ($turn in $scenario.turns) {
    if ($turn.speaker -notin @('sparra', 'client') -or -not $turn.text) { throw 'Invalid dialogue turn' }
  }
  foreach ($field in @('status', 'contact', 'phone', 'summary', 'nextAction')) {
    if (-not $scenario.receipt.$field) { throw 'Incomplete illustrative receipt' }
  }
}
# All absolute destinations are checked before any write or owned-temp cleanup.
$temp = Assert-Contained (Join-Path $repo '.output/demo-generation') (Join-Path $repo '.output')
$module = Assert-Contained (Join-Path $repo 'src/modules/marketing/demo-scenarios.generated.ts') (Join-Path $repo 'src/modules/marketing')
$provenancePath = Assert-Contained (Join-Path $repo 'docs/demos/audio-provenance.json') (Join-Path $repo 'docs/demos')
$audioTargets = @{}
foreach ($scenario in $scenarios) { $audioTargets[$scenario.id] = Assert-Contained (Join-Path $repo ('public' + $scenario.audioSrc)) (Join-Path $repo 'public/demos') }
Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @{}
foreach ($name in @('Julie', 'Paul')) {
  $found = @($synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'fr-FR' -and $_.VoiceInfo.Name -eq "Microsoft $name" })
  if ($found.Count -ne 1) { throw "Installed French voice unavailable: $name" }
  $voices[$name] = $found[0].VoiceInfo.Name
}
$synthesizer.Dispose()
function Run-FFmpeg([string[]]$Arguments) {
  & ffmpeg -hide_banner -loglevel error @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Audio encoding failed' }
}
function Duration([string]$Path) {
  $value = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path
  if ($LASTEXITCODE -ne 0) { throw 'Audio duration probe failed' }
  return [double]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
}
if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
[IO.Directory]::CreateDirectory($temp) | Out-Null
foreach ($path in @($module, $provenancePath) + @($audioTargets.Values)) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null }
$generated = @(); $assets = @()
foreach ($scenario in $scenarios) {
  $cues = @(); $concat = @(); $offset = 0.0; $index = 0
  foreach ($turn in $scenario.turns) {
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $speaker.SelectVoice($voices[$(if ($turn.speaker -eq 'sparra') { 'Julie' } else { 'Paul' })])
      $speaker.Rate = 0
      $raw = Join-Path $temp "$($scenario.id)-$index-raw.wav"
      $speaker.SetOutputToWaveFile($raw)
      $speaker.Speak($turn.text)
      $speaker.SetOutputToNull()
    } finally { $speaker.Dispose() }
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
  generator = 'System.Speech.Synthesis.SpeechSynthesizer on PowerShell 7 (installed Windows voices); ffmpeg'
  voices = @{ sparra = 'Microsoft Julie (fr-FR)'; client = 'Microsoft Paul (fr-FR)' }
  rate = 0
  encoding = @{ codec = 'mp3'; channels = 1; sampleRate = 24000; bitrate = 64000; pauseSeconds = 0.35 }
  ffmpeg = $ffmpegVersion
  scenarioSource = 'docs/demos/scenarios.fr.json'
  scenarioSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  assets = $assets
}
[IO.File]::WriteAllText($provenancePath, ($proof | ConvertTo-Json -Depth 20) + "`n", $utf8)
$assets | ForEach-Object { Write-Output "$($_.id): $($_.durationSeconds)s, sha256 $($_.sha256)" }
