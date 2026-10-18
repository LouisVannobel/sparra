import { and, desc, eq } from 'drizzle-orm'
import { Schema } from 'effect'
import type { BillingWorkspaceLease } from '../../platform/db/auth-pg-lease.server'
import { billingAgreedTerms, type billingOperation } from './schema.server'
import { billingEnvironment, billingIds, billingPositive, billingUuid, decodeBilling } from './billing-agreement.server'
import type { CheckoutIntent } from './stripe.server'

export const agreedMonthlyTermsSchema = Schema.Struct({ id: billingUuid, workspaceId: billingUuid,
  environment: billingEnvironment, accountId: billingIds.account, revision: billingPositive,
  monthlyPriceId: billingIds.price, currency: Schema.String.check(Schema.isPattern(/^[a-z]{3}$/)), monthlyUnitAmount: billingPositive })
export type AgreedMonthlyTerms = typeof agreedMonthlyTermsSchema.Type

// The native financial resolver owns the Workspace lock for this lease.
export async function readAgreedMonthlyTerms(lease: BillingWorkspaceLease, environment: AgreedMonthlyTerms['environment'],
  accountId: string): Promise<AgreedMonthlyTerms | null> {
  const [row] = await lease.db.select().from(billingAgreedTerms).where(and(eq(billingAgreedTerms.workspaceId, lease.workspaceId),
    eq(billingAgreedTerms.environment, environment), eq(billingAgreedTerms.accountId, accountId)))
    .orderBy(desc(billingAgreedTerms.revision)).limit(1)
  return row ? decodeBilling(agreedMonthlyTermsSchema, row) : null
}

export function operationMonthlyTerms(operation: Pick<typeof billingOperation.$inferSelect,
  'agreedTermsId' | 'monthlyPriceId' | 'currency' | 'monthlyUnitAmount' | 'onboardingPriceId' | 'onboardingUnitAmount'>): CheckoutIntent['terms'] {
  if (!operation.agreedTermsId || !operation.monthlyPriceId || !operation.currency || !operation.monthlyUnitAmount
    || operation.onboardingPriceId !== null || operation.onboardingUnitAmount !== null) throw new Error('Billing terms unavailable')
  return { id: operation.agreedTermsId, monthlyPriceId: operation.monthlyPriceId,
    currency: operation.currency, monthlyUnitAmount: operation.monthlyUnitAmount }
}
