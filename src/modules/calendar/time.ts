/** Validate the written Gregorian label before Date.parse can normalize it. */
export function validCalendarInstant(value: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-](\d\d):(\d\d))$/.exec(value)
  if (!match) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  if (
    !year ||
    !month ||
    !day ||
    month > 12 ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    Number(match[8] ?? 0) > 23 ||
    Number(match[9] ?? 0) > 59
  )
    return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    Number.isFinite(Date.parse(value))
  )
}
