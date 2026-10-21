import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { calendarPolicySchema } from './policy'
import { validCalendarInstant } from './time'
const uuid = Schema.String.check(Schema.isUUID()),
  instant = Schema.String.check(Schema.makeFilter(validCalendarInstant)),
  natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const state = Schema.Literals(['pending', 'running', 'offered', 'confirmed', 'refused', 'unknown'])
const blocker = Schema.Struct({
  id: uuid,
  eventId: Schema.String,
  calendarId: Schema.String,
  googleSubject: Schema.String,
  state,
  start: instant,
  end: instant,
  observedState: Schema.NullOr(Schema.String),
})
const workSchema = Schema.Struct({
  id: uuid,
  workspaceId: uuid,
  callId: Schema.NullOr(uuid),
  kind: Schema.Literals(['find_slots', 'book_appointment']),
  connectionId: uuid,
  generation: natural,
  policyRevision: natural,
  googleSubject: Schema.String,
  calendarId: Schema.String,
  policy: Schema.NullOr(calendarPolicySchema),
  serviceId: Schema.String,
  serviceName: Schema.String,
  windowStart: instant,
  windowEnd: instant,
  state,
  fence: natural,
  leaseUntil: Schema.NullOr(instant),
  firstSendDeadline: instant,
  possibleSendFence: Schema.NullOr(natural),
  eventId: Schema.NullOr(Schema.String),
  createdAt: instant,
  result: Schema.Unknown,
  tokenEnvelope: Schema.NullOr(Schema.String),
  blockers: Schema.Array(blocker).check(Schema.isMaxLength(1000)),
})
export type CalendarWork = typeof workSchema.Type
export type CalendarFinish =
  | { state: 'offered'; slots: readonly { start: string; end: string }[] }
  | { state: 'confirmed'; eventId: string; operationId: string; start: string; end: string }
  | { state: 'refused' | 'unknown' | 'retry' }
export type CalendarObservation =
  | { eventId: string; status: 'cancelled' }
  | { eventId: string; status: 'confirmed' | 'tentative'; start: string; end: string }
export function createCalendarStore(owner: AuthTransactions) {
  const one = sql`(SELECT 1) AS calendar_one`
  const invoke = async (value: ReturnType<typeof sql>, signal?: AbortSignal) =>
    owner.withAuthPromise(
      {
        deadlineAtMs: Date.now() + 5000,
        statementTimeoutMs: 1000,
        cleanupTimeoutMs: 1000,
        correlationId: randomUUID(),
        signal,
      },
      async ({ db }) => (await db.select({ value }).from(one))[0]?.value,
    )
  const work = (value: unknown) => (value === null ? null : Schema.decodeUnknownSync(workSchema)(value))
  const boolean = (value: unknown) => Schema.decodeUnknownSync(Schema.Boolean)(value)
  return {
    async claim(signal?: AbortSignal) {
      return work(await invoke(sql`app_private.calendar_claim_v1()`, signal))
    },
    async read(q: Pick<CalendarWork, 'id' | 'fence'>) {
      return work(await invoke(sql`app_private.calendar_read_v1(${q.id}::uuid,${q.fence}::bigint)`))
    },
    async prepare(q: CalendarWork) {
      return boolean(
        await invoke(sql`app_private.calendar_prepare_create_v1(${q.id}::uuid,${q.fence}::bigint)`),
      )
    },
    async finish(q: CalendarWork, result: CalendarFinish) {
      return boolean(
        await invoke(
          sql`app_private.calendar_finish_v1(${q.id}::uuid,${q.fence}::bigint,${JSON.stringify(result)}::jsonb)`,
        ),
      )
    },
    async observe(q: CalendarWork, bookingId: string, result: CalendarObservation) {
      return boolean(
        await invoke(
          sql`app_private.calendar_observe_v1(${q.id}::uuid,${q.fence}::bigint,${bookingId}::uuid,${JSON.stringify(result)}::jsonb)`,
        ),
      )
    },
    async claimTokens(q: CalendarWork) {
      return Schema.decodeUnknownSync(Schema.NullOr(uuid))(
        await invoke(sql`app_private.calendar_token_claim_v1(${q.id}::uuid,${q.fence}::bigint)`),
      )
    },
    async finishTokens(q: CalendarWork, workId: string, envelope: string | null, lost: boolean) {
      return boolean(
        await invoke(
          sql`app_private.calendar_token_finish_v1(${q.id}::uuid,${q.fence}::bigint,${workId}::uuid,${envelope}::text,${lost}::boolean)`,
        ),
      )
    },
  }
}
export type CalendarStore = ReturnType<typeof createCalendarStore>
