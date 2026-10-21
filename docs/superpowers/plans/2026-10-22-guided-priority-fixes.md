# Guided editor priority fixes — implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development; one fresh implementer per task, independent task review, then whole-diff review.

**Goal:** preserve work during ordinary guided-editor transitions and make Calendar feedback describe its actual state.

**Architecture:** keep the existing panel owners, keyed identity/revision lifetimes and independent saves. Add one route-local native navigation blocker; panels expose only their local navigation facts. Calendar observations and explicit draft replacement are different actions.

**Tech Stack:** installed TanStack Router/Start, React, Astryx; unchanged package graph.

**Spec:** C:/Users/louis/.codex/artifacts/sparra/2026-10-21/fonixia-review/SYNTHESIS.md, sections “Deux priorités avant acceptation du lot guidé”. User authorizes these fixes, tests, subagents and coordination; no further deployment is requested.

## Global constraints

- Worktree C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-guided-priority-fixes, branch z/sparra-guided-priority-fixes, base 5c874dd. Preserve the other chat's checkout and its active legacy-budget fixture work.
- Preserve Workspace/revision/language panel keys and native auth-refusal navigation. No auth, tenant, server, schema, Voice, provider, worker, dependency or infrastructure changes.
- No autosave, browser persistence, global store, dynamic registration system or new wizard/framework. Retain Astryx, four sections, free-form knowledge and explicit additions/saves.
- No automatic POST from a read, language change, section change or draft replacement. A known save and an explicit adoption may reset a draft; a refresh may not silently discard it.
- Keep enterprise and Calendar saves independent. Existing cancellation, exclusion, stale-response and reconciliation controls remain.
- Exclude recap expansion, new demo/scenario, FAQ accessibility polish unrelated to preserving prepared responses, notifications and new integrations.
- Tests use existing controlled transports/components and disposable fixtures only, never existing .env or real providers. Do not overlap shared Docker/inventory cohorts with the other chat. Frontend browser fixtures do not require Docker.

## Review focus

- Prepared answers for an earlier question/sector, including hidden responses, still count as work.
- Pristine new forms and values edited then restored do not create false dirty guards.
- OAuth is guarded before disconnect/begin, not merely before unload; consent latency cannot admit new unprotected enterprise edits.
- Auth refusal bypasses the blocker only at its explicit recovery call; no blanket /login exemption or permanent navigation bypass.
- Save ambiguity, divergent latest reads and non-null retained account email cannot fabricate saved/connected state.

### Task 1: Calendar draft ownership and truthful state

**Files owned:** src/ui/sparra/calendar-panel.tsx, calendar-messages.ts, tests/ui/calendar-panel.test.tsx, tests/helpers/calendar-panel-entry.tsx, tests/integration/calendar-panel-browser.test.ts. A small directly consumed Calendar helper file is allowed only if it makes the existing owner readable; no generic state framework.

**Interfaces produced:** optional `onNavigationStateChange?: (state: CalendarNavigationState) => void`, `onBeforeConnect?: () => boolean`, `onNavigate?: (url: string) => void | Promise<void>` on CalendarPanel. Export `CalendarNavigationState = {dirty:boolean;pending:boolean;reconcile:boolean;connecting:boolean}`. `connecting` derives from pending action connect, not an independent truth. Call onBeforeConnect after busy/hydrated checks but before every connect-chain side effect. Await onNavigate; retain the standalone fallback.

- [ ] Write meaningful regression cases and observe RED: divergent refresh retains all draft fields and expected revision; failed/ambiguous save followed by read does not erase work; explicit replacement adopts latest; editing calendar/enable/policy invalidates old success; reconnect/revoking with retained email is not called connected.
- [ ] Implement the minimum: separate observation and explicit replacement; local dirty/pending/reconcile facts; successful save resets known state; no write retry or implicit adoption. Preserve pending abort behavior.
- [ ] Add/test the optional navigation contract. guard=false means zero disconnect/begin/navigation. Accepted reconnect retains ordering; an aborted chain does not navigate or publish late feedback. Stable callbacks/primitive effect dependencies avoid loops.
- [ ] Run Calendar unit and existing component-browser consumers, FR/EN where relevant. Use Vite fixture envDir:false and locally controlled callbacks; no Google/Docker.
- [ ] Commit only this task's owned files and write its implementation report. Independent review before Task 2 integration.

### Task 2: Guard enterprise, prepared FAQ and Calendar transitions

**Files owned:** src/routes/app.entreprise.tsx; src/ui/sparra/activity-panel.tsx, activity-knowledge-helpers.tsx and messages; one small route-consumed navigation hook/component if needed; new focused UI/browser fixture/test files. Append bounded native route regressions to tests/integration/sparra-browser.test.ts so the existing CI consumer also covers the actual Business wiring; do not change its established fixture or old assertions. Do not edit root Shell/auth or Task 1 files without a concrete integration reason recorded in the report.

**Interfaces consumed:** Task 1's optional Calendar callbacks and `CalendarNavigationState`. ActivityPanel emits `{dirty,pending,reconcile}` through an optional stable callback and accepts an optional `externalNavigationPending` flag. FAQ helper reports whether ANY prepared response contains work, without exposing answers or auto-adding them. No second owner of persisted data.

- [ ] Write RED regression scenarios using real Router and actual panel components: FR→EN decline retains values/URL and prepared answers; accepted departure abandons explicitly; Calendar-only work is protected; section changes do not prompt; pristine/restored/saved-known forms do not prompt. Do not claim hooks from SSR assertions.
- [ ] Install one native `useBlocker` at Business/its directly consumed hook, with beforeunload support and translated explicit abandonment copy. A departure warning must not say that leaving cancels an already sent write.
- [ ] Preserve keys. Report all prepared FAQ work, including answers not currently selected. Aggregate the two named panel states with stable callbacks and no render-time ref mutation.
- [ ] Check onBeforeConnect BEFORE any disconnect/begin. Refuse OAuth during enterprise/Calendar pending or reconcile, with an explanation. Otherwise explicit confirmation covers work in either panel. During approved OAuth preparation disable enterprise edit/submit via connecting; ordinary Calendar read/save must not serialize enterprise saves.
- [ ] Only the approved final OAuth navigation uses native `router.navigate({href, reloadDocument:true, ignoreBlocker:true})`; auth onRefused explicitly uses ignoreBlocker. No global bypass. Failed preparation retains drafts and normal guarding.
- [ ] Browser tests cover prepared answer in an old sector, immediate edit→language, dirty state then successful save, Calendar read/replace, pending/uncertain OAuth refusal, held OAuth disabling new edits, rejected OAuth restoring editor, and explicit auth-refusal recovery. Callbacks are test-only; zero real provider effects.
- [ ] Add native compiled Business regression(s) for declined/accepted language departure with enterprise/prepared FAQ work, using the existing test's native identity/store helpers. Parent runs these and the existing targeted auth-refusal case only after a coordinated disposable-store window; component-browser RED/GREEN can run first without Docker. Do not modernize old fixtures or replay unrelated cases.
- [ ] Commit owned files and write report. Independent task review.

### Task 3: Combined qualification and final independent review

- [ ] Run focused unit/UI and component-browser tests, typecheck, lint and web/worker build in this worktree. No shared node_modules scratch directory.
- [ ] If a compiled native smoke is necessary, coordinate a sequential resource window with the other chat before using disposable stores. Keep the old legacy fixture failures separate, not repaired or suppressed here.
- [ ] Review final diff for scope, native cancellation/auth lifetimes and both task contracts using a fresh whole-diff reviewer. Fix material findings and re-review.
- [ ] Produce a finite QA receipt, commit handoff and send the other chat exact SHA/base, changed paths and test limits. Do not cherry-pick into its checkout or publish without coordination. No deployment in this request.
