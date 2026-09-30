import { Schema } from 'effect'

const email = Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
export function normalizeAuthEmail(input: unknown): string {
  try { return Schema.decodeUnknownSync(email)(Schema.decodeUnknownSync(Schema.String)(input).trim().toLowerCase()) }
  catch { throw new Error('Auth email request rejected') }
}
