# Recovery native preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This is the next Task10B contract in the existing application schedule, not a new root, stack or execution-method decision. Status: PROPOSED FOR OWNER REVIEW; exact limits below are proposals, not an implementation ACK.

**Goal:** Turn a genuine code-plus-linked-Google exchange into one usable, attempt-isolated native PREPARED session, with bounded status/discovery and cancellation, without spending the code or changing ordinary account authority.

**Architecture:** Reuse the current private factory invocation, Google protocol, physical pg owner and Better Auth session APIs. Extend the existing recovery attempt, with separate proof, preparation and native-session deadlines. Complete Google proof and prepare within the same original callback invocation; an attempt selector or an unused proof row alone never becomes a browser bearer.

**Tech Stack:** Current pinned application graph, including Better Auth1.7.4, SimpleWebAuthn13.3.3, existing Effect/Drizzle/pg and normative TypeScript. No repin or new dependency.

**Spec:** docs/design/BOILERPLATE_DESIGN.md6.5–6.6; docs/superpowers/specs/2026-09-10-auth-preparation.md; adopted B* conditional protocol in .superpowers/sdd/2026-09-10-functional-auth/task-10b-oracle-decision.md; owner's30September server-authority decision in task-10b-namespace-next-decision.md. R1 is locally closed on4919660f; Q1–Q4 remain only their qualified finite native/browser characterizations.

## Global Constraints

- Better Auth alone owns session token/id/expiry/signing/validation/revocation. No fabricated accepted session or cast restoring filtered private fields.
- One physical pg owner, READ COMMITTED/sentinel before handle exposure, same-owner nesting, FIFO/drain/invalidation and bounded cleanup. Never hold a DB checkout over provider I/O.
- No new bearer store, factory-wide cookie mutation, alternate auth instance, private dependency import, manual signing/token reissue, generic endpoint framework or test helper imported by runtime.
- Same app root and branch; one fresh implementation agent, independent spec/quality review, controller-only Git review objects/full/native/browser/Docker/Oracle. Preserve unrelated work; no push/deployment/existing-service migration/provider credentials.
- Source tests do not qualify native/browser/provider behavior. No full recovery, activation, mail or SaaS-readiness claim from PREPARED.
- All headers withheld until known commit and full native wrapper/private invocation completion; refusal/unconfirmed publishes no cookies. Unknown finalization is not assumed rollback.

## Proposed product parameters for review

The owner has adopted server-authority readmission, NOT the values in this table. These values are a conservative starting proposal with a visible availability cost.

| Parameter | Proposed value | Effect |
|---|---|---|
| Concurrent PREPARED authorities per User | 2 | A third preparation refuses before consuming its proof or minting a session. |
| Successful native preparations per User | 5 in rolling24hours | Expiry/cancellation permits a concurrent slot to reopen but does not erase recent issuance history. Five lost/delayed responses can therefore delay the next preparation until the oldest issuance leaves this window. |
| Activation deadline | preparation DBtime+300seconds | Fixed, not extended by status/activity. |
| Native restricted-session deadline | preparation DBtime+1200seconds | Already covers the later finish window; activation must not require a replacement cookie. R3 must preserve this absolute ceiling. |
| Incoming recovery-cookie processing | Cookie header<=8192chars, at most16distinct canonical selectors | Refuse overflow before DB/native reads, never evict a winning cookie or scan without a bound. |
| Named per-IP command limiter | 5attempts/60seconds per existing trusted client | Same existing Redis mechanism; distinct command keys. |

Expired/revoked server authority never becomes valid because a cookie survives or arrives late. This is NOT a strict physical-cookie/header-count guarantee. The bounded discovery ceiling can make an overloaded cookie jar unavailable; no automatic broad cookie clearing is allowed. The2/5 values are product proposals, not conclusions from Q1's two-slot fixture, and no grace is inferred from its2066.7ms overrun.

## File responsibilities

- Create src/modules/auth/recovery-preparation.server.ts: strict selectors, immutable bindings, User-first preparation/status/cancel checks, fixed deadlines, recent-issuance bounds and bounded history cleanup.
- Create src/modules/auth/recovery-preparation-native.server.ts: one request-local native cookie-context clone, exact native session operations/reader, private command binding and status/cancel endpoints. Keep domain SQL out of the cookie helper.
- Modify recovery-native.server.ts only for the trusted prepare-after-proof mode and narrow native permission delegation; preserve R1 proof-only mode unchanged.
- Modify auth.server.ts/admission.server.ts/http-boundary.server.ts/rate-limit.server.ts only for exact APIs/classification/limiter keys and confinement.
- Extend schema.server.ts and generate next0013_recovery_preparation through the existing controlled generation procedure; no hand-replacement of generated metadata.
- Test tests/auth/recovery-preparation.test.ts and tests/integration/recovery-preparation.test.ts. Reuse real issuer/TLS/native-key setup, no seeded recovery batch or synthetic successful factor on the positive path.
- Amend existing cleanup in recovery.server.ts so proof-expiry cleanup only owns unprepared phases. README gains exact limits and headless/lost-response boundaries, not a new runbook.

## Review Focus

1. A public attempt ID or a retained PROVED row must not let a different invocation manufacture restricted authority; test fresh-Request/old-proof replay.
2. Expired proof cleanup must not remove a still-PREPARED session/attempt; test proof deadline crossing with preparation still active.
3. Cancellation and generation/batch changes must not erase recent issuance history or permit a quota bypass; test rolling24hour count independently of active count.
4. An ordinary ambient/cached session must not satisfy selected recovery-cookie reading; test genuine ordinary and restricted cookies together.
5. A committed but undelivered preparation must not spend the code, replay the proof or recover/reissue the raw native token from its selector; test late wrapper failure and withheld headers.

## Task10B-R2: Actual PREPARED native authority

**Interfaces produced by the existing factory:**

- completeRecoveryGooglePreparation(request: Request) -> Promise<{ phase: 'prepared'; selector: string; preparedUntil: string; expiresAt: string; headers: Headers }>
- readRecoveryPreparation(request: Request, input: unknown) -> Promise<{ attempts: readonly { selector: string; phase: 'prepared'; preparedUntil: string; expiresAt: string }[] }>
- cancelRecoveryPreparation(request: Request, input: unknown) -> Promise<{ cancelled: true; selector: string; headers: Headers }>

Status input is strict { selector?: canonicalLowercaseUUID }; cancellation requires strict { selector: canonicalLowercaseUUID }. Selectors derive from server-issued attempt IDs and never choose arbitrary cookie names. A future activation API is not introduced by this task.

**Interfaces retained:** beginRecoveryGoogleProof and completeRecoveryGoogleProof retain R1 behavior. The new completion method runs the same actual claim/exchange/proof path in a trusted factory-selected preparation mode. It uses the same canonical Google callback spelling and current protocol assurances. It does not call the exported proof-only command and then accept its returned data as authority.

### Storage and ownership

Extend recovery_attempt with nullable preparedAt, preparedUntil, nativeSessionId and nativeSessionExpiresAt; add PREPARED and CANCELLED phases only. CHECKs require all four fields together in these phases, fixed300s/1200s deadlines, and no fields on the three existing proof phases. Keep original createdAt/expiresAt and factor/generation/batch/code/nativeAccount/issuer/subject/state snapshots immutable. nativeSessionId is unique when nonnull, without a cascading FK to mutable Session. No native token stored on the attempt.

Retain issued preparation rows at least until preparedAt+24hours, including cancellations, regardless of source proof expiry. The same locked User serializes issuance and count. Query recent issued rows using userId/preparedAt/id, bounded at5; refuse at5. Their active PREPARED subset with preparedUntil>freshDBtime must have fewer than2 before issuance. CANCELLED stops authority but still counts toward recent issuance. Original proof-only attempts do not consume an issuance slot.

R1 cleanup excludes PREPARED/CANCELLED. New cleanup inspects at most25 old issued rows whose24hour retention and native expiry are both elapsed, with original proof/state absent. If a native Session still exists, require exact bound User/id/restricted method/state/generation/expiry before native deletion; unsafe rows are skipped, not repaired. Check native absence, then delete exact attempt. At most25attempts+25sessions, no proof/global native sweep, no background purge. Use the index for the actual recent-issuance/cleanup consumer.

### Steps and decisive assertions

- [ ] Write real-factory source tests first. Observe missing-command RED. Verify independent limiter keys before malformed-input/protected effects and zero checkouts/native/provider effects on denied/unavailable Redis. Test canonical selectors, overflow, unknown fields, safe fixed failures and no raw-authority output.

- [ ] In a separately classified generated SERVER_ONLY completion endpoint, reuse R1's exact original callback/private invocation and provider decoration. After the correlated exchange, lock User and reread exact current unspent code/batch/generation/native Google binding; create the exact R1 native proof, validate its returned/persisted singleton, then consume that proof through the real native API in the SAME physical transaction as preparation. Compare all six native row fields and require absence after awaited hooks. No second request may take over PROVED/EXCHANGING or use only code+selector to invoke this operation. R1 proof-only mode still leaves its proof unused.

- [ ] Apply fresh DBtime and capacity checks before proof consumption/session creation. Freeze preparation timestamp and both future deadlines. Create exactly one native session by the public internalAdapter.createSession with server-owned overrides (RECOVERY_RESTRICTED, authMethod=recovery, original current generation, fixed authenticatedAt/lastActivityAt/expiry); no caller token/id. Compare returned/persisted exact session and affected attempt transition. Leave User/full ordinary Sessions/keys/Account/current batch/code unspent and unchanged. Audit/notification belongs to later activation, not preparation.

- [ ] Use a per-call deeply owned cookie context: namespace application-recovery-v1.<canonical attemptUUID>; clone nested options/descriptors and rebuild getCookies/createCookieGetter, clear session/newSession, disable cookie cache/refresh, preserve original factory options. Use public setSessionCookie for that exact native session, fixedExpires/no arrival-relative Max-Age. Validate every emitted cookie against the selected native descriptors, including auxiliary cookies; do not silently filter unexpected headers. Constrain direct adapter and internal adapter hooks to the exact Request/operation/phase/physical lease and permitted one-shot effects.

- [ ] Implement selected status by deriving User from a read-only locator, then User-first lock and full current attempt/session/factor/generation/batch checks with fresh time after waits. Authenticate the selected cookie through getAuthoritativeSessionFromCtx on the isolated context, never getSessionCookie or an ambient result. PREPARED has no ordinary principal and cannot enroll/test/rotate/finish. Status changes no activity or deadline and publishes no cookies. For discovery, inspect at most16 canonical cookie selectors, verify each natively and return only admitted prepared candidates; no raw User/token/email/Account payload and no automatic sole-winner pointer overwritten by a delayed response.

- [ ] Implement cancel PREPARED-only under the same selected native authority. Native-delete only that exact server-read token and verify complete absence after hooks. Mark CANCELLED, retain the issuance fields, leave code unspent and all ordinary authority unchanged. A repeated authenticated cancel is not a session reissue or proof replay. Clear only this selected namespace using native cookie APIs after confirmed commit; errors/unknown outcomes publish nothing. Never cancel an activated recovery via this command.

- [ ] Observe focused source GREEN and normative compiler:
  node node_modules/vitest/vitest.mjs run --maxWorkers=1 tests/auth/recovery-preparation.test.ts tests/auth/recovery.test.ts
  node node_modules/typescript/bin/tsc --noEmit
  Immediate>=2GiBphysical/>=6GiBvirtual, cleared existing5-key environment,120s per process. Freeze exact source before ROOT migration/native ACK.

- [ ] ROOT validates0013 fresh/rerun/nonempty0012 preservation in disposable stores. Real positive path: actual signed-UV code issuer ->new correlated controlled-Google exchange ->new completion ->native PREPARED cookie ->next original-browser Request reads status ->native cancellation. Assert exact full inventories, unused code, consumed proof, one restricted native Session, unchanged ordinary Session/User/keys/Google, no additional provider POST. No real Google claim.

- [ ] ROOT runs finite native falsifiers: wrong/tampered/missing/ordinary/foreign cookie; fresh-invocation takeover; replay of proof/completion; two preparations plus capacity refusal before consume; fifth issuance/24hour boundary including cancelled/expired histories; generation/batch/code/link invalidation; observed User/Session lock-tail expiry; duplicate/mutated proof; native create/consume/delete veto and reached beforecommit failure; aftercommit/unknown publication withholding; proof-expiry cleanup preserving preparation; unsafe/native-session cleanup skip; ordinary factory settings/parallel requests unchanged. Real owner operations remain intact; any injected settlement ambiguity is labelled simulated.

- [ ] ROOT uses one actual browser cookie-jar selection on the compiled stable candidate for P1 status continuity when P2 prepare/clear/error responses arrive late; mixes ordinary cookie and immutable selectors. Test post-server-expiry refusal/readmission under the new stated policy, not physical-cookie disappearance. Preserve namespace/response-size bounds and no broad cleanup. This is targeted R2 consumer integration, not replay of the full closed Q1–Q4 matrices.

- [ ] Final focused/default source and normative compiler on the frozen candidate; only affected old native consumers replayed. Independent spec/quality review, then scoped Oracle closure. Commit/review-object handling remains ROOT-only; do not touch the user's real index. Keep all failures and owned cleanup evidence separately attributed.

## Explicit downstream boundary

Activation, durable start/finish notification obligations, generation/code-batch transitions, complete other-session revocation, new-key enrollment/test and complement retirement,24hour hold, registered-email alternative, user-facing screens and account closure remain later tasks. In particular, restart after an activated/abandoned recovery needs its own current-code-batch/generation contract; R2 must not silently loosen R1's recovering refusal or claim it solves that restart.

The first full recovery slice cannot be declared complete before those consumers and their positive/negative real-entry tests exist. B2B commerce/Stripe and derivation remain in the adopted full goal.

## Inline self-review

Scope maps to B* non-destructive PREPARED/status/cancel only. Native receipt from the original callback, not a client selector, supplies the second-proof authority. Separate deadlines and phase-owned cleanup close the known cross-task collision. Quota history survives cancellation/expiry, and limits deliberately make availability cost visible. These exact limits and this proposed plan await owner review; code execution additionally waits for the focused Oracle design check. No task implementation, dependency change or live operation was performed in writing this plan.
