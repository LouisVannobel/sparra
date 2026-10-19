import { Client } from 'pg'
import { Redacted } from 'effect'
import { readMigrationConfig } from '../src/platform/db/config.server.ts'
import { readStripeOperatorConfig, type StripeAccessConfig } from '../src/modules/billing/stripe-config.server.ts'
import { createStripePriceReader } from '../src/modules/billing/stripe-transport.server.ts'
import { matchesMonthlyPrice } from '../src/modules/billing/monthly-price.server.ts'

export type BillingTermsInput = Readonly<{ workspaceId: string; environment: 'sandbox' | 'live'; accountId: string;
  monthlyPriceId: string; monthlyUnitAmount: number; expectedRevision: number }>
type Assignment = Readonly<{ id: string; workspaceId: string; environment: BillingTermsInput['environment']; accountId: string;
  revision: number; status: 'assigned' | 'existing' }>
type PriceReaderFactory = (config: StripeAccessConfig, signal: AbortSignal, deadlineAtMs: number) => ReturnType<typeof createStripePriceReader>
class BillingOfferError extends Error {}
const inputError = () => new BillingOfferError('Billing offer input rejected')
const unavailable = () => new BillingOfferError('Billing offer unavailable')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function validInput(input: BillingTermsInput) {
  return uuid.test(input.workspaceId) && ['sandbox', 'live'].includes(input.environment)
    && /^acct_[A-Za-z0-9]+$/.test(input.accountId) && input.accountId.length <= 255
    && /^price_[A-Za-z0-9]+$/.test(input.monthlyPriceId) && input.monthlyPriceId.length <= 255
    && Number.isSafeInteger(input.monthlyUnitAmount) && input.monthlyUnitAmount > 0
    && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && input.expectedRevision < Number.MAX_SAFE_INTEGER
}
export function parseBillingTermsArguments(args: readonly string[]): BillingTermsInput {
  const allowed = ['--workspace', '--environment', '--account', '--monthly-price', '--monthly-amount-cents', '--expected-revision']
  const values = new Map<string, string>()
  if (args.length !== allowed.length * 2) throw inputError()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]
    if (!flag || !value || !allowed.includes(flag) || values.has(flag)) throw inputError()
    values.set(flag, value)
  }
  const workspaceId = values.get('--workspace'), environment = values.get('--environment'), accountId = values.get('--account')
  const monthlyPriceId = values.get('--monthly-price'), amount = values.get('--monthly-amount-cents'), revision = values.get('--expected-revision')
  if (!workspaceId || environment !== 'sandbox' && environment !== 'live' || !accountId || !monthlyPriceId
    || !amount || !/^[1-9][0-9]*$/.test(amount) || !revision || !/^(?:0|[1-9][0-9]*)$/.test(revision)) throw inputError()
  const input = { workspaceId, environment, accountId, monthlyPriceId, monthlyUnitAmount: Number(amount), expectedRevision: Number(revision) } satisfies BillingTermsInput
  if (!validInput(input)) throw inputError()
  return Object.freeze(input)
}
async function validateProvider(input: BillingTermsInput, config: StripeAccessConfig, factory: PriceReaderFactory) {
  let reader: ReturnType<typeof createStripePriceReader> | undefined, failed = false
  try {
    reader = factory(config, AbortSignal.timeout(30000), Date.now() + 30000)
    const price = await reader.retrievePrice(input.monthlyPriceId)
    if (!matchesMonthlyPrice(price, input.monthlyPriceId, config.environment === 'live', 'eur', input.monthlyUnitAmount)) failed = true
  } catch { failed = true }
  finally { try { await reader?.close() } catch { failed = true } }
  if (failed) throw unavailable()
}
type TermsRow = { id: string; revision: string; monthly_price_id: string; currency: string; monthly_unit_amount: string }
export async function assignBillingTerms(input: BillingTermsInput, database: ReturnType<typeof readMigrationConfig>,
  config: StripeAccessConfig, providerFactory: PriceReaderFactory = createStripePriceReader): Promise<Assignment> {
  if (!validInput(input) || input.environment !== config.environment || input.accountId !== config.accountId) throw inputError()
  await validateProvider(input, config, providerFactory)
  const client = new Client({ connectionString: Redacted.value(database.url), application_name: 'sparra-billing-operator',
    connectionTimeoutMillis: database.connectTimeoutMs, statement_timeout: database.statementTimeoutMs,
    query_timeout: database.statementTimeoutMs + database.cleanupTimeoutMs })
  client.on('error', () => {})
  let transactionStarted = false, commitAttempted = false, committed = false
  let assignment: Assignment | undefined, failure: BillingOfferError | undefined
  try {
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); transactionStarted = true
    const workspace = await client.query<{ kind: string; lifecycle: string; owner_user_id: string; auth_organization_id: string | null }>(
      'SELECT kind,lifecycle,owner_user_id,auth_organization_id FROM public.workspace WHERE id=$1 FOR UPDATE', [input.workspaceId])
    const row = workspace.rows[0]
    if (!row || row.kind !== 'personal' || row.lifecycle !== 'active' || !row.owner_user_id || row.auth_organization_id !== null)
      throw new BillingOfferError('Billing Workspace unavailable')
    const current = (await client.query<TermsRow>(
      'SELECT id,revision,monthly_price_id,currency,monthly_unit_amount FROM public.billing_agreed_terms WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 ORDER BY revision DESC LIMIT 1',
      [input.workspaceId, input.environment, input.accountId])).rows[0]
    const revision = current ? Number(current.revision) : 0
    if (!Number.isSafeInteger(revision) || revision < 0) throw unavailable()
    if (current && revision === input.expectedRevision + 1 && current.monthly_price_id === input.monthlyPriceId
      && current.currency === 'eur' && Number(current.monthly_unit_amount) === input.monthlyUnitAmount) {
      assignment = { id: current.id, workspaceId: input.workspaceId, environment: input.environment, accountId: input.accountId, revision, status: 'existing' }
    } else {
      if (revision !== input.expectedRevision) throw new BillingOfferError('Billing offer conflict')
      const inserted = (await client.query<{ id: string }>(
        "INSERT INTO public.billing_agreed_terms(workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,$2,$3,$4,$5,'eur',$6) RETURNING id",
        [input.workspaceId, input.environment, input.accountId, revision + 1, input.monthlyPriceId, input.monthlyUnitAmount])).rows[0]
      if (!inserted) throw unavailable()
      assignment = { id: inserted.id, workspaceId: input.workspaceId, environment: input.environment, accountId: input.accountId, revision: revision + 1, status: 'assigned' }
    }
    commitAttempted = true
    const result = await client.query('COMMIT')
    if (result.command !== 'COMMIT') throw unavailable()
    committed = true
  } catch (error) {
    failure = commitAttempted && !committed ? new BillingOfferError('Billing offer commit unknown; rerun the identical command to observe')
      : error instanceof BillingOfferError ? error : unavailable()
  } finally {
    // One owned cleanup budget covers rollback and shutdown. An uncertain COMMIT
    // is never called a rollback and never automatically replayed.
    const timer = setTimeout(() => client.connection.stream.destroy(), database.cleanupTimeoutMs)
    try {
      if (commitAttempted && !committed) client.connection.stream.destroy()
      try { if (transactionStarted && !commitAttempted) await client.query('ROLLBACK') }
      finally { await client.end() }
    } catch {
      failure ??= new BillingOfferError(committed ? 'Billing offer committed; cleanup failed' : 'Billing offer unavailable')
    } finally { clearTimeout(timer) }
  }
  if (failure) throw failure
  if (!assignment) throw unavailable()
  return Object.freeze(assignment)
}
if (import.meta.main) {
  try {
    const input = parseBillingTermsArguments(process.argv.slice(2))
    const database = readMigrationConfig(process.env), config = readStripeOperatorConfig(process.env)
    process.stdout.write(JSON.stringify(await assignBillingTerms(input, database, config)) + '\n')
  } catch (error) {
    process.stderr.write((error instanceof BillingOfferError ? error.message : 'Billing offer unavailable') + '\n')
    process.exitCode = 1
  }
}
