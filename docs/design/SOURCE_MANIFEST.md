# projetV0 SaaS boilerplate — source manifest

Status: consolidation source map, 2026-08-25.

Application amendment adopted 2026-09-10: the user's renewed objective grants
authorizations and their subsequent "Vasy" adopts
`../superpowers/specs/2026-09-10-auth-preparation.md` §§3–4. The application copy
of BOILERPLATE_DESIGN.md now incorporates the named replacements in§§6.3,8.5,9.1,9.2.
Original section/probe sources below remain historical evidence; statements
about the infrastructure checkout describe their original context, not this
separate application repository. No historical probe is requalified by this
amendment and no external/local source path is a runtime dependency.

This file identifies the decisions that were explicitly approved during the
section-by-section design. It is not an implementation claim.

## Precedence

1. The consolidated design after its final Oracle, specialist, and user review.
2. Later frozen amendments for a section override earlier drafts of that same
   section.
3. Version-pinned probe evidence constrains claims but does not broaden the
   normative design.
4. Reviewer feedback is advisory unless the later frozen section incorporates
   it.

## Objective and authoritative rollout

- User objective:
  `C:\Users\louis\.codex\attachments\f5bf046a-36db-4234-9db8-0e5681688c94\goal-objective.md`
- Full design rollout:
  `C:\Users\louis\.codex\sessions\2026\08\24\rollout-2026-08-24T19-17-48-01a034c7-40dc-7911-9ddc-d68c165d1c41.jsonl`
- The current repository is the infrastructure repository and is not the target
  application repository. It remains out of scope for this application design.

## Frozen section sources

### Section 1 — product and identity topology

- Approved option A: per-SaaS users, workspaces, sessions, entitlements,
  enterprise SSO, database, and Better Auth runtime; shared code only.
- Rollout message:
  `msg_0d99ffab8ecedd49016a8c8415e43887d28d6304aca9bbd906`

### Section 2 — authority, tenancy, and Better Auth Organization boundary

- Core lifecycle and tenancy model:
  `msg_0d99ffab8ecedd49016a8c9b58e48087d2933f20f552c40f97`
- Acceptance scenarios:
  `msg_0d99ffab8ecedd49016a8c9b7d35f087d28fc11672c2b6f720`
- Durable intents, transaction authorization, and Better Auth port:
  `msg_0d99ffab8ecedd49016a8ca0b22d0487d283d643fde74ed603`
- HTTP prefix boundary:
  `msg_0d99ffab8ecedd49016a8ca10a6f6887d2885e1ce3aa2a35e4`
- SSO prefix/source compatibility:
  `msg_0d99ffab8ecedd49016a8ca147fdd887d2ae0113efa0e8716e`
- Base-path, route normalization, roles, and SSO activation details:
  `msg_0d99ffab8ecedd49016a8ca49e927c87d2a780c6c91d6fe0ae`
- Final owner invariant and invitation-role restriction:
  `msg_0d99ffab8ecedd49016a8ca65f824087d2a8e55fdc48767daa`

### Section 3 — authentication, MFA, sessions, and recovery

- Full authentication and recovery contract:
  `msg_0d99ffab8ecedd49016a8caa9feec487d28b2aa3f6c103b206`
- Better Auth session-issuance seam:
  `msg_0d99ffab8ecedd49016a8cab1d4a0c87d28ff021e26138675b`
- Approved ultimate recovery option A: total factor loss is irrecoverable and
  support has no bypass:
  `msg_0d99ffab8ecedd49016a8cab3f4f4c87d286807568ef8113bf`

### Section 4 — catalog, billing, seats, usage, and Stripe

- Core billing and typed-pool model:
  `msg_0d99ffab8ecedd49016a8cb065b1e087d2a80cb7a06e401dfa`
- Three-phase seat acceptance and reconciliation:
  `msg_0d99ffab8ecedd49016a8cb454589c87d296e9d9023ee6ff86`
- Final no-reset rule and global lock order:
  `msg_0d99ffab8ecedd49016a8cb5e62d2487d2981c9a1c9a105652`
- Final verified-email preflight and sessionless reconciler:
  `msg_0d99ffab8ecedd49016a8cb885fb5487d290fac6fe59c32939`

### Section 5 — application execution architecture

- Initial approved architecture and spike contract:
  `msg_0d99ffab8ecedd49016a8cbd5ca2e087d2ba5a218aa6bd0344`
- Final architecture after the disposable transaction, RLS, bundle, OTel,
  Storybook, and TypeScript 7 probes:
  `msg_0d99ffab8ecedd49016a8d4d35fc9c87d280a420edc8e94e9c`

### Section 6 — asynchronous effects, rate limiting, and files

- Probe-backed section and activation gates:
  `msg_0d99ffab8ecedd49016a8d79a3988887d2ba460d35dcc847ae`
- Later Oracle-first consolidated replacement, which controls on conflict:
  `msg_0d99ffab8ecedd49016a8d9109f6e887d2a67d77e86b6d2ec0`
  Portable extraction:
  `reviews/oracle/SECTION_6_FINAL_REPLACEMENT.md`
- Oracle re-audit transcript:
  `C:\Users\louis\.oracle\sessions\projetv0-section6-gpt56-sol-adversaria\artifacts\transcript.md`
- Oracle deep-research report:
  `C:\Users\louis\.oracle\sessions\projetv0-section6-gpt56-sol-adversaria\artifacts\deep-research-report.md`

The later Section 6 replacement supersedes conflicting earlier wording,
including the worker transaction boundary, universal outbox fields, Redis
window semantics, and the FileAsset bucket topology.

That replacement explicitly selects a two-field Redis tuple and two buckets.
The newer post-subagent Oracle amendment supersedes only the Redis tuple with
the strict three-field protocol now in `BOILERPLATE_DESIGN.md §9.4`. The
accepted two-bucket FileAsset topology remains authoritative; the final
post-subagent audit adds only the missing presigned-PUT cleanup horizon.

### Section 7 — cross-cutting application contracts

- Frozen final contract:
  `C:\Users\louis\.codex\spikes\projetv0-section7-20260825\FINAL_CONTRACT.md`
- Final Oracle GPT-5.6 Sol/Pro transcript:
  `C:\Users\louis\.oracle\sessions\projetv0-section7-bundled-final\artifacts\transcript.md`
- Oracle conversation:
  `https://chatgpt.com/c/6a8de656-3ef8-83eb-9b87-b026a02238ee`
- Version-pinned probe evidence:
  `C:\Users\louis\.codex\spikes\projetv0-section7-20260825`

## Evidence boundary

- Sections 5–7 contain disposable or in-memory compatibility evidence. This
  proves only the exact pinned fixtures and stated behavior.
- Production integration, activation, deployment, capacity, security posture,
  and operational readiness remain unproved until their named gates execute.
- No historical test count, reviewer approval, or green status replaces a fresh
  implementation verification later.

## Consolidated spec review evidence

- Oracle Review 1 — topology:
  `reviews/oracle/SECTION_1_ORACLE.md`
  (`https://chatgpt.com/c/6a8df162-a758-83eb-b68f-d4d512d94af1`)
- Oracle Review 2 — Workspace/RLS:
  `reviews/oracle/SECTION_2_ORACLE.md`
  (`https://chatgpt.com/c/6a8df06e-eae8-83ed-a1a7-e52ea23094d0`)
- Oracle Review 3 — auth/MFA/recovery:
  `reviews/oracle/SECTION_3_ORACLE.md`
  (`https://chatgpt.com/c/6a8df16a-46ec-83ed-87c6-3aaa1cc4784f`)
- Oracle Review 4 — billing/Stripe:
  `reviews/oracle/SECTION_4_ORACLE.md`
  (`https://chatgpt.com/c/6a8df08c-bf30-83eb-8f3c-bb1207cb4ac3`)
- Oracle Review 5 — execution:
  `reviews/oracle/SECTION_5_ORACLE.md`
  (`https://chatgpt.com/c/6a8def70-8dbc-83eb-8f02-4ca8a38278da`)
- Applied Oracle decisions:
  `reviews/oracle/CONSOLIDATION.md`
- Specialist convergence after identity/security, billing/execution and
  product/quality reviews:
  `reviews/SPECIALIST_CONVERGENCE.md`
- Post-subagent Oracle convergence audit (two P1, now amended):
  `reviews/oracle/POST_SUBAGENT_ORACLE.md`
  (`https://chatgpt.com/c/6a8e092e-9cf0-83ed-b911-01782cd3cac8`)
- Targeted post-subagent closure Oracle — both P1 closed, convergence validated:
  `reviews/oracle/POST_SUBAGENT_CLOSURE_ORACLE.md`
  (`https://chatgpt.com/c/6a8e0cdb-e16c-83eb-84e6-9ec6b708f075`)

## Blocking-probe protocol review — 2026-08-26

User approval to execute §12.2 was obtained. Before implementation, the probe
protocol was attacked by three independent GPT-5.6 Sol/Pro Deep Research
Oracles, checked by three specialist reviewers, and locally arbitrated. The
result preserves the nine-probe architecture but adds executable evidence
provenance, a real vertical seam, exact identity/transaction/provider/ingress
negative controls and explicit evidence boundaries.

- Amended execution plan:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\docs\superpowers\plans\2026-08-26-blocking-probes.md`
- Oracle A — identity/security/full-plan:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\oracle\PLAN-IDENTITY-SECURITY.md`
  (`https://chatgpt.com/c/6a8ef46c-19a4-83eb-93d1-39a345d7bf9c`)
- Oracle B — commercial/resilience/full-plan, recovered from completed nested
  Deep Research report:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\oracle\PLAN-COMMERCIAL-RESILIENCE.md`
  (`https://chatgpt.com/c/6a8ef4d5-cef8-83eb-aa36-7006cf77170a`)
- Oracle C — execution/quality/full-plan, recovered from completed nested Deep
  Research report:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\oracle\PLAN-EXECUTION-QUALITY.md`
  (`https://chatgpt.com/c/6a8ef51b-c09c-83eb-a560-b968935f6403`)
- Specialist addenda:
  `reviews\specialists\IDENTITY-TENANCY.md`,
  `reviews\specialists\COMMERCIAL-OUTCOMES.md`,
  `reviews\specialists\EXECUTION-TOOLCHAIN.md`
- Controlling arbitration:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\ARBITRATION.md`
- Independently frozen normative claims catalog:
  `C:\Users\louis\.codex\designs\projetv0-saas-boilerplate\PROTOCOL_CLAIMS.v1.json`
- Oracle closure round 1 — six remaining P1, amended again:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\oracle\FINAL-PROTOCOL-CLOSURE.md`
  (`https://chatgpt.com/c/6a8f005b-8c84-83eb-b7e9-d97a0006792e`)
- Oracle closure round 2 — C02–C06 closed; single C07 session-lifecycle catalog
  omission found and amended:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\oracle\FINAL-PROTOCOL-CLOSURE-ROUND2.md`
  (`https://chatgpt.com/c/6a8f0ace-ec14-83eb-93eb-b0127348eef1`)
- Oracle closure round 3 — C07 and the complete protocol closed:
  `C:\Users\louis\.codex\spikes\projetv0-blocking-probes-20260826\reviews\oracle\FINAL-PROTOCOL-CLOSURE-ROUND3.md`
  (`https://chatgpt.com/c/6a8f0e23-2170-83eb-af18-054b7127b3ef`)
  Verdict: `AMENDED PROTOCOL VALID — READY TO IMPLEMENT PROBES`.

These amendments are not executed proof. A fresh Oracle closure of the amended
protocol remains mandatory before implementation, followed by specialist review
and final Oracle convergence over the actual probe results.
