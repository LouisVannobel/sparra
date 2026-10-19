import { expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { parseBillingTermsArguments } from '../../scripts/assign-billing-terms.ts'
import { fixtureDockerEnvironment } from '../fixtures/db/docker-endpoint'
import { readStripeOperatorConfig } from '../../src/modules/billing/stripe-config.server.ts'
import { createStripePriceReader } from '../../src/modules/billing/stripe-transport.server.ts'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'
import { config } from '../helpers/billing-fixtures'

const args = ['--workspace', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--environment', 'sandbox',
  '--account', 'acct_fixture', '--monthly-price', 'price_fixture', '--monthly-amount-cents', '1500', '--expected-revision', '0']
test('parses the exact commercial offer without a Customer or credentials', () => {
  expect(parseBillingTermsArguments(args)).toEqual({ workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    environment: 'sandbox', accountId: 'acct_fixture', monthlyPriceId: 'price_fixture', monthlyUnitAmount: 1500, expectedRevision: 0 })
})
test.each([
  [], args.slice(0, -2), [...args, '--account', 'acct_other'], [...args, '--unknown', 'value'],
  [...args, 'extra'], args.map(value => value === '--workspace' ? '--workspace=value' : value),
  args.map(value => value === 'sandbox' ? 'test' : value),
  args.map(value => value === 'acct_fixture' ? 'acct_bad/../../' : value),
  args.map(value => value === 'price_fixture' ? 'https://evil.invalid' : value),
  args.map(value => value === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ? '00000000-0000-0000-0000-000000000000' : value),
].map(invalid => ({ invalid })))('rejects malformed, incomplete or repeated arguments before any effects %#', ({ invalid }) => {
  expect(() => parseBillingTermsArguments(invalid)).toThrow('Billing offer input rejected')
})
test.each(['0', '-1', '+1', '1.5', '1e3', ' 1500', '1500 ', '01500', '9007199254740992', 'NaN', 'Infinity'])('rejects unsafe cents %s', value => {
  expect(() => parseBillingTermsArguments(args.map(item => item === '1500' ? value : item))).toThrow('Billing offer input rejected')
})
test.each(['-1', '01', '1.5', '1e3', '9007199254740991', '9007199254740992'])('rejects noncanonical or overflowing expected revision %s', value => {
  expect(() => parseBillingTermsArguments(args.map(item => item === '0' ? value : item))).toThrow('Billing offer input rejected')
})
test('accepts the exact safe amount/revision limits', () => {
  expect(parseBillingTermsArguments(args.map(item => item === '1500' ? '9007199254740991' : item === '0' ? '9007199254740990' : item)))
    .toMatchObject({ monthlyUnitAmount: 9007199254740991, expectedRevision: 9007199254740990 })
})
test('the actual Node24 source graph imports without executing the operator command', async () => {
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    "const cli = await import('./scripts/assign-billing-terms.ts'); if (typeof cli.assignBillingTerms !== 'function') process.exitCode=1"],
  { cwd: resolve('.'), env: fixtureDockerEnvironment(), windowsHide: true, timeout: 10000 })
  expect(result.stdout).toBe(''); expect(result.stderr).toBe('')
})
test('the native CLI rejects invalid argv with a constant diagnostic and no credential lookup', async () => {
  const result = await promisify(execFile)(process.execPath, ['scripts/assign-billing-terms.ts', '--unknown', 'synthetic-private'],
    { env: fixtureDockerEnvironment(), windowsHide: true, timeout: 10000 }).then(value => ({ ...value, code: 0 }), error => error)
  expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('Billing offer input rejected\n')
})
test('operator access requires only the protected key/account/mode and rejects mixed key modes', () => {
  const environment = { STRIPE_API_KEY: 'sk_test_fixture', STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox' }
  expect(readStripeOperatorConfig(environment)).toMatchObject({ accountId: 'acct_fixture', environment: 'sandbox' })
  expect(() => readStripeOperatorConfig({ ...environment, STRIPE_API_KEY: 'sk_live_syntheticPrivate' })).toThrow('Invalid configuration keys: STRIPE_API_KEY, STRIPE_ENVIRONMENT')
  expect(() => readStripeOperatorConfig({})).toThrow()
  expect(readStripeOperatorConfig({ ...environment, STRIPE_API_KEY: 'rk_live_fixture', STRIPE_ENVIRONMENT: 'live' })).toMatchObject({ environment: 'live' })
})
test('the Price-only reader owns deadline cancellation through complete body parsing and socket cleanup', async () => {
  const peer = await startStripeFinancialPeer(), reader = createStripePriceReader(config, new AbortController().signal, Date.now() + 300)
  try {
    peer.setReply('/v1/prices/price_fixture', { hold: 'body' })
    await expect(reader.retrievePrice('price_fixture')).rejects.toThrow('Stripe provider outcome unknown')
    await reader.close()
    expect(peer.requests().map(request => request.method + ' ' + request.path)).toEqual(['GET /v1/account', 'GET /v1/prices/price_fixture'])
    await expect.poll(peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 })
  } finally { await reader.close(); await peer.close() }
})
