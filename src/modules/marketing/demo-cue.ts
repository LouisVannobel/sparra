import type { DemoScenario } from './demo-scenarios.generated'

export function currentCueIndex(scenario: DemoScenario, seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= scenario.durationSeconds) return null
  const index = scenario.cues.findIndex(cue => seconds >= cue.startSeconds && seconds < cue.endSeconds)
  return index < 0 ? null : index
}
