# projetV0 Commercial Transitions Specification

Status: `SPEC_DRAFT_AWAITING_USER_APPROVAL`

This document is the shared specification authority for the commercial
transitions owned by P4 and consumed by P5. It is not an implementation result,
an executed probe, a production-readiness claim, or permission to change source,
fixtures, infrastructure, CI/CD, migrations, or Stripe state.

Its digest is an input to both P4 and P5. Any substantive change invalidates the
future P4 and P5 evidence packages and their review chain.

## 1. Scope and ownership

P4 owns only:

- `A16`: guarded commercial writer surface, ACLs, legal transitions, and
  conservation;
- `C05`: real Better Auth invitation acceptance and non-consuming-to-consuming
  role causality;
- `Q01`: bounded ambiguity surfacing and conclusive repair;
- `Q02`: authority-row contention and lock-plan characterization.

P5 owns provider outcome interpretation. P4 must not contain Stripe cache,
Search, webhook-delivery, retry-horizon, or provider-outcome logic.

P6 and P7 are not predecessors. P4 uses a fixture-private, known-outcome
transaction seam; it imports no P6 facade and claims no pool-wire ambiguity,
single-flight, lease, TTL, Hatchet, or provider-delivery behavior.

## 2. Inputs and prerequisite identity contract

Before any P4 run, P2 must have a freshly approved digest containing:

- the existing sole server-only Organization port;
- a typed `updateMemberRole` operation on that port;
- a static `billing_admin` Better Auth Organization role;
- rejection of arrays, comma-separated roles, empty values, and unknown roles;
- the unchanged single `auth.handler` mount and raw-caller boundary.

The P2 static boundary remains owned by `A04.N01/A04.P01`. The commercial
behavior of `billing_admin -> member|admin|owner` remains owned exclusively by
`C05.N01/C05.P01`.

## 3. Transaction and lock contract

P4 accepts only explicit PostgreSQL `READ COMMITTED`. It refuses Repeatable Read
and Serializable before business SQL. Every guarded command declares its lock
classes before the first lock and follows this total order:

```text
User?
  -> Workspace?
  -> BillingAgreements sorted by ID
  -> SeatAssignments sorted by ID
  -> UsageAccounts sorted by (workspaceId, meterKey)
  -> UsageLots sorted by (expiresAt NULLS LAST, grantedAt, id)
  -> UsageAllocations sorted by (operationId, lotId, id)
```

A deliberately skipped earlier class may not be acquired later. A pure terminal
transition of an already-authorized immutable `UsageOperation` may start at its
`UsageAccount`, but may not later touch Workspace, Agreement, or seat authority.
Every decisive dependent-row reread happens after the corresponding authority
lock.

The fixture-private transaction seam:

- asserts `READ COMMITTED` and the P3 zero-sentinel/tenant setup before business
  SQL;
- is non-exported and non-reentrant;
- performs no automatic retry;
- composes neither the Better Auth adapter nor Drizzle transaction ownership;
- supports only known `BEGIN`, `COMMIT`, and `ROLLBACK` outcomes.

Any transaction transport/finalization uncertainty invalidates the entire P4
run, stops later evidence, and closes the dedicated fixture pool/process on a
best-effort basis. No client is reused and no P6 outcome claim is made.

## 4. Workspace, PlanVersion, and BillingAgreement

For this profile, an active commercial Workspace has a non-null
`currentAgreementId`. Provisioning may be null before commercial initialization;
deleting may be null after pointer detachment.

Required relationships:

- composite same-Workspace FK from `(Workspace.id, currentAgreementId)` to
  `(BillingAgreement.workspaceId, BillingAgreement.id)`;
- `BillingAgreement.workspaceId -> Workspace.id ON DELETE RESTRICT`;
- published `PlanVersion` rows are immutable;
- historical `BillingAgreement` rows are immutable outside the deletion
  protocol.

Agreement change inserts an immutable successor before an expected-pointer CAS
under `Workspace FOR UPDATE`. It never edits the historical Agreement in place.

The target profile selects one internal, non-vendable FREE fallback PlanVersion
with exactly one licensed seat. `cancel_at_period_end` has no local effect before
the reconciled effective end. At effective fallback, seat retention order is:

1. owner first;
2. earliest `activatedAt`;
3. lowest stable ID.

The tail beyond capacity is released.

### 4.1 Initial commercial state

After the real Better Auth organization and creator-owner checkpoint, but before
`Workspace provisioning -> active`, idempotent
`initialize_commercial_workspace`:

- inserts the fallback Agreement;
- CAS-sets `currentAgreementId`;
- inserts a deterministic predecessor-free `SeatAssignment ACTIVE` for the real
  owner membership;
- uses `operationKind=INITIAL_OWNER_LICENSE`;
- performs no Better Auth call.

The closed SQL branch requires null invitation and predecessor IDs, non-null real
owner membership, source Agreement equal to the initial fallback, and uniqueness
of operation and non-released membership. Exact replay returns the existing
result; mismatched replay or reinitialization fails.

### 4.2 Pointer and deletion authority

The P4 definer has only:

- enumerated `SELECT` on Workspace;
- column-level `UPDATE(currentAgreementId)`;
- no `UPDATE(lifecycle)`, no other Workspace-column update, and no Workspace
  delete.

The core writer exclusively owns Workspace lifecycle and deletion. Under one
Workspace lock and transaction it performs `active -> deleting`, then calls
`detach_current_agreement(expectedId)`, which requires `deleting` and CAS-nulls
the pointer.

`purge_commercial_state(workspaceId)` then locks and verifies the still-existing
tenant-local deleting Workspace and deletes in this order:

```text
UsageAllocations
UsageOperations
UsageLots
UsageAccounts
SeatAssignments
BillingAgreements
```

Agreement deletion is allowed only for the P4 definer while the locked parent
Workspace exists in `deleting`. The FK `RESTRICT` makes an early core deletion
fail. After commercial state is empty, core alone deletes Workspace.

## 5. Closed ACL and writer matrix

Commercial base tables grant no runtime DML and no PUBLIC rights.

`p4_web` may execute only:

- commercial Workspace initialization;
- seat reserve/finalize functions;
- usage reserve/commit/release functions;
- the `requiresSeat` access predicate.

`p4_worker` may execute only:

- seat reconciliation and incident scan;
- usage lot issuance and expiry;
- Agreement successor/fallback functions;
- refund, dispute, debt-settlement, and commercial purge functions.

`p4_relay` has no commercial privilege.

The dedicated function owner is `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, owns
functions but not tables, has only enumerated relation/column rights, uses a
fixed safe `search_path`, fully schema-qualified static SQL, and no dynamic SQL.
All commercial tables use `FORCE RLS` and tenant validation. Every function
signature is explicitly revoked from PUBLIC; default ACLs for tables, sequences,
and functions are closed for every creating role. No runtime role has a
membership or `SET ROLE` path to the definer.

## 6. Usage pools and exact replay

`UsageAccount(workspaceId, meterKey)` is the mutex for one non-fungible meter.
The closed tables are `UsageLot`, `UsageOperation`, and `UsageAllocation`.
Composite FKs keep Account, Lot, Operation, and Allocation in one Workspace and
meter.

Every lot satisfies:

```text
granted >= 0
available,reserved,consumed,held,expired,revoked >= 0
granted = available + reserved + consumed + held + expired + revoked
```

Every operation has a unique `(workspaceId, meterKey, logicalOperationId)` and
only `RESERVED -> COMMITTED|RELEASED|EXPIRED` once. Its amount, Workspace,
meter, logical identity, and lineage are immutable. Allocation sum equals the
operation amount in the same guarded transaction.

Required guarded functions are:

- `issue_usage_lot`;
- `reserve_usage`;
- `commit_usage`;
- `release_usage`;
- `expire_usage`.

They lock the UsageAccount, choose lots by deterministic FEFO without
`SKIP LOCKED`, require exact CAS row counts, and reassert allocation and lot
conservation before return.

Source kinds are closed:

- `PLAN_ALLOWANCE`, unique by
  `(agreementId, planVersionId, meterKey, grantPeriodStart)`;
- `PREPAID_TOPUP`, unique by
  `(workspaceId, meterKey, providerEffectId)`;
- `DEBT_REVERSAL_COMPENSATION`, unique by
  `(originalDebtSettlementId, winningGeneration)`.

Exact replay returns the existing row only when all amount, source, Agreement,
PlanVersion, meter, period, and lineage fields match. Any drift fails before a
balance mutation.

## 7. Seat operation state machine

`SeatAssignment` carries immutable operation, source Agreement, expected Better
Auth identity, state/version, dates, reason, reconciliation marker, and optional
`predecessorAssignmentId`. There is no mutable successor field.

Closed operation kinds:

- `INITIAL_OWNER_LICENSE`;
- `INVITATION_ACCEPT`;
- `ROLE_PROMOTION`;
- `OWNER_TRANSFER`.

Partial uniqueness enforces one `PENDING|ACTIVE` assignment per invitation and
one non-released assignment per membership. `operationId` is globally unique.
Capacity counts `PENDING + ACTIVE` under Workspace/current Agreement authority.

### 7.1 Invitation acceptance

Preflight requires a real authenticated session, verified email, pending and
unexpired invitation, expected organization/email/role, and absent membership.

```text
TX A
  lock declared authorities
  revalidate preflight and capacity
  create idempotent PENDING assignment
COMMIT

one real auth.api.acceptInvitation via the sole port

TX B
  lock declared authorities
  reread invitation, User, and membership
  CAS (id,workspace,source,state,version)
  ACTIVE, RELEASED, or NEEDS_RECONCILIATION
COMMIT
```

### 7.2 Promotion

Promotion has no invitation. It binds the real expected
`(membershipId, organizationId, userId, priorRole)` tuple and expected final
role. Only a non-consuming-to-consuming transition reserves a seat. TX B rereads
the real tuple and final role before activation.

### 7.3 Owner transfer

Owner transfer binds source and successor membership/user/organization/prior and
final roles. If the successor crosses into a consuming owner role, capacity is
reserved first. One real port call promotes the successor. Only after an
authoritative reread proves the successor is owner may a distinct second
`updateMemberRole` demote the source. The intermediate two-owner state is safe.

Ambiguity after either call is phase-specific. The same ambiguous call is never
replayed automatically. Reconciliation may advance to the next distinct phase
only from conclusive real-row evidence. Source-seat release follows the source's
final consuming/non-consuming role.

### 7.4 Access and ambiguity

Product access requiring a seat is:

```text
real consuming Better Auth membership
AND SeatAssignment ACTIVE
AND active Workspace/current Agreement entitlement
```

Response loss, timeout, accepted-without-membership, stale or mismatched rows,
or CAS divergence remains `PENDING + NEEDS_RECONCILIATION`, retains capacity,
and emits no second Better Auth call. Age or lease expiry alone never releases.

The incident is queryable in the same committed transition. The fixture scanner
must surface it within one synthetic poll interval; its wall timeout detects only
harness hangs and is not a product SLO.

Sessionless reconciliation has exactly three outcomes:

- `ACTIVE` on conclusive matching membership and reserved capacity;
- `RELEASED` only on durable proof the original Better Auth commit was
  impossible;
- otherwise remain `NEEDS_RECONCILIATION`.

## 8. Refund transition contract

Self-service refund is supported only for a `PREPAID_TOPUP` that:

- is wholly unused;
- has exactly one InvoicePayment/PaymentIntent covering the full source amount;
- has matching provider account, environment, currency, and source payment;
- has no active adverse dispute;
- has no prior logical self-service refund effect.

Multi-PI top-ups remain usable but self-service refund returns `UNSUPPORTED`
before provider POST. Network/application replay uses only the same effect and
idempotency key within the P5 replay contract; a conclusively failed/canceled
refund does not permit a second logical refund effect.

Under `UsageAccount` lock:

- `freeze_refund_topup` moves `available -> held` once and binds the effect;
- `succeeded` moves `held -> revoked` once;
- `failed|canceled` moves held units to `available` only when no dispute exists
  and `now < expiresAt`; otherwise to `expired`;
- `pending|requires_action|UNKNOWN` remains held.

Holds never alter `expiresAt`.

## 9. Dispute, debt, and compensation contract

Product policy is versioned and explicit:

```text
ANY_POSITIVE_DISPUTE_REVOKES_WHOLE_TOPUP
```

P5 must first authoritatively match provider environment/account, charge,
PaymentIntent, currency, and top-up source. No proportional currency-to-unit
allocation is claimed.

`TopupDisposition` is the single product coordinator per top-up source. Provider
dispute observations are one-to-many, unique by concrete
`(platformAccountId, eventAccountId, disputeId)`, and retain amount, currency,
charge, PaymentIntent, status, source lineage, and append-only resolution
history.

Aggregate rules under `UsageAccount` lock:

- first positive adverse/open dispute applies hold/debt once;
- any known `lost` makes debt confirmed;
- otherwise any known open/adverse dispute makes debt provisional;
- later disputes never duplicate hold, revoke, or debt;
- release/reverse only when every known dispute is conclusively non-adverse:
  `won|prevented|warning_closed`;
- a new adverse dispute may reopen the disposition once under a new aggregate
  generation.

While a dispute is active:

- new unused units remain held;
- reservation release returns to held, never available;
- reservation commit adds provisional debt before `lost`, confirmed debt after
  `lost`.

`UsageDebt` is product-unit debt, not a monetary receivable. Future grants settle
confirmed debt first and persist `DebtSettlement` rows. A final late win creates
exactly one `DEBT_REVERSAL_COMPENSATION` lot per
`(originalDebtSettlementId, winningGeneration)`, for exactly the settled units,
with lineage to the original top-up, disputes, settlement, and disposition
generation.

Compensation inherits the expiry of the future-grant lot consumed by the
settlement. If that expiry has passed, the compensating lot is created directly
expired. A non-adverse dispute resolution likewise returns held units to
available only before their immutable expiry; otherwise to expired.

## 10. Required composed controls

At minimum, the future P4 specification must cover:

- direct credit creation, amount drift, terminal rewrite, source/lineage rewrite,
  historical Agreement update, cross-Workspace pointer swap, delete/truncate,
  ACL/default-ACL expansion;
- RC last-seat, Agreement replacement/fallback, usage conservation, recovery,
  hot-key, many-key, and mixed seat/usage contention;
- two real invitations for one seat, response loss, certain Better Auth failure,
  real role promotion, owner transfer phases, zero access before ACTIVE, and no
  automatic second call;
- ambiguity exhaustion, bounded surfacing, late conclusive repair, and no
  age-based release;
- refund/dispute conflicts on one top-up;
- two distinct disputes in reverse order, one won while another remains open or
  lost, then final late win;
- a partially consumed and reserved top-up through:

```text
D1 open
-> reservation commit and release branches
-> D1 lost
-> partial DebtSettlement from a future grant
-> D1 late win
-> compensation lot
-> D2 open in a new generation
-> D2 lost or non-adverse closure
```

Every duplicate and out-of-order observation must preserve conservation and
prevent double hold, revoke, debt, settlement, or compensation.

## 11. Evidence and non-claims

All refund/dispute/debt/compensation/expiry writer and conservation mutants map
to existing `A16.N01/A16.P01`. The Better Auth behavioral paths map to
`C05.N01/C05.P01`; ambiguity to `Q01.N01/Q01.P01`; contention to
`Q02.N01/Q02.P01`. No new claim or command ID is introduced.

P4 records PostgreSQL version, `READ COMMITTED`, `fsync`, `synchronous_commit`,
PgBouncer mode, role/ACL/RLS/catalog state, lock/query-plan observations, input
digests, and the local durability boundary. It claims neither replication/HA,
provider semantics, general pool health, unknown transaction cleanup, nor P6/P7
behavior.
