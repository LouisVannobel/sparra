import { Schema } from 'effect'

const integer = (min: number, max: number) => Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }))
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max), Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\ud800-\udfff]+$/u))
const clock = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
const range = Schema.Struct({ start: clock, end: clock }).check(Schema.makeFilter(value => value.start < value.end))
const service = Schema.Struct({ id: text(80).check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)), name: text(80).check(Schema.makeFilter(value => value.trim() === value)), durationMinutes: integer(5,480).check(Schema.makeFilter(value => value % 5 === 0)) })
const hours = Schema.Struct({ day: integer(0,6), ranges: Schema.Array(range).check(Schema.isMinLength(1), Schema.isMaxLength(2), Schema.makeFilter(value => value.length < 2 || value[0]!.end <= value[1]!.start)) })
export const calendarPolicySchema = Schema.Struct({
  version: Schema.Literal(1),
  timeZone: text(128).check(Schema.makeFilter(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return value === 'UTC' || value.includes('/') } catch { return false } })),
  services: Schema.Array(service).check(Schema.isMinLength(1), Schema.isMaxLength(30), Schema.makeFilter(value => new Set(value.map(item => item.id)).size === value.length)),
  weeklyHours: Schema.Array(hours).check(Schema.isMinLength(1), Schema.isMaxLength(7), Schema.makeFilter(value => new Set(value.map(item => item.day)).size === value.length)),
  bufferMinutes: integer(0,120), noticeMinutes: integer(0,10080),
})
export type CalendarPolicy = typeof calendarPolicySchema.Type
const save = Schema.Struct({ expectedRevision: integer(0,2147483646), calendarId: text(1024), enabled: Schema.Boolean, policy: calendarPolicySchema })
export type SaveCalendarPolicy = typeof save.Type
export class InvalidCalendarPolicy extends Error {
  constructor() { super('Invalid Calendar policy'); this.name = 'InvalidCalendarPolicy' }
}
export function parseSaveCalendarPolicy(input: unknown): SaveCalendarPolicy {
  try { return Schema.decodeUnknownSync(save, { onExcessProperty: 'error' })(input) } catch { throw new InvalidCalendarPolicy() }
}
/** Search limits are implementation contracts, never inferred business rules. */
export const calendarOfferLimits = { horizonDays: 30, stepMinutes: 15, maximumOffers: 3, validityMs: 300000 } as const
