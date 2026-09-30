import { expect, test } from 'vitest'
import { validateMagicRequestForm } from '../../src/modules/auth/auth.functions'

test('actual magic RPC validator emits only a constant response for malformed or excess input', async () => {
  for (const input of [{ email: { private: 'owned-sensitive-marker' }, locale: 'en' },
    { email: 'owned@example.test', locale: 'en', token: 'owned-sensitive-marker' }]) {
    let caught: unknown
    try { validateMagicRequestForm(input) } catch (error) { caught = error }
    expect(caught instanceof Response).toBe(true)
    if (!(caught instanceof Response)) throw new Error('Expected sanitized validator response')
    expect(caught.status).toBe(400)
    expect(await caught.text() === 'Authentication rejected').toBe(true)
  }
  const valid = validateMagicRequestForm({ email: 'owned@example.test', locale: 'en' })
  expect(valid.email === 'owned@example.test' && valid.locale === 'en' && Object.keys(valid).length === 2).toBe(true)
})
