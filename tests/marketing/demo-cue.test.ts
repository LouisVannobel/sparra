import { expect, test } from 'vitest'
import { currentCueIndex } from '../../src/modules/marketing/demo-cue'
import type { DemoScenario } from '../../src/modules/marketing/demo-scenarios.generated'

const scenario: DemoScenario = {
  id: 'garage', label: 'Garage', audioSrc: '/demos/garage-revision.mp3', durationSeconds: 5,
  cues: [{ speaker: 'sparra', text: 'Bonjour', startSeconds: 0, endSeconds: 2 },
    { speaker: 'client', text: 'Bonjour', startSeconds: 2.35, endSeconds: 4 }],
  receipt: { status: '', contact: '', phone: '', summary: '', nextAction: '' },
}

test.each([
  [0, 0], [1.999, 0], [2, null], [2.349, null], [2.35, 1], [3.999, 1],
  [4, null], [5, null], [-1, null], [NaN, null], [Infinity, null], [-Infinity, null],
])('cue at %s seconds is %s (exclusive end and real silence)', (seconds, expected) => {
  expect(currentCueIndex(scenario, seconds)).toBe(expected)
})
