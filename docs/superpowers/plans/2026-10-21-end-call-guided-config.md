# Sparra end-call correction and guided configuration Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task-by-task.

**Goal:** Fix the known final-audio acknowledgement failure, qualify it through the user's requested specialist reviews, then implement approved Lot 2 on the existing product.

**Architecture:** Existing App + Voice, native auth/workspace/RLS, immutable configuration revisions and one activity draft. Guided presentation adds no workflow engine or runtime authority. Calendar retains its draft and separate explicit save.

**Tech Stack:** Existing pinned TanStack Start, Effect, Better Auth, Drizzle/PostgreSQL, Astryx and Python/Pipecat.

**Spec:** C:/Users/louis/.codex/artifacts/sparra-strategy/2026-10-21/docs/superpowers/specs/2026-10-21-sparra-multi-secteurs-design.md . Approved Lot 2 details in sibling plans/2026-10-21-sparra-multi-secteurs.md at that artifact root. User explicitly authorized this ordered execution and several specialist subagents.

## Global Constraints

- Reuse owned worktrees. App BASE73cf9b17d62ee0e7eec16d99b581cbb28f8df85c; Voice BASE3453abb460a5d70dfc6027ba47146460c9ecda5f. Preserve completed Lot 1 and other checkouts.
- No .env reads, live provider calls, push, deployment, existing-service migration, package/pin/budget/recording-policy changes, CRM or domain work.
- Preserve expectedRevision, raw text, uncertain-save reconciliation, zero automatic retry POST, call snapshot pin, caller scope/tool authority, retention and erasure.
- Name80, hours1000, services2000, prices1500, FAQ3000, instructions2000; existing Unicode and aggregate Voice bounds stay binding.
- Default offline tests; native heavy checks sequential with existing memory/inventory/cleanup guards. Report source, native, cleanup and provider boundaries separately.

## Review Focus

1. Native farewell must send exactly one final goodbye and wait for its authenticated exact playback ACK; old/wrong ACKs and cancellation never terminate another attempt.
2. Quoted, negated, stale or injected caller text must not acquire call-control authority.
3. Changing guided section or sector preserves all draft text/settings, and helper actions do not save or activate tools.
4. Unknown save outcome/conflict preserves draft and requires protected read, with no second automatic POST.
5. Activity and Calendar outcomes remain independent, including success/error/uncertainty combinations; saved configuration never implies active phone line.

### Task 1: Correct native final playback and review the boundary

**Files:** Inspect Voice action_authority.py, pipeline.py, session.py, end_call.py and installed pinned Pipecat implementation; change only the load-bearing source discovered by tracing. Extend affected tests/unit and tests/integration/test_call_session.py; record precise paths and cause.

**Interfaces:** Keep existing caller action, attempt/context binding, serializer/audio ACK and termination APIs unless a proven root cause requires a narrow internal adjustment. No broader farewell regex or timeout increase without evidence and authority-negative tests.

- [x] Reproduce exact failing parameter `test_native_end_call_waits_for_final_audio_ack_then_finishes_normally[J'ai dit au revoir.-False]` offline; identify first failed boundary and compare working variants.
- [x] Trace actual pinned source and record causal hypothesis before production changes. Add a minimal regression RED for the root cause.
- [x] Implement smallest supported fix; preserve old-context, wrong ACK, interruption, concurrency and exact caller-scope protections.
- [x] GREEN root regression and farewell cohort; run affected contract/pipeline/session tests, Ruff, mypy and frozen lock verification. Do not hide warnings/failures or change timing to get green.
- [x] Freeze scoped commit and report command/output evidence.
- [x] Root dispatches distinct clean-code, framework/best-practice and architecture reviewers as explicitly requested by user; one implementer handles consolidated fixes. Gate must be clear before Task 2 code.

### Task 2: Implement approved Lot 2 guided editor

**Files:** src/ui/sparra/activity-panel.tsx, new activity-knowledge-helpers.tsx, sparra.css, src/modules/sparra/messages.ts; route composition and calendar-panel.tsx only if necessary for truthful independent summary. Existing unit/UI/native tests plus new helpers tests.

**Interfaces:** Keep getActivity/saveActivity, onSave/onRead and Calendar handlers. ActivityFaqHelper({locale,faq,questions,disabled,onChange(nextFaq)}) and ActivityIntakeHelper({locale,instructions,questions,disabled,onChange(nextInstructions)}) mutate only existing draft. No duplicate draft/controller or generic onboarding framework.

- [x] RED helpers: no blank FAQ answer insertion, preserve free text, respect3000/2000 bounds, explicit intake choice only, no network action. Sector switch preserves text/settings.
- [x] Keep single activity owner/state/error classification. Present four navigable sections: establishment, knowledge, handling/tools, recap/test. Navigation does not save. Retain explicit enterprise save and independent Calendar card/save; summary reports actual separate outcomes.
- [x] Explain local draft versus saved revision versus unqualified phone line; no invented live/demo action. Helpers append to respective FAQ/instructions only upon explicit choice.
- [x] Preserve cancellation/conflict/uncertain-result reconciliation and protected read; focus/navigate to invalid field on submit. Ensure hidden/inactive sections do not cause lost text or inaccessible validation.
- [x] Extend existing native browser flow for preexisting garage: edit one field, navigate, save/reload, verify unchanged knowledge/transfer/audio; use existing App/Voice consumer for resulting snapshot/Inbox. Exercise enterprise success/Calendar failed-or-uncertain and inverse, preserving drafts and separate outcomes.
- [x] Verify FR/EN, keyboard, labels, announced errors and responsive320px screenshot through existing browser harness. Run focused source tests, normative typecheck, lint, build, native browser and necessary bridge qualification against explicit corrected Voice candidate.
- [x] Independent spec/quality and user-requested specialist review, fix consolidated findings, bounded commits, QA receipt with exact pair and limits. No automatic next lot or deployment.

## Supported Commands

Use `pnpm exec vitest run <focused files> --maxWorkers=1` for App source (pnpm test invokes unrelated full coverage machinery). Native uses `--config vitest.integration.config.ts`, explicit SPARRA_VOICE_TEST_ROOT and owned SPARRA_VOICE_TEST_HOME. Keep official published fixture provenance unchanged; it does not prove this local candidate.

Voice uses its owned `.venv` Python3.13.15 / `uv run --offline pytest`, existing locks, `ruff check .`, `mypy src`. Baseline evidence from Lot 1 is preserved in C:/Users/louis/.codex/artifacts/sparra-strategy/2026-10-21/lot1-execution/.

## Execution receipt

Requested product scope completed locally. See `docs/qa/2026-10-21-guided-configuration.md` for exact source pair, passed scoped gates and the two separately unqualified historical consumers. This is not a global App-native/CI or deployed-readiness receipt. Complete plan records are preserved at `C:/Users/louis/.codex/artifacts/sparra-strategy/2026-10-21/end-call-guided-execution/sdd-app-record/`.