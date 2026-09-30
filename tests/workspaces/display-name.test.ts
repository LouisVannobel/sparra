import { expect, test } from 'vitest'
import { parseDisplayName } from '../../src/modules/workspaces/personal.server'

test.each(['', '   ', 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a'.repeat(81), '😀'.repeat(41), null, 42])('refuses invalid display name %#', input => {
  expect(() => parseDisplayName(input)).toThrow('Invalid display name')
})
test.each([['  Mon espace  ', 'Mon espace'], ['😀'.repeat(40), '😀'.repeat(40)], ['<script>alert(1)</script>', '<script>alert(1)</script>']])('normalizes bounded plain text %#', (input, expected) => {
  expect(parseDisplayName(input)).toBe(expected)
})
