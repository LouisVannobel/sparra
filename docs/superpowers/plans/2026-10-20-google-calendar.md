# Google Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real phone call can create a verified Google Calendar appointment and retain its reference in the existing Inbox.

**Architecture:** One native Google connector owned by Effect, with owner settings on Entreprise. Voice submits bounded PostgreSQL commands through its existing deployment binding; one small independent worker pump executes and reconciles them. Native Pipecat tools retain real caller-turn authority.

**Tech Stack:** Existing pinned TanStack Start, Effect 4, Better Auth 1.7.4, Drizzle/PostgreSQL, Undici 7.30.1, Python 3.13 and Pipecat 1.12.0. Tasks 4a–4c qualify narrowly scoped security corrections; Task 4b explicitly records its temporary Pillow compatibility exception.

**Spec:** `docs/superpowers/specs/2026-10-20-google-calendar.md`

## Global Constraints

- One Google connection, destination calendar and unit-capacity resource per native personal Workspace.
- No public prices, fictional active business rules, new voice framework or calendar intermediary.
- Preserve the current phone budget, floors, counters, paid fence, recording-off and transfer-off settings.
- Workspace/calendar/credential authority is server-derived; no arbitrary model tenant, calendar or URL.
- Google login remains separate. Calendar secrets never enter DTOs, logs, source, fixtures or Oracle inputs.
- Persist stable operation/event IDs before provider POST; unknown outcome is reconciled, never blindly recreated.
- Native per-task RED/GREEN tests and independent spec/quality review; all source/runtime/provider gates reported separately.
- Existing isolated App and Voice worktrees on `z/sparra-google-calendar-oct20`; preserve unrelated repositories and ignored review artifacts.

## Review Focus

- A shared calendar with reduced rights or a freeBusy partial error fails closed; Task 1 covers provider contracts and Task 2/3 owner permissions.
- A reconnect/disconnect concurrent with a booking cannot silently target another account; Task 2/3 cover revision and lifecycle fences.
- Different start times can still overlap, and offer expiry cannot clear an uncertain booking; Task 3 covers interval/recovery rules.
- Barge-in after a provider POST cannot create a second booking or announce unverified success; Task 3/4 cover durable operation and current-turn output.
- DST, phone-only callers and a partial summary do not corrupt booking date or status; Task 3/4/5 cover exact instants and independent Inbox evidence.

---

### Task 1: Native Google boundary and Calendar token protection

**Files:** Create `src/modules/calendar/config.server.ts`, `google.server.ts`, `token-crypto.server.ts`; tests `tests/calendar/google.test.ts`, `token-crypto.test.ts`, `config.test.ts`. Add only real consumed files; later tasks import them.

**Interfaces:**
- `readCalendarConfig(env: Readonly<Record<string,string|undefined>>): CalendarConfig | null`; config has canonical `origin`, Redacted `clientId`, `clientSecret`, `tokenKey`. Absent dedicated config returns null; partial/invalid rejects Calendar alone.
- `encryptCalendarTokens(config: CalendarConfig, binding: {workspaceId:string;connectionId:string}, tokens: CalendarTokens): string` and inverse `decryptCalendarTokens(...)` validate version, AAD and complete shape. `CalendarTokens` has accessToken, refreshToken, expiresAt epoch milliseconds, grantedScopes string[]. AES-256-GCM with random nonce; no key/token fallback.
- `createGoogleCalendarClient(config: CalendarConfig, signal: AbortSignal, deadlineAtMs: number, dispatcher?: Dispatcher)` owns default Undici transport and returns `exchangeCode({code,codeVerifier,redirectUri})`, `refreshTokens(refreshToken)`, `revokeToken(token)`, `userInfo(accessToken)`, `signingKeys()`, `listCalendars(accessToken)`, `freeBusy(accessToken,{calendarId,timeMin,timeMax})`, `insertEvent(accessToken,{calendarId,event})`, `getEvent(accessToken,{calendarId,eventId})`, `close()`. `signingKeys()` is the bounded no-auth GET to `https://www.googleapis.com/oauth2/v3/certs`, returning at most 16 validated RSA signing JWKs (kid/kty/alg/use/n/e), for Task 2's native verifier.
- Export bounded provider DTO types: `GoogleCalendar` (id, summary, timeZone, accessRole including writerWithoutPrivateAccess), `GoogleEvent` (id, status; timed/date-only intervals for ordinary observations, id/status alone allowed for cancelled events; optional htmlLink/private correlation). Token exchange returns token response fields with validated scopes, optional refresh token/expiry and optional `idToken` for Task 2's mandatory initial identity validation. Initial offline-grant enforcement belongs to Task 2.
- `CalendarProviderError` exposes only a safe code: unavailable, unauthorized, rate_limited, not_found, conflict, rejected, unknown. Creation network/5xx uncertainty must remain unknown; no provider body/raw cause retained.

- [ ] Write behavioral RED tests: partial configuration, cross-Workspace/connection decrypt, tampering, redacted errors; fixed Google endpoints, calendar/event path encoding, pagination, partial freeBusy error, token shape/scope, creation response identity, 409/429/5xx/timeout, no automatic POST retry, cancellation and joined transport cleanup. Use an offline protocol peer/Undici MockAgent, no runtime mock adapter or environment endpoint override.
- [ ] Run `pnpm exec vitest run tests/calendar --maxWorkers=1`; verify expected missing-module/behavior failures before production edits.
- [ ] Implement the bounded Google REST client using existing Undici and Effect Schema. At most 10 seconds per invocation, finite response/header/page limits, no redirects, fixed Google hosts and no access token in query strings. Use official accepted event scopes instead of the broad sample scope. Decode only needed provider data.
- [ ] Run the focused tests, `pnpm run typecheck` and lint changed files. Inspect installed source/types for APIs used; no broad casts, dependency updates, migrations, provider calls or UI in this task.
- [ ] Commit and report RED/GREEN commands, results, lifecycle evidence and concerns.

### Task 2: Owner connection, policy and Entreprise controls

**Files:** Create `src/modules/calendar/schema.server.ts`, `connection.server.ts`, `calendar.functions.ts`, `policy.ts`; `src/routes/api.calendar.google.callback.ts`, `src/ui/sparra/calendar-panel.tsx`; modify `src/routes/app.entreprise.tsx`, `src/platform/{runtime,resources}.server.ts`, schema exports and a generated forward migration. Tests `tests/calendar/connection.test.ts`, `policy.test.ts`, `tests/integration/calendar-owner.test.ts`, `tests/ui/calendar-panel.test.tsx`.

**Interfaces:** Consume Task 1. Produce `createCalendarOperations(owner,config)` with owner-authenticated `read`, `beginConnection`, `completeConnection`, `savePolicy`, `disconnect`. Server functions derive admitted principal and native personal Workspace, never take Workspace as authority. Safe DTO contains connection status/account display/selected calendar/rules/revision only. `CalendarPolicy` follows the spec limits and is versioned; active policy cannot be saved without real writable calendar and complete services/hours.

- [ ] Write RED tests for missing principal/Workspace, one-shot state/PKCE/session binding, scope denial, reconnect races, token storage, rejected foreign agenda, stale policy revision, invalid schedules and secret-free DTOs. UI tests cover keyboard/error/reconnect states and no fabricated saved settings.
- [ ] Observe RED, then implement separate Calendar OAuth intentions and encrypted connection storage under native RLS. Use public Better Auth OAuth primitives/source for state/PKCE, fixed canonical callback `${origin}/api/calendar/google/callback`, offline consent and `openid email`. Use its public `verifyProviderIdToken` with RS256, Calendar audience, Google issuer, nonce and a signing-key resolver backed by Task 1's bounded `signingKeys()` transport; do not use the provider's unbounded default JWK fetch. Validate verified claims and cross-check Google userInfo sub. Never mutate auth account-link storage. Fence refresh/disconnect/reconnect settlement by generation and exclude simultaneous active connections for the same Google sub across Workspaces.
- [ ] Generate/review the owned forward migration and snapshot; use disposable PostgreSQL only during implementation. Enforce owner/workspace RLS, connection/policy revisions and token-renewal ownership. A disconnect disables new work immediately; pending provider writes retain their reconciliation identity.
- [ ] Add a compact Astryx panel in Entreprise, with Connect/Choose calendar/Services and durations/Hours/Enable/Disconnect. Display API availability and actual account. Do not silently activate inferred business rules.
- [ ] Run focused UI/owner integration tests, typecheck and changed-file lint; commit after self-review.

### Task 3: Durable Calendar operations, worker and Inbox result

**Files:** Create `src/modules/calendar/{store,availability,worker}.server.ts`, `src/platform/calendar-runtime.server.ts`; modify `src/worker.ts`, `src/platform/db/{config,resources}.server.ts`, `src/modules/sparra/requests.server.ts`, `src/ui/sparra/request-panel.tsx`, Calendar schema and a second forward migration. Tests `tests/calendar/availability.test.ts`, `worker.test.ts`, `tests/integration/calendar-bridge.test.ts`, `calendar-booking.test.ts`, `tests/platform/calendar-runtime.test.ts`.

**Interfaces:** Produce exact execute-only Voice functions `voice.calendar_catalog_v1(uuid)`, `voice.calendar_submit_v1(uuid,uuid,jsonb)` and `voice.calendar_result_v1(uuid,uuid)`. Catalog shape: `{schema_version:1,call_id,policy_revision,timezone,services:[{service_id,name,duration_minutes}]}`; read once after admission without changing the strict begin-call snapshot. Commands contain kind `find_slots` (serviceId, policyRevision, windowStart/windowEnd) or `book_appointment` (offerId, real confirmation turn/review evidence). Contacts remain in the existing encrypted call/Inbox flow; Google gets service/time and the private request link only. No caller Workspace/calendar/URL is accepted. Worker uses persisted command ID + claimed fence; narrow `app_private.calendar_*_v1` functions derive all tenant and connection authority from the claimed row. Consume actual Task 2 `calendarConnection` fields and `CalendarPolicy`/`calendarOfferLimits`, not a parallel connection or policy store.

- [ ] Write RED integration tests for cross-Workspace/login/OID/erasure denial, repeated operation with same/different digest, new tool ID for same intent, overlapping intervals with different starts, freeBusy partial errors, expired offer/revised configuration and no credentials in Voice results.
- [ ] Implement offers (three max, five-minute expiry), structured schedule calculation over at most 30 days and fixed-interval UTC candidates interpreted in IANA time. Skip ambiguous/nonexistent local labels; apply duration, margin, preavis and Google busy intervals. Do not fetch event titles/descriptions to calculate availability.
- [ ] Add command/booking persistence and `calendar_worker`/`calendar_definer` roles with no memberships or direct worker table privileges. Claim/prepare/finish and token-renewal functions use fixed search paths, narrow RLS, lease fences and short transactions. Prepare ID/interval before POST, recheck busy, never hold locks across Google I/O.
- [ ] Implement one independent, bounded worker loop (one-connection pool, one command, 250ms idle sleep). After freeBusy, a final fenced SQL transition checks all generations, destination, lease and the 30-second first-send deadline before persisting possible submission. Read back ambiguous prepare/finish commits. Read/reconcile a prior unknown event ID before any new creation; a replaced lease never authorizes a second POST. Unknown keeps its interval reserved; 409/404/permission loss establish neither success nor absence. Reconcile confirmed events on demand before their old interval blocks a new slot, including Google moves/cancellations/date-only edits. Preserve original evidence separately. Initialize independently of Hatchet, stop claims, bound/join active work, close transport before pool and expose failure without masking mail/billing lifecycle.
- [ ] Add verified status/service/date/provider reference to Inbox separately from model summary. Keep appointment_to_confirm fallback. Cover disconnect during submission and token refresh concurrency.
- [ ] Run focused integration/protocol/runtime tests, typecheck/lint; commit with recovery evidence.

### Task 4: Native Pipecat appointment tools

**Repository:** `C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-phone-response-bound-oct11`.
**Files:** Modify `src/projetv0_voice/{pipeline,session,action_authority,session_factory}.py`, `inference/{services,openrouter_tts}.py`, `persistence/postgres_sink.py`; create focused `calendar.py` for bounded DTO/tool policy only if it keeps session logic small. Tests `tests/test_calendar_tools.py`, `tests/test_calendar_postgres.py`, existing action authority/TTS tests. A recap must not bind as an end-call farewell context or consume the separately reserved final-goodbye allowance; add the narrow native context observer and retain existing caps.

**Interfaces:** Consume Task 3 PG functions with same stable operation ID on ambiguous submission and bounded result polling. Native tools expose only service preference and opaque slot selection. Bind current CallerScope to the persistent transcript turn UUID and an actually emitted recap. The server—not model `confirmed:true`—validates permission to submit the selected offer.

- [ ] Write RED tests for no consent, unknown service, changed offer, stale/interrupted/speculative scope, foreign offer, repeated tool IDs/intents, call end while Google is pending, timeout and verified/nonverified results. Demonstrate that old end_call/request_human behavior remains intact.
- [ ] Extend the existing native tool guard explicitly for typed Calendar arguments, preserving the single caller-turn owner and bounded tool count. Fetch the actual catalogue after admission; unavailable means message-taking only. Send a short deterministic recap, reuse existing Telnyx playback-mark acknowledgement with a distinct recap namespace, then require a new real caller acceptance tied to that exact recap/offer and recorded turn UUID. If ambiguous or interrupted, ask again rather than submit. Confirmation evidence is native-generated and never part of model-controlled tool arguments.
- [ ] Add typed methods to the existing Psycopg sink, retaining its native transaction/unknown-commit boundary. Release the pool connection before each polling delay. No Google token, new orchestration runtime or provider client in Voice.
- [ ] Speak a confirmed result only for a verified provider booking; suppress stale output after barge-in. Unknown/conflict preserves a useful Inbox request. Run covering pytest, Ruff and mypy, then full offline Voice gate once before final qualification. Commit/report.

### Task 4a: Qualify the existing Voice dependency security patch

**Reason:** The unchanged hosted repository security gate failed on aiohttp 3.14.3, reporting CVE-2026-111064 and GHSA-2g87-pp6c-29x5. Official upstream advisories fix these in 3.14.4; 3.14.5 is the current non-yanked patch and adds a WebSocket control-frame compatibility fix. It requires yarl >=1.25.1; the current lock has 1.24.5. The feature's Pipecat/Python/provider pins remain unchanged.

**Files:** Voice `uv.lock`, only the two consumed package entries and necessary artifact metadata. No new direct dependency, workflow change, security ignore, model/provider or financial change. Use existing native consumers and immutable image/security gates.

- [ ] After Task 4 source correction/re-review, refresh exactly aiohttp 3.14.5 and yarl 1.25.1, both officially published, non-yanked and available for Python 3.13 Windows/Linux. Preserve all other lock entries; report any unavoidable solver delta before broadening.
- [ ] Run frozen lock/sync, actual existing affected native HTTP/WebSocket consumers, Ruff and mypy. Dependency refresh does not need an implementation-mirroring version test. Record the hosted security failure as RED, and require a new actual repository scan plus full source/image qualification at the new exact source before release.
- [ ] Independent review of the bounded package delta/compatibility evidence. Do not change the dependency graph under the still-active Task 4 implementation, suppress the advisories or assume an old image scan covers the new graph.

### Task 4b: Qualify the refreshed certifi/Pillow security findings

**Reason:** After the reviewed Voice component merged, refreshed repository and immutable-image scans detected critical/high findings in certifi 2026.7.22 and Pillow 12.3.0. The new artifact was not promoted. Official Pipecat 1.12.0 and the latest published release both constrain Pillow below 13; no patched 12.3.x release is currently published. A targeted Oracle review recommends the smallest documented operational exception, preserving the official Pipecat wheel rather than maintaining a fork.

**Files:** Voice `uv.lock`, a narrowly scoped `tool.uv.override-dependencies` entry in `pyproject.toml`, and a concise checked-in maintenance record. Qualify certifi 2026.10.19 and Pillow 13.0.0, preserving Python, Pipecat, every other package, models and phone budget. Prefer an override scoped to Pipecat 1.12.0 if the pinned uv supports it; otherwise inventory every incoming Pillow requirement before an exact global override. No metadata rewriting, advisory suppression or existing gate waiver.

- [ ] Verify official non-yanked artifacts, exact lock freshness and frozen sync with the CI-pinned uv. Record the original Pipecat metadata and actual dependency-checker result; only its explicitly declared Pillow mismatch is within this exception.
- [ ] Review the actual accepted caller/provider/tool frame paths and disabled video configuration; exercise the real application imports, Pillow native extension and existing audio/TLS lifecycle consumers. No general vision suite or extra paid call.
- [ ] Record owner, exact tuple, scope, evidence and review/expiry on 2026-11-01. Remove the override after adopting a published upstream release admitting patched Pillow, or a suitable official patched Pillow within the bound, then resolve and requalify. Tuple or image/video scope changes require reconsideration. This is application compatibility under an exception, not upstream support.
- [ ] Obtain independent scoped source review and exact-source hosted native/security/image qualification. Refresh App's truthful main-owned fixture only after the corrected Voice source is integrated into actual main. Previous green runs do not qualify the new dependency graph.

### Task 4c: Close the final App publication gates

The first final App run detected three HIGH findings in Vite 8.2.2 and follow-redirects 1.16.0. Qualify the nearest maintained security patches, Vite 8.2.4 and follow-redirects 1.16.1, preserving all other package versions, peer ranges, Node and pnpm. Use official artifact integrity and a normalized whole-lock comparison; no override or advisory suppression is needed.

The same run independently exposed an entrypoint regression: a disabled Calendar resource caused a stopped acknowledgement after mail capabilities were rejected. Separate cleanup ownership from successful worker readiness, preserving every cleanup/failure/listener and independent Calendar contract. Keep the original native-image rejection assertion unchanged and observe focused RED/GREEN before the minimal correction.

Run bounded installed native/RPC/HTTP consumers, typecheck, lint and build, then obtain independent scoped review. The image fixture's unchanged Linux-local-networking prerequisite must not be bypassed on Windows; its actual three assertions and the unchanged complete exact-source App gate remain mandatory on hosted Linux. Preserve earlier failed/cancelled runs and their distinct cleanup outcomes. No new feature, framework, provider call, budget change or broader Calendar redesign belongs to this lot.

### Task 4d: Close introduced maintainability findings without changing booking authority

The exact final App run passed both full 2526-test native consumers, including Calendar 69/69, then failed the unchanged Fallow 3.18.0 audit on eight introduced dead-code errors and sixteen introduced complexity findings. Make internal-only symbols private and declare only the real Calendar HTML/Vite fixture entry. Separate cohesive Google body/protocol decoding, owner intention claim/parsing, worker availability/observation preparation, controlled services/hours editors and existing native fixture scenarios. Preserve inherited findings and warning-only duplicates; no threshold, baseline, suppression or acceptance relaxation.

The targeted Oracle review `sparra-calendar-minimal-oct21` approves this bounded correction with two required amendments. Keep `store.prepare`, acknowledgement-loss read-back and `possible = true` visible before awaiting any extracted insertion; retain claim, final settlement and transport closure ownership. Move the complete concrete Calendar action routine into the real production-consumed, instrumented boundary using the same busy/controller refs; keep the unmount abort in the panel. Correct cancellation between dependent awaits and before publishing late results. Do not add a generic operation framework or a second refresh engine.

Add meaningful missing public behavior tests for refresh identity/grants and lost settlement acknowledgements, actual code/PKCE exchange, and the panel's duplicate-operation/error/abort/ordering behavior. Test cancellation failures before their correction. Preserve the seven native consumer names and all prior adverse cases. Update exact cohort admission only when real added cases require it, without reducing existing geometry. Run focused native checks, normative typecheck/lint/build and independent scoped review, then the complete unchanged exact-source hosted native/coverage/Fallow/security gate. Existing pre-change passes do not qualify the resulting source. All SQL, Voice, model, provider and phone-budget contracts remain fixed.

### Task 5: Qualification, Google setup and owned deployment

**Files:** Add `docs/qa/google-calendar.md`, offline protocol/consumer fixtures and `tests/integration/calendar-consumer.test.ts`; add a real public `/confidentialite` route and a footer/panel link documenting the actual Calendar data use, consent, disconnect and separate event retention, using the existing public contact address and no invented legal identity/address. Adjust native source/export manifests only where this real consumer requires it. No production credential or customer export belongs in these files.

- [ ] Exercise real App→PG command→worker→Google protocol peer→Inbox and Voice native-tool consumer, including lost response/crash/restart and phone-only caller. Fail closed on missing/invalid test evidence; do not waive existing CI checks.
- [ ] Independent whole-branch review and Oracle milestone review of the smallest sanitized implementation/verification bundle. Resolve material findings; run normative App/Voice checks and hosted pipelines at the reviewed SHAs.
- [ ] Configure the separate Google Calendar OAuth project/client using the owner's authorized account; enable the API, canonical callback, scoped consent and protected secret delivery. If sign-in/MFA/consent requires the owner, request only that action asynchronously while continuing source/CI work.
- [ ] Prepare immutable owned web/worker/Voice release and forward-migration recovery, then deploy to owned ops02 via the actual ops01 Dokploy manager. Never use the unrelated OVH Dokploy MCP. Preserve the phone's financial authority, existing SQLite state and unrelated services.
- [ ] Connect the real calendar and save real services/hours. Verify one genuine controlled phone appointment, Google event and Inbox reference with no invented data. Only then claim end-to-end booking ready; report source, hosted, provider and human-call acceptance separately.
