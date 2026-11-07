# Residual dependency security implementation plan

> For agentic workers: use superpowers:subagent-driven-development for task-scoped implementation and independent review. Keep the current pilot and its data unchanged during qualification.

**Goal:** Remove the two remaining esbuild/minimatch advisories from the full and production dependency audits, then release and deploy the qualified web image.

**Architecture:** Preserve the existing direct application pins and lifecycle patches. Stable parents do not yet carry the fixes. Use exact, parent-scoped resolutions after qualifying the actual APIs consumed by those parents; preserve every unrelated lock resolution.

**Tech stack:** Node 24.22.2, pnpm 10.32.1, Drizzle Kit 0.31.10, ESLint 10.11.0, config-array 0.23.5 and the existing immutable release/Dokploy flow.

**Spec:** The user's explicit request in this chat to correct both remaining moderate alerts and deploy. Existing AGENTS.md pilot mandate permits autonomous qualification and delivery without repeated confirmation.

## Constraints

- Keep existing `zod@4.6.1: 4.6.6`, all direct dependency versions, both patch files/hashes, business code and migration tree.
- New exact selectors: `@esbuild-kit/core-utils@3.3.2>esbuild: 0.25.12`, `eslint@10.11.0>minimatch: 11.0.5`, `@eslint/config-array@0.23.5>minimatch: 11.0.5`.
- These are deliberate out-of-range resolutions, not claims that upstream parents support those ranges. Inspect exact parent source and prove native contracts before integration; document accepted upstream semantic corrections and removal criteria.
- Tests use owned temporary directories, filtered child environments and explicit empty dotenv files. Never load an existing .env or connect to a database/provider.
- Preserve the currently exited worker and all unrelated services. Deploy web only after complete PR/main/release/image qualification; no migration or financial/provider action.

## Review focus

- Both minimatch parent paths must resolve the fix; ESLint-only substitution is insufficient.
- ESLint/config-array file selection, dot files, ignores, braces, extglobs and partial directory pruning must remain correct on normalized relative paths and Windows-style input.
- Doctor uses Oxlint: its successful run alone cannot qualify minimatch.
- Drizzle Kit bundles tsx: successful generation alone cannot qualify the archived esm-loader/core-utils path.
- The production Docker dependency-pruning paths must agree with the final graph and retain the release/image gates.

## Task 1 — regression and compatibility qualification

Files: `tests/runtime/dependency-security-contracts.test.ts`, a focused helper under `tests/helpers/` only if needed, and the existing lint entrypoint if new JavaScript needs explicit inclusion.

- [x] Resolve the vulnerable libraries from their actual parent packages, not a convenient unrelated root copy.
- [x] Observe RED: owned loopback esbuild server returns wildcard ACAO to a foreign Origin; bounded minimatch level-2 preprocessing exceeds a small expansion cap.
- [x] Preserve meaningful native tests: core-utils transform/transformSync (names, imports and source maps); actual esm-loader static and dynamic `.mts` enum imports; actual ESLint/config-array selection and ignore contracts.
- [x] Generate SQL from the actual six repository schemas using a temporary config/out directory, absolute forward-slash schema paths and an explicitly empty dotenv input; replay leaves generated SQL/snapshot/journal bytes unchanged. Repository output was not written.

## Task 2 — minimal dependency repair and review

Files: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `Dockerfile` only if obsolete package paths need correction, and `docs/qa/2026-11-07-residual-dependency-security.md`.

- [x] Add the three scoped exact selectors, retain native unrelated resolutions and preserve all original patches.
- [x] Frozen install under Node 24.22.2; full and production audits report zero advisories.
- [x] Observe GREEN for all eight regression/native consumer contracts; normative typecheck, lint, build and the existing Doctor canary pass.
- [x] Record source/version evidence, native consumers, accepted differences and override removal criteria. Independent source review approved the final tests and graph; Oracle's conditional design advice was addressed by stronger CORS controls, bounded valid minimatch controls and exact Drizzle replay file digests.

## Task 3 — immutable release and narrow live delivery

- [ ] Publish PR, pass full native CI, merge the identical qualified tree, and require complete main CI plus all immutable-release gates.
- [ ] Authenticate and verify the final web artifact and immutable image identity before preloading.
- [ ] Reuse the reviewed single-dispatch web-only flow with a new case and fresh source/runtime/manager bindings. The current renderer adds known inventory labels: validate exact management associations before normalizing only those fields for the core model comparison.
- [ ] Confirm new web image/source, healthy Node 24.22.2, HTTP availability, unchanged foreign containers/worker state/Redis, environment bytes and mounts; retain rollback evidence and issue a concrete final receipt.
