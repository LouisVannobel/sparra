# projetV0 Commercial Wave Specification

Status: `SPEC_DRAFT_AWAITING_USER_APPROVAL`

This document freezes the P2 compatibility generation, consolidated P4, P5, and commercial evidence gate. It is not an executed probe or an implementation authorization. Its sole companion authority is `COMMERCIAL_TRANSITIONS_SPEC.md`.

## 1. Target profile

`b2b-organization-commercial-full` is an ASCII plan-local label over the existing P1 grammar, not a fourth literal authority.

```text
selfSignupPolicy        = invite-only
workspaceKinds          = {organization}
organizationCreation    = self-service
commercialCapabilities  = {plans,stripe,usage,seats}
publicSurface            = none
pwa                      = absent
SSO                      = disabled
```

The P4/P5 fixture starts with one already-admitted authenticated core User. This adds no runtime admission route, command, writer, production bootstrap, or authority. The User creates the organization with `creatorRole=owner`; invitations never establish first ownership.

### 1.1 Exact derivation closure

Files:

```text
app/auth.txt
app/core.txt
app/organization.txt
app/plans.txt
app/seats.txt
app/stripe.txt
app/usage.txt
```

Routes: `/app`, `/auth`, `/organizations`, `/pricing`, `/settings/seats`, `/usage`, `/webhooks/stripe`. `/pricing` is a private product route; the webhook is protocol ingress.

Schema: `entitlement`, `invitation`, `membership`, `organization`, `plan`, `seat_allocation`, `session`, `stripe_event`, `subscription`, `usage_event`, `user`, `workspace`.

Migrations: `001_core.sql`, `011_organization.sql`, `020_plans.sql`, `021_stripe.sql`, `022_usage.sql`, `023_seats.sql`.

Environment: `DATABASE_URL`, `STRIPE_API_KEY`.

Commands: `organization:create`, `plans:list`, `seats:assign`, `stripe:reconcile`, `usage:record`, `workspace:list`.

UI: `home`, `organizations`, `plans`, `seats`, `usage`.

Declared workers: `stripe-events`, `usage-rollup`; P4/P5 do not qualify Hatchet delivery. Service worker: none.

Direct packages: `better-auth@1.7.1`, `drizzle-orm@0.45.2`, `stripe@22.5.0`.

Client bundle: core, organization, plans, seats, usage. Server bundle: auth, core, organization, plans, seats, stripe, usage. Personal, marketing, PWA, and SSO surfaces are zero.

## 2. Status and dependency graph

Sections 1-4 are design approvals only. Current P1/P3 reuse status is `REUSE_NOT_PROVEN`: the historical closure combined P1-P3 and normalized line endings, so it does not prove review-bound raw-byte per-probe identity.

Before a future commercial run:

1. reuse P1/P3 only from an already-preserved, review-bound raw-byte per-probe package that matches current bytes; otherwise rerun P1/P3 with fresh reviews;
2. produce a fresh P2 compatibility generation and verdict;
3. execute one consolidated P4 using the entire transition spec and obtain its verdict;
4. execute P5 against that exact P4 digest.

```text
preserved-or-rerun P1/P3 + fresh P2 generation
                         |
                         v
               one consolidated P4
                         |
                         v
                        P5
```

P6-P9 remain catalogued, deferred, unexecuted, unpassed, and absent from this wave. No A01, aggregate, or boilerplate-readiness claim is permitted.

## 3. P2 compatibility generation

The old P2 package remains historical for its old bytes but becomes downstream-ineligible when compatibility bytes change. `P2a` is only a generation label; the result remains `probeId="P2"`.

The future P2 spec must:

- add static `billing_admin` to the Organization role catalog;
- add typed `updateMemberRole` to the existing sole server-only Organization port;
- accept one known role and reject arrays, comma-separated, empty, or unknown roles;
- keep one raw caller and one unchanged `auth.handler` mount;
- rerun every P2 claim command and artifact closure;
- rebuild the package/digest and obtain fresh independent and Oracle verdicts.

P4 is blocked until that verdict exists. `A04.N01/A04.P01` proves only mount/import/raw-caller/typed-port and static role-shape closure. `C05.N01/C05.P01` exclusively proves real commercial `billing_admin -> consuming role` seat causality.

## 4. Consolidated P4

P4 consumes the complete digest of `COMMERCIAL_TRANSITIONS_SPEC.md`, including Agreement/fallback, ACLs, usage, seats, ambiguity, refund, disputes, product-unit debt, compensation, expiry, and purge rules. There is one P4 package and review cycle, not a base result followed by a P5 amendment.

The historical P4 dependency on a P6 facade is superseded by the fixture-private known-outcome P4 seam. No P6 artifact, verdict, or behavior is consumed.

| Claim | Negative | Positive | Ownership |
|---|---|---|---|
| A16 | A16.N01 | A16.P01 | commercial writer/ACL/conservation, refund/dispute/debt/compensation/expiry |
| C05 | C05.N01 | C05.P01 | real Better Auth seat causality |
| Q01 | Q01.N01 | Q01.P01 | ambiguity surfacing and repair |
| Q02 | Q02.N01 | Q02.P01 | RC locks and contention |

No new P4 claim or command ID is allowed.

## 5. P5 exact Stripe contract

### 5.1 Pins and evidence boundary

```text
stripe version         = 22.5.0
npm integrity          = sha512-QVwMwriC0bbySx6R4dpsvJ0W//GojC1kwWVS6rPSoVqDUIZX4Hy3TaUrd2AZeXEAaKbfWIjQjvo3vKAReHZ0vQ==
shasum                 = 78efe2b9ebcb167da966c356138f2f5ceb3f443e
gitHead                = 65d99a2b76d0786d7cec8544920affadccc8b670
request API            = 2026-07-29.dahlia
webhook event API      = 2026-07-29.dahlia
maxNetworkRetries      = 0
billing_mode.type      = flexible where typed endpoint support exists
account                = configured platform account
Stripe-Account         = absent
event destination      = account-level, non-organization
```

The loopback fixture proves only exact client/wire/local state-machine behavior. Stripe cache, Search, account, retention, and provider status semantics remain source-backed. No live Stripe mutation occurs.

### 5.2 Intent, idempotency, and admission fence

Immutable `EffectIntent` includes effect/lineage/sequence, operation kind, environment/account, API/method/endpoint, canonical request hash, key, first-attempt wall and monotonic origins, fixed 23-hour horizon, provider IDs, and authority bindings.

`UNIQUE(providerEnvironment, accountScope, idempotencyKey)` permanently binds the complete effect, lineage, kind, API, method, endpoint, and hash. Drift fails before SDK use.

Permanent `MutationFence` domains, with no lease/TTL/delivery meaning:

- create: `(environment,account,workspace,billingCustomer,SUBSCRIPTION_CREATE_SLOT)`;
- subscription mutation: `(environment,account,subscriptionId)`;
- refund: top-up disposition;
- disputes: retrieve/webhook only, no POST fence.

Agreement generation is payload binding, not create-slot identity. Any unresolved/UNKNOWN effect blocks all lineages in the domain. A successor needs conclusive predecessor failure and `supersedesEffectId`.

Under the P4 authority lock, one known-outcome transaction persists intent, permanent key binding, fence, sequence, and hold. Only a later fresh read of committed `ADMITTED` authorizes POST. Unknown local finalization yields zero provider call and a fresh local read only; no P6 claim is made.

### 5.3 Attempts, resolutions, and semantic application

`EffectAttempt` and `EffectResolution` are append-only. Each operation family has a closed versioned transition table; no generic status ranking exists.

Permanent `SemanticApplicationFence` is unique by `(providerEnvironment,accountScope,semanticEffectIdentity)` and has no lease/TTL/delivery semantics. The processor inserts/locks this stable fence before P4.

Immutable `EffectApplication` is unique by fence ID; `effectResolutionId` is provenance only. Existing exact `effectId+planHash+p4CommandIdentity` replays without P4; drift fails before mutation. Otherwise the same known-outcome transaction calls one P4 guard, inserts the application, advances inbox, and commits. Concurrent valid resolutions produce one P4 call.

### 5.4 Wire observations and replay

The loopback TLS fixture separately counts application calls, physical requests, unique keys, and provider executions. With `maxNetworkRetries=0`, one SDK call emits one physical request.

Closed observations:

- local validation before SDK: `NOT_ATTEMPTED`;
- timeout, connection loss, unknown transport, any 5xx, repeated/cached 500: `UNKNOWN`;
- same-key peer conflict: `UNKNOWN`;
- rate-limit or `lock_timeout` 429: same-key retryable only inside the horizon, never new-key eligible;
- deterministic 4xx: conclusive only for a source-backed pre-execution class or after authoritative retrieval proves predecessor failure.

The fake mutates before every 500/timeout negative control. Loopback knowledge of a pre-accept cut is never production absence proof.

Replay uses only the same key, canonical parameters, and account in the same process with monotonic elapsed under 23 hours. Forward wall jumps may shorten permission. Restart, backward time, or doubt removes it. No POST occurs after the horizon.

### 5.5 Provider states

PaymentIntent: `succeeded` succeeds; `canceled` fails conclusively; `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, and `requires_capture` remain non-authoritative.

Refund: `succeeded` succeeds; `failed|canceled` fails; `pending|requires_action` remains pending.

Dispute: `warning_needs_response|warning_under_review|needs_response|under_review` is open; `lost` confirms debt but remains late-win reversible; `won|prevented|warning_closed` is non-adverse closure.

Checkout creates navigation only. A paid Checkout, active Subscription, or successful PI alone is insufficient.

Upgrade supports only `collection_method=charge_automatically` and exact typed pending-update fields/methods, with `pending_if_incomplete` and `always_invoice`. Unsupported configurations reject before POST. Success requires exact pending update applied and the exact mutation invoice authority below.

Downgrade supports only the same currency, cadence, interval, and anchor, no pending update, and `proration_behavior=none`. Cross-cadence is unsupported. Local effect begins only at the next reconciled paid period.

Cancellation uses `cancel_at_period_end`; fallback occurs only at the authoritative effective end.

### 5.6 Dahlia InvoicePayment authority

Embedded Invoice payment data is never authority. P5:

1. reads the exact bound Invoice;
2. traverses the unfiltered InvoicePayment endpoint to `has_more=false` under a typed 5x100 fixture safety budget;
3. rejects duplicate IDs, bad cursors, and exhaustion;
4. rereads the Invoice;
5. repeats the complete traversal;
6. requires identical sorted allocation digest and unchanged bound fields.

Any mutation remains non-authoritative.

Accepted origin is Stripe-collected PaymentIntent only:

```text
sum(accepted InvoicePayment.amount_paid)
  = invoice.amount_paid
  = invoice.amount_due
  = invoice.total
  = acceptedAmount
  > 0
```

Also require zero `starting_balance`, `ending_balance`, `amount_remaining`, `amount_overpaid`, pre/post-payment credit-note amounts, and `paid_out_of_band=false`.

Every allocation is paid, PI-typed, backed by an exact retrieved `PaymentIntent succeeded`, and matches environment, account, customer, subscription, invoice, lines, period, currency, and lineage. Enumerated customer-balance transactions relevant to the Invoice must contain no `applied_to_invoice` or other credit application.

Customer credit, Payment Records, direct Charges, out-of-band, zero/minimum-charge, or non-PI residual is unsupported and produces zero P4 grant. Multiple PIs are allowed for subscription invoices only when all parts pass and sum exactly. A self-service refundable top-up requires one PI covering the full source amount/currency.

### 5.7 Webhook causality

Before receipt, require:

```text
event.account = null
event.context = null
event.livemode = providerEnvironment.expectedLivemode
effectiveEventAccountId = configuredPlatformAccountId
```

The NOT NULL receipt key is `(providerEnvironment,platformAccountId,effectiveEventAccountId,event.id)`. Reject Connect/organization account or context. Retrieves use neither `Stripe-Account` nor `Stripe-Context`.

After exact raw-body bounds, signature, and event-version validation, receipt and durable inbox persist atomically before ACK. Webhook is trigger-only. The local reconciler retrieves exact provider objects before appending resolution. A pure no-I/O reducer returns `EffectPlan`; the application processor invokes P4.

Semantic identity includes environment/account, provider object, Agreement/generation, paid period, and transition. Redelivery, distinct events for one fact, arbitrary order, historical Agreement facts, refunds/disputes, and newer retrieves must converge without moving historical A over current B or recreating a period grant.

### 5.8 Search

Checkpointed provider IDs are directly retrieved first. Otherwise traverse a typed 5x100 budget, retrieve every relevant candidate, require exactly one full match, and exhaust the result set. Zero, mismatch, multiple matches, stale index/current mismatch, or unexhausted `has_more` remains `UNKNOWN` and permits no POST.

### 5.9 Retention

UNKNOWN evidence has no expiry and never compacts. Minimal tombstone retains effect/key/hash/account/API/endpoint/lineage, provider IDs, and terminal resolution/application digest. It is `NEVER_DELETE_BY_P5`, blocks identity reuse, and is the future P7 input.

Resolved payload compacts only after persisted `windowPolicyId`, official source digest, provider/webhook closure timestamps, reconciler watermark, and no incident/current-Agreement dependency. Synthetic short windows prove local machinery only. Compaction is one idempotent PostgreSQL transaction persisting tombstone, terminal digest, watermark, and marker before deletion. Late evidence appends resolution and never rewrites history.

### 5.10 P5 claim mapping

| Claim | Negative | Positive | Ownership |
|---|---|---|---|
| A17 | A17.N01 | A17.P01 | monetary authority |
| A18 | A18.N01 | A18.P01 | webhook/effect/Agreement causality |
| A19 | A19.N01 | A19.P01 | local vs source-backed boundary |
| A20 | A20.N01 | A20.P01 | retry ownership and wire counts |
| A21 | A21.N01 | A21.P01 | safe replay clock |
| A22 | A22.N01 | A22.P01 | same-key conflict/no fresh key |
| A23 | A23.N01 | A23.P01 | Search/retrieve authority |
| Q03 | Q03.N01 | Q03.P01 | unknown retention/late proof |

No new claim or command ID is allowed.

## 6. Evidence compatibility and invalidation

`ProbeObservationV1` and `ProbeResultV1` remain byte-compatible. Observation fields stay exactly `claimId`, `runId`, `phase`, `commandId`, `mutationOrFaultId`, `expected`, `actual`, `exitCode`, `stdoutSha256`, `stderrSha256`, `artifactSha256`.

`artifactSha256` binds the complete canonical sorted artifact set, including paths and bytes. A versioned captured-evidence document is a required member of that set; the field is not its standalone digest. Detailed timestamps, digests, metadata, limits, runtime settings, catalog, and source facts live in captured evidence. Manifest-last packaging binds the set. Prose cannot self-attest.

The root authority/tool digest covers the claims catalog, result schema/decoder, shared runner, verifier, manifest-last packager, and every consumed shared package/version/lock byte. Root change invalidates all dependants; probe/spec input change invalidates that probe and descendants. Non-input documentation remains local.

The global verifier is unchanged. A separately hashed commercial gate enforces zero unresolved P0/P1/P2 for this wave.

## 7. CommercialWaveV1

`CommercialWaveV1` is external, not `ProbeResultV1`, A01, a claim, aggregate, or readiness verdict. It selects inputs by digest only, never `latest` or mtime.

It binds wave/gate/root/spec/input digests; preserved-or-rerun P1/P3 packages; historical ineligible and one fresh eligible P2 package; P4/P5 packages; each result run ID; and predecessor verdict digests. It validates only required P1-P5 claims, proves P6-P9 absent, and checks every consumed result/review/arbitration/Oracle finding.

## 8. Non-circular review receipts

`CommercialReviewVerdictV1` fields:

```text
schemaVersion
reviewerId
reviewerRole
reviewSessionId
scope
promptSha256
reportSha256
reviewedSpecDigests
reviewedPackageDigests
consumedReviewReceiptDigests
verdict
findings[{findingId,severity,status}]
```

The three specialist reviewer/session IDs are pairwise distinct and every `consumedReviewReceiptDigests` is exactly empty.

`CommercialArbitrationV1` fields:

```text
schemaVersion
reportSha256
consumedReviewDigests
dispositions[{reviewDigest,findingId,severity,status}]
```

It consumes exactly the three specialist receipts, excludes Oracle, and covers their exact finding union once.

After arbitration, an Oracle candidate manifest binds package, specialist, and arbitration digests.

`CommercialOracleReceiptV1` fields:

```text
schemaVersion
oracleSessionId
scope
candidateManifestSha256
promptSha256
transcriptSha256
reportSha256
conversationId
turnId
conversationUrl
recoveryAttemptId
verdict
findings[{findingId,severity,status}]
```

Committed identifiers are nonempty. Terminal closure binds candidate and Oracle receipt. Oracle never claims a future envelope digest. If Oracle requests an input change, affected package and specialist/arbitration cycle restart. Post-commit browser failure is recover-only; Trusted Access/removal is terminal for that scope.

## 9. Authorization boundary

This spec and `COMMERCIAL_TRANSITIONS_SPEC.md` await explicit user approval.

Before approval, forbidden actions include edits to existing design/source/fixture/catalog/plan/root repository; tests, builds, installs, codegen or evidence commands; migrations; commits, pushes, deployments; live Stripe; CI/CD or infrastructure changes.

After approval, the next permitted phase is writing and submitting a separate implementation plan. Execution still requires a later explicit user `go`.

