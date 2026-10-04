import { expect, test } from 'vitest'
import type { ListRequestsPage } from '../../src/modules/sparra/sparra.functions'
import { mergeInboxPage } from '../../src/ui/sparra/inbox-panel'

type RequestRow = ListRequestsPage['requests'][number]

const oldFirst: RequestRow = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null,
  status: 'pending', configurationRevision: null, treatedAt: null, resultAvailability: 'unavailable',
  resultQuality: null, category: null, summary: null, contact: null, nextAction: null,
}
const oldSecond: RequestRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:03:00.000Z',
  status: 'closed', configurationRevision: 7, treatedAt: null, resultAvailability: 'available',
  resultQuality: 'partial', category: 'callback', summary: 'Call back after inspection',
  contact: { name: 'Camille', callback_e164: '+33123456789', preference: 'Afternoon', callback_source: 'caller', callback_confirmed: false },
  nextAction: 'Confirm the callback request',
}
const nextFirst: RequestRow = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', admittedAt: '2026-10-02T10:00:00.000Z', endedAt: null,
  status: 'closing', configurationRevision: 8, treatedAt: null, resultAvailability: 'available',
  resultQuality: 'complete', category: 'information', summary: 'Ask about opening hours',
  contact: { name: null, callback_e164: null, preference: null, callback_source: 'missing', callback_confirmed: false },
  nextAction: null,
}
const nextSecond: RequestRow = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: null,
  status: 'pending', configurationRevision: 7, treatedAt: '2026-10-01T11:00:00.000Z', resultAvailability: 'unavailable',
  resultQuality: null, category: null, summary: null, contact: null, nextAction: null,
}
const changedOldFirst: RequestRow = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', admittedAt: '2026-10-03T10:00:00.000Z', endedAt: '2026-10-03T10:01:00.000Z',
  status: 'closed', configurationRevision: 9, treatedAt: '2026-10-03T11:00:00.000Z', resultAvailability: 'available',
  resultQuality: 'complete', category: 'declared_urgent', summary: 'Updated overlap from the next page',
  contact: { name: null, callback_e164: '+33234567890', preference: null, callback_source: 'provider', callback_confirmed: false },
  nextAction: 'Review the declared urgency',
}

test('inbox pagination preserves old rows first and next-page order even with equal or newer timestamps', () => {
  const current: ListRequestsPage = { requests: [oldFirst, oldSecond], nextCursor: { admittedAt: oldSecond.admittedAt, id: oldSecond.id } }
  const next: ListRequestsPage = { requests: [nextFirst, nextSecond], nextCursor: { admittedAt: '2026-09-30T10:00:00.000Z', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }

  expect(mergeInboxPage(current, next)).toEqual({
    requests: [oldFirst, oldSecond, nextFirst, nextSecond],
    nextCursor: { admittedAt: '2026-09-30T10:00:00.000Z', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
  })
})

test('inbox pagination retains the old DTO when the next page overlaps by ID', () => {
  const current: ListRequestsPage = { requests: [oldFirst, oldSecond], nextCursor: { admittedAt: oldSecond.admittedAt, id: oldSecond.id } }
  const next: ListRequestsPage = { requests: [nextFirst, changedOldFirst, oldSecond, nextSecond], nextCursor: null }

  expect(mergeInboxPage(current, next)).toEqual({ requests: [oldFirst, oldSecond, nextFirst, nextSecond], nextCursor: null })
})

test('inbox pagination keeps duplicate rows already present in the old page', () => {
  const current: ListRequestsPage = { requests: [oldFirst, oldSecond, oldFirst], nextCursor: null }
  const next: ListRequestsPage = { requests: [changedOldFirst, nextSecond], nextCursor: null }

  expect(mergeInboxPage(current, next)).toEqual({ requests: [oldFirst, oldSecond, oldFirst, nextSecond], nextCursor: null })
})

test('inbox pagination keeps duplicate new IDs when those IDs are absent from the old page', () => {
  const current: ListRequestsPage = { requests: [oldSecond], nextCursor: null }
  const next: ListRequestsPage = { requests: [nextFirst, nextSecond, nextFirst], nextCursor: null }

  expect(mergeInboxPage(current, next)).toEqual({ requests: [oldSecond, nextFirst, nextSecond, nextFirst], nextCursor: null })
})

test('inbox pagination passes through the next cursor when an empty next page arrives', () => {
  const current: ListRequestsPage = { requests: [oldFirst, oldSecond], nextCursor: { admittedAt: oldSecond.admittedAt, id: oldSecond.id } }
  const next: ListRequestsPage = { requests: [], nextCursor: { admittedAt: '2026-09-29T10:00:00.000Z', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }
  const merged = mergeInboxPage(current, next)

  expect(merged).toEqual({ requests: [oldFirst, oldSecond], nextCursor: { admittedAt: '2026-09-29T10:00:00.000Z', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } })
  expect(merged.nextCursor).toBe(next.nextCursor)
})

test('inbox pagination accepts all next rows when the old page is empty', () => {
  const current: ListRequestsPage = { requests: [], nextCursor: null }
  const next: ListRequestsPage = { requests: [nextSecond, nextFirst, nextSecond], nextCursor: null }

  expect(mergeInboxPage(current, next)).toEqual({ requests: [nextSecond, nextFirst, nextSecond], nextCursor: null })
})

test('inbox pagination closes the cursor when both pages are empty', () => {
  const current: ListRequestsPage = { requests: [], nextCursor: { admittedAt: oldFirst.admittedAt, id: oldFirst.id } }
  const next: ListRequestsPage = { requests: [], nextCursor: null }

  expect(mergeInboxPage(current, next)).toEqual({ requests: [], nextCursor: null })
})

test('inbox pagination creates a merged page without mutating either input page or DTO', () => {
  const current: ListRequestsPage = { requests: [oldFirst, oldSecond], nextCursor: { admittedAt: oldSecond.admittedAt, id: oldSecond.id } }
  const next: ListRequestsPage = { requests: [changedOldFirst, nextFirst], nextCursor: null }
  for (const page of [current, next]) {
    for (const row of page.requests) { Object.freeze(row.contact); Object.freeze(row) }
    Object.freeze(page.requests); Object.freeze(page.nextCursor); Object.freeze(page)
  }
  const merged = mergeInboxPage(current, next)

  expect(merged).toEqual({ requests: [oldFirst, oldSecond, nextFirst], nextCursor: null })
  expect(current).toEqual({ requests: [oldFirst, oldSecond], nextCursor: { admittedAt: '2026-10-01T10:00:00.000Z', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })
  expect(next).toEqual({ requests: [changedOldFirst, nextFirst], nextCursor: null })
  expect(merged).not.toBe(current)
  expect(merged).not.toBe(next)
  expect(merged.requests).not.toBe(current.requests)
  expect(merged.requests).not.toBe(next.requests)
})
