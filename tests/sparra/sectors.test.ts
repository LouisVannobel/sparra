import { expect, test } from 'vitest'
import { sectorIds, getSectorPreset } from '../../src/modules/sparra/sectors'

test('sector catalogue offers the two published trades in both locales', () => {
  expect(sectorIds).toEqual(['garage','controle-technique'])
  expect(new Set(sectorIds).size).toBe(2)
  expect(getSectorPreset('garage','fr').label).toBe('Garage')
  expect(getSectorPreset('controle-technique','en').label).toBe('Vehicle inspection')
  expect(getSectorPreset('controle-technique','fr').label).toBe('Contrôle technique')
  expect(getSectorPreset('garage','en').label).toBe('Garage')
})
test('presets supply only questions to complete, never fabricated business facts', () => {
  for(const locale of ['fr','en'] as const)for(const sector of sectorIds){
    const preset=getSectorPreset(sector,locale)
    expect(preset.faqQuestions.length).toBeGreaterThan(0)
    expect(preset.intakeQuestions.length).toBeGreaterThan(0)
    for(const question of [...preset.faqQuestions,...preset.intakeQuestions]){
      expect(question.endsWith('?')).toBe(true)
      expect(question).not.toMatch(/[€$£]|\d|certifi(?:é|ed)|guaranteed|garanti/i)
    }
  }
  expect(getSectorPreset('controle-technique','fr').intakeQuestions).toContain('Quel type de véhicule est concerné ?')
  expect(getSectorPreset('controle-technique','en').intakeQuestions).toContain('What type of vehicle is concerned?')
})
