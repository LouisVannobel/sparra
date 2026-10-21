import { expect, test } from 'vitest'
import { sectorIds, getSectorPreset } from '../../src/modules/sparra/sectors'

test('sector catalogue offers three unique supported trades in both locales', () => {
  expect(sectorIds).toEqual(['garage','controle-technique','diagnostic-immobilier'])
  expect(new Set(sectorIds).size).toBe(3)
  expect(getSectorPreset('garage','fr').label).toBe('Garage')
  expect(getSectorPreset('controle-technique','en').label).toBe('Vehicle inspection')
  expect(getSectorPreset('diagnostic-immobilier','fr').label).toBe('Diagnostic immobilier')
  expect(getSectorPreset('diagnostic-immobilier','en').label).toBe('Property diagnostics')
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
  expect(getSectorPreset('diagnostic-immobilier','fr').intakeQuestions).toContain('Quel type de bien est concerné ?')
  expect(getSectorPreset('diagnostic-immobilier','en').intakeQuestions).toContain('What type of property is concerned?')
})
