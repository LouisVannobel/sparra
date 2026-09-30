import { expect, test } from 'vitest'
import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk/util/errors/idempotency-collision-error.js'
import { admitAuthMail, relayAuthMailOnce } from '../../src/modules/auth/mail-relay.server'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
test.each(['', 'invalid', '00000000-0000-0000-0000-000000000000'])('invalid native collision ID %s maps admission_unknown without readmission', async existing => {
  let calls = 0
  const task = { async runNoWait() { calls++; throw new IdempotencyCollisionError(existing) } }
  expect(await admitAuthMail(task, id)).toEqual({ state: 'admission_unknown', runId: null }); expect(calls).toBe(1)
})
test('valid native collision and fresh run preserve the actual run UUID', async () => {
  expect(await admitAuthMail({ async runNoWait() { throw new IdempotencyCollisionError(id) } }, id)).toEqual({ state: 'admitted', runId: id })
  expect(await admitAuthMail({ async runNoWait() { return { async getWorkflowRunId() { return id } } } }, id)).toEqual({ state: 'admitted', runId: id })
})
test('relay passes only committed outbox identity and finalizes unknown once without emitting errors', async () => {
  let calls = 0, finalized: unknown
  const store = { async claimAdmission() { return { outboxId: id, fence: 7 } }, async finalizeAdmission(...args: unknown[]) { finalized = args; return true } }
  const state = await relayAuthMailOnce(store, { async runNoWait(input) { expect(input).toEqual({ outboxId: id }); calls++; throw new Error('sensitive SDK cause') } }, new AbortController().signal)
  expect(state).toBe('admission_unknown'); expect(finalized).toEqual([id,7,null]); expect(calls).toBe(1)
})
