# Diagnostic immobilier public page implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Prepare one honest public page at `/metiers/diagnostic-immobilier` for the accompanied diagnostic pilot, ready for the existing delivery owner to integrate.

**Architecture:** A dedicated static marketing component and a TanStack file route reuse Sparra's existing marketing CSS and Astryx Button. Exact public-route handling supplies the same French document and security conventions as the existing landing. No brand framework or private product change.

**Tech Stack:** Existing Node 24.22.1, pnpm 10.32.1 and frozen package graph; React, TanStack Start/Router, Astryx, Vitest and Playwright already pinned in the repository.

**Spec:** `C:/Users/louis/.codex/artifacts/sparra-strategy/2026-10-27/diagnostiqueurs/PILOTE_DIAGNOSTIQUEURS.md` (Texte de la future page métier), `PRODUIT_COMMUN.md`, `REVUE_ET_COORDINATION.md` and `ORACLE_REVIEW.md` alongside it, including the recorded amendments. The human chose profession-specific vitrines and a shared client application, and authorized preparation without duplicate implementation.

## Global Constraints

- Base: stable Main `45a5061ea605e79a152b952c0b477880d33f22bf`; isolated existing worktree, branch `z/sparra-diagnostic-public-oct27`. Preserve all other branches and ignored historical evidence.
- Source only: no push, deployment, infrastructure, domain/DNS, provider/Calendar write, phone call, quota/budget change, dependency/pin change or shared Docker mutation.
- Do not edit the integration owner's checkout, private modules, Voice, SQL, wizard, import, Inbox or billing. Its active delivery remains separate.
- Reuse `mailto:contact@sparra.fr`; every private entry on this page is explicitly `https://sparra.fr/app?lang=fr`.
- Exact H1: `Vos appels accueillis pendant vos diagnostics.` Primary CTA: `Préparer un pilote accompagné`. Use the kit's finalized introduction, steps and clearly illustrative example.
- Offer accompanied reception/qualification before a human quote or callback. No invented brand, price, testimonial, certification, gain, unlimited capacity, real audio, booking, notification or software integration.
- One dedicated component, existing styles and tests; no generic sector/brand engine. Oracle's central Voice rollout amendment stays outside this page.

## Review Focus

1. Marketing aliases must never inherit a relative private link or caller-selected Workspace: inspect every private CTA in SSR.
2. A missing sibling path, POST or failed response must remain non-indexable; match this public path exactly.
3. French marketing copy with `?lang=en` must still have French document language and no private language navigation; private routes retain their current behavior.
4. A mobile visitor must read the heading/CTA without horizontal overflow and reach links by keyboard, with the current security headers and styles.
5. An illustrative quote request must not be presented as a real call, booked visit, regulatory diagnosis, invented tariff or enabled notification.

### Task 1: Diagnostic public page and its public consumer checks

**Files:**
- Create `src/ui/marketing/diagnostic-landing.tsx` and `src/routes/metiers.diagnostic-immobilier.tsx`.
- Modify narrowly `src/platform/response-headers.server.ts` and `src/routes/__root.tsx` for this exact public page.
- Test in `tests/ui/diagnostic-landing.test.tsx`, `tests/platform/response-headers.test.ts`, `tests/marketing/public-http.test.ts`; add a focused public case to the existing marketing browser consumer when appropriate. Any existing mandatory route declaration discovered must be reported before editing it.
- Generated `src/routeTree.gen.ts` is not a handwritten artifact. No new stylesheet is expected; justify any necessary narrow style change before making it.

**Interfaces:** Consume existing marketing class names, Astryx Button and public SSR helpers. Produce `DiagnosticLanding(): React.JSX.Element`, a public route with title/description/canonical/social metadata, and read-only links. No private API or mutation is produced.

- [x] Baseline: verify the pinned runtime and existing targeted response-header/marketing checks; record failures without changing infrastructure.
- [x] RED: add real behavior checks. A GET/HEAD of the page must be 200 with the H1, canonical `https://sparra.fr/metiers/diagnostic-immobilier`, existing contact and absolute private links. Assert French HTML, the illustrative/pilot limits and retained private/404/POST security boundaries.
- [x] GREEN: implement the smallest dedicated page using existing styles. Update only the exact successful public-document checks and the French public shell behavior needed by its route. Do not broaden a `/metiers/*` prefix.
- [x] Qualify: source/typecheck/lint, fresh build and existing public HTTP/SSR tests. Verify mobile and keyboard behavior using existing pinned browser tools and owned public test helpers; no foreign runtime or production credential is borrowed. Do not run a Docker fixture concurrently with the integration owner. Keep targeted public proof distinct from full CI/native acceptance, which remains a delivery-owner gate.
- [ ] Review the entire bounded diff independently against this plan and the finalized kit; the single task is also the whole branch, so one complete independent spec/quality review covers both without repeating an identical review.
- [ ] Commit only the bounded page and tests after applicable checks. Report commit/tree, commands/results, any unperformed full native/CI gates, and hand off to the delivery owner; do not publish in parallel.
