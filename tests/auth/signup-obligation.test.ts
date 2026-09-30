import { expect, test } from 'vitest'
import { currentSignupEmailPolicy, withRequiredSignupEmail } from '../../src/modules/auth/signup-obligation.server'

test('selected signup rejects missing or invalid policy before its operation runs', async () => {
  let called = false
  for (const policy of [undefined, {}, { purpose: 'welcome', locale: 'fr' }]) {
    await expect(withRequiredSignupEmail(policy, async () => { called = true })).rejects.toThrow('Signup email policy rejected')
  }
  expect(called).toBe(false)
  expect(currentSignupEmailPolicy()).toBeUndefined()
})

test('concurrent policies remain request-local, immutable and leave no authority outside operation', async () => {
  const policy = { purpose: 'magic-link', locale: 'fr' }
  const result = await Promise.all(['fr', 'en'].map(locale => withRequiredSignupEmail({ ...policy, locale }, async () => {
    await Promise.resolve()
    expect(Object.isFrozen(currentSignupEmailPolicy())).toBe(true)
    return currentSignupEmailPolicy()?.locale
  })))
  expect(result).toEqual(['fr', 'en'])
  expect(currentSignupEmailPolicy()).toBeUndefined()
})

test.each(['fulfilled', 'rejected'])('required policy is revoked in delayed descendants after the operation %s', async outcome => {
  let release = () => {}
  const barrier = new Promise<void>(resolve => { release = resolve })
  let descendant: Promise<unknown> = Promise.resolve()
  const operation = withRequiredSignupEmail({ purpose: 'magic-link', locale: 'fr' }, async () => {
    descendant = barrier.then(() => currentSignupEmailPolicy())
    if (outcome === 'rejected') throw new Error('fixture operation rejected')
  })
  if (outcome === 'rejected') await expect(operation).rejects.toThrow('fixture operation rejected')
  else await operation
  expect(currentSignupEmailPolicy()).toBeUndefined()
  release()
  await expect(descendant).rejects.toThrow('Signup email policy rejected')
})
