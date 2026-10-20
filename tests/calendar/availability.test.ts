import { expect, test } from 'vitest'
import { findCalendarSlots } from '../../src/modules/calendar/availability.server'
import type { CalendarPolicy } from '../../src/modules/calendar/policy'
const policy: CalendarPolicy = {
  version: 1,
  timeZone: 'Europe/Paris',
  services: [{ id: 'visit', name: 'Visite', durationMinutes: 30 }],
  weeklyHours: [{ day: 1, ranges: [{ start: '09:00', end: '12:00' }] }],
  bufferMinutes: 15,
  noticeMinutes: 60,
}
const input = {
  serviceId: 'visit',
  windowStart: '2026-10-26T00:00:00Z',
  windowEnd: '2026-10-27T00:00:00Z',
  now: Date.parse('2026-10-26T07:00:00Z'),
  busy: [],
}
test('real policy duration, notice, margin and three fixed UTC offers', () => {
  expect(findCalendarSlots(policy, input)).toEqual([
    { start: '2026-10-26T08:00:00.000Z', end: '2026-10-26T08:30:00.000Z' },
    { start: '2026-10-26T08:15:00.000Z', end: '2026-10-26T08:45:00.000Z' },
    { start: '2026-10-26T08:30:00.000Z', end: '2026-10-26T09:00:00.000Z' },
  ])
  expect(
    findCalendarSlots(policy, {
      ...input,
      busy: [{ start: '2026-10-26T08:30:00Z', end: '2026-10-26T09:00:00Z' }],
    })[0]?.start,
  ).toBe('2026-10-26T09:15:00.000Z')
})
test('invalid bounds, missing service and horizon beyond 30 days fail closed', () => {
  for (const change of [
    { serviceId: 'invented' },
    { windowEnd: input.windowStart },
    { windowStart: '2026-02-30T10:00:00Z' },
    { windowEnd: '2026-12-01T00:00:00Z' },
    { windowStart: '2020-01-01T00:00:00Z' },
  ])
    expect(() => findCalendarSlots(policy, { ...input, ...change })).toThrow()
})
test('both occurrences of ambiguous fall clock labels are omitted', () => {
  const autumn = {
    ...policy,
    noticeMinutes: 0,
    weeklyHours: [{ day: 0, ranges: [{ start: '02:00', end: '04:00' }] }],
  }
  const slots = findCalendarSlots(autumn, {
    ...input,
    now: Date.parse('2026-10-24T00:00:00Z'),
    windowStart: '2026-10-25T00:00:00Z',
    windowEnd: '2026-10-25T04:00:00Z',
  })
  expect(slots[0]?.start).toBe('2026-10-25T02:00:00.000Z')
})
test('spring missing labels and intervals crossing offset changes are omitted', () => {
  const spring = {
    ...policy,
    noticeMinutes: 0,
    weeklyHours: [{ day: 0, ranges: [{ start: '01:00', end: '04:00' }] }],
  }
  const slots = findCalendarSlots(spring, {
    ...input,
    now: Date.parse('2026-03-28T00:00:00Z'),
    windowStart: '2026-03-29T00:45:00Z',
    windowEnd: '2026-03-29T03:00:00Z',
  })
  expect(slots[0]?.start).toBe('2026-03-29T01:00:00.000Z')
})
test('an ambiguous endpoint is excluded even when the start is unique and duration is not a quarter hour', () => {
  const p = {
    ...policy,
    noticeMinutes: 0,
    bufferMinutes: 0,
    services: [{ id: 'visit', name: 'Visite', durationMinutes: 20 }],
    weeklyHours: [{ day: 0, ranges: [{ start: '01:30', end: '04:00' }] }],
  }
  const slots = findCalendarSlots(p, {
    ...input,
    now: Date.parse('2026-10-24T00:00:00Z'),
    windowStart: '2026-10-24T23:45:00Z',
    windowEnd: '2026-10-25T03:00:00Z',
  })
  expect(slots[0]?.start).toBe('2026-10-25T02:00:00.000Z')
})
