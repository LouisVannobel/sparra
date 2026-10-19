# Commercial offer operator entry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development; one implementation task and independent review. Execute after the continuous phone source lot; the user's mandate removes approval pauses.

**Goal:** Assign a real commercial agreement to the existing native Stripe Checkout without a fixed public price.

**Architecture:** One bounded operator CLI verifies the existing Stripe monthly Price, then appends immutable terms under the existing Workspace lock and trigger. The web and worker retain their current read-only terms authority.

**Tech Stack:** Existing Node24.14.0, pnpm10.32.1, TypeScript7, Stripe23, Effect4 and pg8.23.1; no dependency changes.

**Spec:** `docs/superpowers/specs/2026-10-19-commercial-offer-operator-design.md`.

## Global Constraints

- No public fixed price; only actual commercial EUR amount in integer cents and an actual existing Stripe Price.
- Keep existing auth, native Checkout/operation identity, immutability, RLS, database roles, provider transport ownership and sandbox/live separation.
- One operator CLI only; no migration, runtime grants, sales UI/role, automatic Price/Customer/payment, new billing engine or dependency.
- Never read live .env, use real provider records as fixtures, log secrets/raw errors or pass credentials in argv. Use offline transport doubles and native disposable PostgreSQL.
- Sole qualification owner; retain existing2GiB physical/6GiB virtual resource floors. Preserve unrelated services and work.

## Review Focus

- Retry after successful or uncertain commit must not append a second revision.
- Two concurrent different offers at the same expected revision cannot both win.
- Operator input cannot route Stripe credentials to another account/origin or mix sandbox/live.
- Existing native Checkout and runtime/worker inability to write terms remain unchanged.
- Provider reads happen before the Workspace lock; every failure closes owned resources and exposes constant-safe diagnostics.

### Task 1: Bounded commercial assignment CLI and native qualification

**Files:** Create `scripts/assign-billing-terms.ts`, `tests/billing/commercial-offer.test.ts`, `tests/integration/billing-commercial-offer.test.ts` and concise usage `docs/billing-operator.md`; add a small shared monthly Price predicate under `src/modules/billing/` and consume it in `checkout.server.ts`. Narrowly adapt existing Stripe transport/config types if required by a real read-only consumer; include the new script in lint.

**Interfaces:** An import-safe one-shot command accepting `--workspace`, `--environment`, `--account`, `--monthly-price`, `--monthly-amount-cents`, `--expected-revision`; reject unknown/duplicate/missing arguments. Consume existing migration database config and protected Stripe key/account/environment; never require a Customer or invoke Checkout. Return only scoped nonsecret assignment ID/revision/status; throw constant-safe refusals or explicit unknown-commit outcome. Expose testable named parser/assignment functions without adding a service framework.

- [ ] Write and observe RED for strict parser/amount bounds and real disposable-SQL first assignment, exact retry, stale conflict and concurrent competing assignments. External Stripe calls alone may be doubled.
- [ ] Implement bounded own-account/Price GET and shared existing Checkout-equivalent monthly validation. Prove wrong account/mode, archived/wrong amount/currency and unsupported recurring shapes cause zero terms writes; no Stripe POST is issued.
- [ ] Implement active-personal-Workspace lock, expected revision check, append-only insertion and exact retry observation using the native trigger. Test missing/deleting/foreign scope, same revision race, immutable rows and runtime/relay/worker write refusal. Keep provider reads outside the transaction and prove existing Checkout observes its Workspace's assigned terms.
- [ ] Prove cleanup, safe errors and explicit unknown COMMIT with no automatic mutation replay; identical later observation does not duplicate. Preserve prior negotiated Checkout and cancellation tests.
- [ ] Run focused unit/integration tests, normative typecheck/lint and required native consumer checks once with existing resource guards. Self-review, commit scoped changes and write report for independent review. Do not call live providers, deploy or push.

### Task 2: Qualified operator delivery (Root)

- [ ] Independent review, existing exact-SHA hosted checks, merge/release only as required by the actual operator artifact packaging. Preserve owned web/worker deployments unless the qualified shared predicate changes require their normal release.
- [ ] Document actual command/secret access for the owned host without persisting credentials. Do not execute an assignment without a real client, agreed amount and matching actual Price; no fake payment acceptance. Keep phone availability as the release priority.
