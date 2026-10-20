import { expect, test } from 'vitest'
import { parseSaveCalendarPolicy } from '../../src/modules/calendar/policy'

export const validPolicy = () => ({ version: 1 as const, timeZone: 'Europe/Paris', services: [{ id: 'oil-change', name: 'Vidange', durationMinutes: 30 }], weeklyHours: [{ day: 1, ranges: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }] }], bufferMinutes: 10, noticeMinutes: 60 })
const input = () => ({ expectedRevision: 0, calendarId: 'real-calendar', enabled: true, policy: validPolicy() })
test('accepts complete owner rules and preserves stable service identities', () => {
  expect(parseSaveCalendarPolicy(input())).toEqual(input())
})
test.each([4, 7, 481])('rejects invalid service duration %s', durationMinutes => {
  expect(() => parseSaveCalendarPolicy({ ...input(), policy: { ...validPolicy(), services: [{ id: 'a', name: 'A', durationMinutes }] } })).toThrow('Invalid Calendar policy')
})
test.each([
  { services: [] }, { timeZone: 'not/a-zone' }, { bufferMinutes: 121 }, { noticeMinutes: 10081 },
  { weeklyHours: [] }, { weeklyHours: [{ day: 1, ranges: [{ start: '12:00', end: '09:00' }] }] },
  { weeklyHours: [{ day: 1, ranges: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }] },
  { weeklyHours: [{ day: 1, ranges: [{ start: '02:00', end: '04:00' }] }, { day: 1, ranges: [{ start: '06:00', end: '08:00' }] }] },
  { services: [{ id: 'a', name: 'A', durationMinutes: 5 }, { id: 'a', name: 'B', durationMinutes: 5 }] },
])('rejects incomplete or ambiguous rules %j', changes => {
  expect(() => parseSaveCalendarPolicy({ ...input(), policy: { ...validPolicy(), ...changes } })).toThrow('Invalid Calendar policy')
})
test('refuses caller Workspace authority and unknown policy versions', () => {
  expect(() => parseSaveCalendarPolicy({ ...input(), workspaceId: 'foreign' })).toThrow()
  expect(() => parseSaveCalendarPolicy({ ...input(), policy: { ...validPolicy(), version: 2 } })).toThrow()
})
