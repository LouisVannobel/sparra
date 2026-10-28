# Google Agenda privacy remediation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Make the existing public privacy page clearly disclose the five Google-review categories in both supported languages, using only established processing facts.

**Architecture:** Existing TanStack route and locale handling; static factual copy, existing styles and contact/Google links. No new runtime mechanism.

**Tech Stack:** Pinned React, TanStack Start/Router, TypeScript, Vitest and the existing compiled public HTTP fixture.

**Spec:** `docs/superpowers/specs/2026-10-29-google-privacy-remediation-design.md`.

## Global constraints

- Node 24.22.1, pnpm 10.32.1, frozen lockfile; no dependency changes.
- Public privacy copy/localization only; no schema, private auth/tenant, Calendar, Voice, worker, financial or infrastructure changes.
- No live provider request, new session, call, event, deletion or production operation by the implementer.
- Separate source, CI, publication and Google acceptance. The human opted out of further approval gates for necessary Sparra work.

## Review focus

1. A non-authenticated reviewer gets complete public HTML, not a login redirect or client-only text.
2. `lang=en` produces English copy/title and appropriate document language; default French remains correct.
3. All five Google categories are readable with the registered policy and contact links preserved.
4. Copy distinguishes call retention, settled/revoking/disconnected connection states, uncertain operations and independent Google event retention.
5. No universal encryption/ZDR/training/deletion or Google-approval claim is introduced.

### Task 1: Clarify and localize the existing privacy page

**Files:** Modify `src/routes/confidentialite.tsx`, optionally one dedicated copy module under `src/ui/marketing/` if readability requires it, and the existing privacy case in `tests/marketing/public-http.test.ts`. A narrowly necessary existing document-language integration may be changed only if the compiled English response proves it necessary; preserve all existing landing/private behaviours.

**Interfaces:** Consume inherited `lang` and current route/style patterns. Produce the same public `/confidentialite` route, with default French and `?lang=en`; do not add endpoints or configuration.

- [ ] Inspect the spec and native locale patterns. Keep all source outside this task's files unchanged.
- [ ] Extend the existing compiled public privacy HTTP case for both locales and the five readable categories, preserved links and independent event-retention disclosure. Run the focused case against baseline build to observe the missing English/disclosure behaviour. Do not add generic matrices or copy-mirroring unit suites.
- [ ] Implement the smallest bilingual static copy following every factual boundary in the spec, with an actual update date and the existing public styling. Do not weaken any tests or headers.
- [ ] Run the focused public HTTP case, typecheck, lint, build and the existing quality/Fallow gate as appropriate. Preserve failed results; fix causes rather than relaxing thresholds. No duplicate local full suite.
- [ ] Self-review the complete diff, retain lock/pins and unrelated source byte identity, then commit the task source and these two task documents. Report the commit, tests, limits and source-only status. Do not push or deploy from this task.

## Controller follow-through

Fresh factual/code review and scoped final branch review use this same spec; Oracle may review an important unresolved wording contract, never private transcripts or credentials. Publish only through the existing coordinated Web workflow after exact-source qualification, with no Voice/worker/schema/financial mutation. Confirm live FR/EN public HTML, then prepare the factual Google-review response using the unchanged URL. No approval of Google data access is claimed before Google returns it.
