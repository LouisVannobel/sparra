import { drizzle } from 'drizzle-orm/pg-proxy'
import { expect, test } from 'vitest'
import type { BillingWorkspaceLease } from '../../src/platform/db/auth-pg-lease.server'
import { readAgreedMonthlyTerms } from '../../src/modules/billing/agreed-terms.server'
import { termsA, workspaceId } from '../helpers/billing-fixtures'

function lease(row: typeof termsA | null) {
  const db = drizzle(async (_query, params) => {
    expect(params).toEqual([workspaceId, 'sandbox', 'acct_fixture', 1])
    return { rows: row ? [[row.id, row.workspaceId, row.environment, row.accountId, row.revision, row.monthlyPriceId, row.currency, row.monthlyUnitAmount]] : [] }
  })
  // SAFETY: both Drizzle PostgreSQL drivers share the SELECT schema contract; this test replaces only query execution.
  return { db, workspaceId } as BillingWorkspaceLease
}
test('missing agreed conditions are unavailable without constructing commercial defaults', async () => {
  expect(await readAgreedMonthlyTerms(lease(null), 'sandbox', 'acct_fixture')).toBeNull()
  expect(await readAgreedMonthlyTerms(lease(termsA), 'sandbox', 'acct_fixture')).toEqual(termsA)
})
test.each([{ revision: 0 }, { monthlyUnitAmount: 0 }, { monthlyUnitAmount: Number.MAX_SAFE_INTEGER + 1 },
  { currency: 'EUR' }, { monthlyPriceId: 'prod_wrong' }])('malformed persisted agreed conditions fail closed %#', async change => {
  await expect(readAgreedMonthlyTerms(lease({ ...termsA, ...change }), 'sandbox', 'acct_fixture')).rejects.toThrow('Billing reconciliation unavailable')
})
