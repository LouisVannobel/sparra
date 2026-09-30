# Task 1 implementation report

Scope: public French landing, SSR metadata, locale/navigation, HTTP index/media policy, derivative ownership/provenance. No audio implementation or quality-tool changes. All shell commands ran in `C:/Users/louis/Documents/ChatGPT/sparra`; no .env/objective read, provider call, shared migration, producer write, push or deployment.

## Source and intact baseline

- Original SHA-256 delivery: `f932b25356c82d9a5c89d0849409f043b05f95cb2206b1d7870878c00cc4e4c6`.
- Local original import: `06dcf574e6ae9c4ea1dafcf3f362e784c7110575`; pre-task HEAD: `83712f786455b6d7d9cd78d3fb0c9e8d4556a5f2`.
- `git rev-parse --show-object-format` → `sha1`; `git remote -v` → empty. Branch `z/sparra-site-audio`.
- Independently opened `C:/Users/louis/Documents/ChatGPT/boilerplate-handoffs/r1-20260930/boilerplate-r1-source.zip` read-only. `Get-FileHash -Algorithm SHA256` → `58F5F513D99EDCAD628E5FC214E7B989349E1BA4133AA0E91CB4F5E5B58B010A`. Required prefix, rejected absolute/backslash/traversal paths, resolved each destination under this app, and compared SHA-1 Git blob bytes with `git ls-tree -r` at the original import. All 262 ZIP files match the 262 original import blobs. No extraction/overwrite.
- Read extracted README, AGENTS, handoff guide, delivery JSON and per-task/global requirements. Read the adopted spec's public section only, not the full plan. The controller supplied binding exact four-step headings/body. The updated task brief is 6135 bytes, SHA-256 `A53E512A181727898B019DE9FC8CBEB4C14D9F518907A610B85C185F32EC5922`.
- `node --version` → `v24.14.0`; `pnpm --version` → `10.32.1`.
- `pnpm install --frozen-lockfile` → exit 0, 334 exact packages. Warning: upstream dependency build scripts ignored by existing pnpm policy. No approval/pin change performed.
- `pnpm typecheck` → exit 0, before behavior changes.
- `pnpm build` → exit 0, intact R1 web and worker. Existing >500kB chunk warning, native-platform note and plugin timing warning retained.
- `pnpm test` → exit 0, **53 files / 682 tests**, 64.38s, one worker. Integration tests excluded by the native ordinary-suite configuration.

## TDD evidence

New HTTP tests reuse existing `startWeb`, `pgWire` and `redisWire`. Only test instrumentation in `runtime-probe.mjs` gained bounded root responses (HTML500, JSON200, HTML302); no second launcher or runtime test adapter exists. Every owned child is cleaned up before closing only its wire fixtures.

First RED command, against the intact compiled R1:

```text
pnpm exec vitest run tests/marketing/public-http.test.ts --maxWorkers=1
FAIL only successful root documents are indexable
AssertionError: expected 404 to be 200
Expected: 200
Received: 404
```

That first run also showed an existing Router canonical search redirect on `/inconnu` (307 before eventual404); the missing/private test was corrected to follow that existing normalization. Re-run before production edits: exit1, **1 failed / 4 passed**, root404≠200; no unrelated failure.

After the first implementation, five HTTP tests passed while fetch followed redirects. Self-review tightened the public-root fetch to `redirect: 'manual'` to prove the specified direct200 contract. This exposed another real RED:

```text
FAIL only successful root documents are indexable
AssertionError: GET /: /?lang=fr: expected 307 to be 200
```

Native Router Core `load-server.ts` canonicalizes validated defaults. An index-only `stripSearchParams` attempt built but failed typecheck (`SearchMiddleware<unknown>` incompatible with inherited locale schema), and still redirected because parent validation re-added the default. It was removed. The documented, typed root `stripSearchParams<{ lang: Locale }>({ lang: 'fr' })` removes only the default French query value. Root `/` now returns direct200, English search is preserved, and the document/provider locale is French only at `/`. Private FR/EN navigation and security remain tested; default French private URLs now omit the redundant locale parameter as well.

Final targeted GREEN: `pnpm exec vitest run tests/marketing/public-http.test.ts --maxWorkers=1` → exit0, **5/5 passed**, 1.61s. Tests cover direct GET/HEAD `/` and `/?lang=en`, title/description/canonical/contact/anchors, French HTML, script nonce, no private config payload, root POST policy, `/login`, `/login?lang=fr`, `/login?lang=en`, Workspace/missing route headers and controlled500/JSON200/redirect302 policy. The controller accepted the documented native default-locale normalization; explicit FR and EN login checks were added after that ruling and passed. Existing source auth/callback contracts passed in the full suite, with no callback-handler/registration changes.

## Implementation and self-review

- Public landing uses existing Astryx Button, Theme and InternationalizationProvider with published precompiled CSS. No dependency, font/CDN, tracker or Effect client import added.
- All marketing CSS is scoped beneath `.sparra`: adopted paper/white/black/highlighter palette, local system typography, weight500 headings and responsive layout. Public navigation targets real `fonctionnement`, `controle`, `offre` sections and email composition. No empty listen link.
- Four exact step headings, conditional line compatibility, pilot readiness framing, visibly fictitious/read-only Garage Horizon knowledge, unconfirmed appointments, qualified-later human fallback and one monthly offer without price claims.
- Canonical `https://sparra.fr/` excludes query parameters. Runtime index/media exception requires exact root path, GET/HEAD, 2xx and HTML. All previous security directives/no-store are retained; only that exception removes noindex and appends `media-src 'self'`.
- Root locale follows the installed SSR-safe `useRouterState` implementation. Router outputs were generated by build, never hand-edited. Auth, stores, provider callbacks, worker, migrations and pins remain unchanged.
- AGENTS now identifies dedicated derivative ownership, branch and authorized root adaptations while retaining inherited security invariants. Frozen R1 delivery metadata remains unchanged, with separate SPARRA_PROVENANCE.md.
- Self-review read the complete changed shared-boundary diff and new page/CSS/tests. `git diff --check` → exit0. Package/lock/workspace diff → empty.

## Final verification and limits

Final web/worker `pnpm build` → exit0; final normative `pnpm typecheck` → exit0. Full post-change `pnpm test` → exit0, **54 files / 687 tests**, 55.72s, one worker; no failed test omitted. Code and this report are committed together as `feat: introduce Sparra public landing on R1`; its exact SHA is returned to the controller for the ledger.

This task does not qualify browser layout/a11y, live voice, physical passkeys, real stores/providers, human fallback, inbox persistence, legal identity, French residency or publication. Later tasks/controller own audio, browser/quality review and preview. Existing large-chunk/build-script warnings are baseline observations, not new failures. The shared default-French URL normalization is the only additional routine behavior decision and is explicitly recorded above for controller review.
