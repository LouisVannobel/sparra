import { expect, test } from 'vitest'
import { normalizeAuthEmail } from '../../src/modules/auth/auth-email-normalization.server'
import { normalizeAuthEmail as existingConsumer } from '../../src/modules/auth/auth-email-store.server'

// Break caught: migration and native User writes stop sharing the established
// trim/lowercase/mailbox grammar, including ECMAScript whitespace semantics.
test.each([
  ['  Alice@Example.TEST\t', 'alice@example.test'],
  ['\uFEFFAlice@Example.TEST\u00a0', 'alice@example.test'],
  ['a+tag@sub.example.test', 'a+tag@sub.example.test'],
  ['İ@EXAMPLE.TEST', 'i\u0307@example.test'],
])('canonical mailbox normalization retains existing semantics (%#)', (input, expected) => {
  expect(normalizeAuthEmail(input)).toBe(expected)
  expect(existingConsumer(input)).toBe(expected)
})
test.each(['', 'a@b', 'a b@example.test', 'a@@example.test', null, 'a'.repeat(250) + '@x.test'])('invalid mailbox fails with safe unchanged semantics (%#)', input => {
  expect(() => normalizeAuthEmail(input)).toThrow('Auth email request rejected')
  expect(() => existingConsumer(input)).toThrow('Auth email request rejected')
})
