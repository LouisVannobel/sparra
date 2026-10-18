import { expect, test } from 'vitest'
import { decodeMailCleanupDiagnostic } from '../helpers/mail-cleanup-diagnostic'

const allowedCodes = Object.freeze(['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING', 'UNKNOWN'])

test('cleanup IPC decoder retains fulfilled and rejected receipts without private payload fields', () => {
  expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup', outcome: 'FULFILLED', codes: [],
    details: 'private-cleanup-sentinel', error: { secret: 'private-cleanup-sentinel' } }, allowedCodes))
    .toEqual({ outcome: 'FULFILLED', codes: [] })
  expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup', outcome: 'REJECTED',
    codes: ['STREAM_STATUS_MISSING', 'SDK_CLEANUP_FAILED'], details: 'private-cleanup-sentinel' }, allowedCodes))
    .toEqual({ outcome: 'REJECTED', codes: ['STREAM_STATUS_MISSING', 'SDK_CLEANUP_FAILED'] })
})

test('cleanup IPC decoder preserves duplicate codes and their order at the admitted length bound', () => {
  expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup', outcome: 'REJECTED',
    codes: ['STREAM_STATUS_MISSING', 'SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING'] }, allowedCodes))
    .toEqual({ outcome: 'REJECTED', codes: ['STREAM_STATUS_MISSING', 'SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING'] })
  expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup', outcome: 'REJECTED',
    codes: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'] }, allowedCodes)).toBeNull()
})

test('cleanup IPC decoder owns the admitted code array without mutating its inputs', () => {
  const codes = ['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING']
  const message = { type: 'fixture-mail-cleanup', outcome: 'REJECTED', codes,
    private: 'private-cleanup-sentinel' }
  const diagnostic = decodeMailCleanupDiagnostic(message, allowedCodes)
  expect(diagnostic).toEqual({ outcome: 'REJECTED', codes: ['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING'] })
  expect(message).toEqual({ type: 'fixture-mail-cleanup', outcome: 'REJECTED',
    codes: ['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING'], private: 'private-cleanup-sentinel' })
  codes[0] = 'UNKNOWN'
  expect(diagnostic).toEqual({ outcome: 'REJECTED', codes: ['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING'] })
  expect(allowedCodes).toEqual(['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING', 'UNKNOWN'])
})

test('cleanup IPC decoder rejects malformed receipt envelopes', () => {
  const malformed: unknown[] = [
    undefined, null, false, 0, '', 'fixture-mail-cleanup', () => undefined, [], {},
    { outcome: 'FULFILLED', codes: [] },
    { type: 'other-fixture-event', outcome: 'FULFILLED', codes: [] },
    { type: 'fixture-mail-cleanup', codes: [] },
    { type: 'fixture-mail-cleanup', outcome: 'fulfilled', codes: [] },
    { type: 'fixture-mail-cleanup', outcome: null, codes: [] },
    { type: 'fixture-mail-cleanup', outcome: 'FULFILLED' },
    { type: 'fixture-mail-cleanup', outcome: 'FULFILLED', codes: null },
    { type: 'fixture-mail-cleanup', outcome: 'FULFILLED', codes: 'UNKNOWN' },
    { type: 'fixture-mail-cleanup', outcome: 'FULFILLED', codes: { 0: 'UNKNOWN', length: 1 } },
  ]
  for (const message of malformed) expect(decodeMailCleanupDiagnostic(message, allowedCodes)).toBeNull()
})

test('cleanup IPC decoder rejects a whole receipt if any bounded code is unrecognized or not a string', () => {
  const malformed: unknown[] = [
    [0], [null], [{}], ['private-code-sentinel'], ['SDK_CLEANUP_FAILED', 'private-code-sentinel'],
    ['private-code-sentinel', 'SDK_CLEANUP_FAILED'], new Array(1),
  ]
  for (const codes of malformed) expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup',
    outcome: 'REJECTED', codes }, allowedCodes)).toBeNull()
})

test('cleanup IPC decoder does not correlate outcome with presence of admitted codes', () => {
  expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup', outcome: 'REJECTED', codes: [] }, allowedCodes))
    .toEqual({ outcome: 'REJECTED', codes: [] })
  expect(decodeMailCleanupDiagnostic({ type: 'fixture-mail-cleanup', outcome: 'FULFILLED', codes: ['UNKNOWN'] }, allowedCodes))
    .toEqual({ outcome: 'FULFILLED', codes: ['UNKNOWN'] })
})
