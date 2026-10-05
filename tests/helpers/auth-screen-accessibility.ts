import AxeBuilder from '@axe-core/playwright'
import type { Page } from 'playwright'
import { expect } from 'vitest'

export async function assertAuthScreenAccessibility(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
}
