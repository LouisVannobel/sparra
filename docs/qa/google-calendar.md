# Google Calendar qualification and release contract

The Calendar connection is separate from Google sign-in. Source, disposable native consumers, hosted exact-SHA gates, Google consent, deployment and the single human phone appointment are separate acceptance boundaries. An offline protocol peer does not establish Google or model-selection acceptance.

## Operator prerequisites

Before the forward Calendar migrations, provision `calendar_definer` as NOLOGIN and `calendar_worker` as LOGIN. Both require NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION and **no role memberships**. The migration owns exact function privileges, FORCE RLS and definer checks; the worker must not receive direct product-table access. Do not grant runtime broad tenant authority.

After migration 0025, explicitly grant the **existing bound V2 deployment login** EXECUTE on exactly `voice.calendar_catalog_v1(uuid)`, `voice.calendar_submit_v1(uuid,uuid,jsonb)` and `voice.calendar_result_v1(uuid,uuid)`, retaining its existing schema USAGE and V2 ingress grants. PUBLIC/runtime access does not establish this authority. Keep the existing login/OID/deployment binding; do not change the strict begin-call snapshot or create another bridge identity.

Dedicated protected configuration:

- Web and worker: `APP_ORIGIN=https://sparra.fr`, `SPARRA_GOOGLE_CALENDAR_CLIENT_ID`, `SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET`, `SPARRA_CALENDAR_TOKEN_KEY` (canonical base64url encoding of 32 bytes).
- Worker only: `SPARRA_CALENDAR_DATABASE_URL`, authenticating as the dedicated `calendar_worker` login. Its native pool is restricted to one connection.
- Keep all existing web, worker and Voice keys, DSNs, financial budget/counters, profiles and SQLite state. Never source a production `.env` into tests or export secrets into release evidence.

Use the owned ops01 Dokploy manager for workloads on ops02. Release source/images must be immutable and qualified at the reviewed SHA. Apply forward migrations with the existing migration owner and recovery procedure before enabling the connection. Recovery must preserve possibly submitted commands and the original stable event IDs: never erase unresolved commands or recreate events to repair ambiguity. A replacement worker reconciles the persisted Google event ID by GET. Disconnect disables future bookings but does not delete existing Google events.

## Google and owner setup

Use the dedicated `sparra-agenda-20261020` project, separate from the existing login project. Enable Calendar API and configure the canonical callback `https://sparra.fr/api/calendar/google/callback`. Consent includes `openid email`, `calendar.calendarlist.readonly`, `calendar.events.freebusy` and `calendar.events`. The events grant covers accessible calendars more broadly than the selected booking calendar; disclose it accurately. Publish the actual `/confidentialite` page and its Google Limited Use disclosure. External/Testing refresh tokens for these scopes expire after seven days; this is not durable customer availability.

The owner connects their selected calendar and saves actual services, durations, timezone and hours in Entreprise. There are no preloaded business rules. Before the controlled phone appointment, inspect the saved trial instructions for an obsolete prohibition on real appointments; align them through the owner's real configuration flow while preserving the truthful trial identity and recording/transfer choices. Do not invent capacity or use test fixture services as production settings.

## Privacy evidence boundary

Application and primary database hosting are in France; Google and necessary voice AI processing are external. The event contains service/time and a private Inbox link plus its operation reference. Contacts and conversation remain in the encrypted Inbox for 30 days; Google event retention is independent. Do not claim all-France AI processing, universal zero retention or legal/compliance acceptance.

The controller's dated 21 October 2026 preflight verified the actual Baseten/Together restricted LLM path, endpoint-specific Private badges and disabled OpenRouter product-improvement opt-in, plus the standard Azure MAI real-time synthesis policy. This supports the narrow selected path, not an account-wide ZDR claim. Reevaluate on provider/profile or opt-in changes. Primary policies: [Baseten](https://www.baseten.co/security-practices/), [Together](https://www.together.ai/privacy), [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [Azure synthesis privacy](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/data-privacy-security?tabs=prebuilt-voice).

## Native qualification

Use only owned disposable stores and explicit synthetic configuration. `SPARRA_VOICE_TEST_ROOT` selects the actual local candidate for development. Hosted App acceptance must consume the reviewed Voice source from actual main through the exact archive/manifest/verifier; a branch commit must never be labelled main. Root integrates reviewed Voice first, then regenerates that exact fixture and qualifies hosted App at its resulting SHA.

The Calendar cohort must retain owner, bridge, browser and native consumer tests, exact report/file/leaf/cardinality admission, native coverage geometry, owned retirement and global inventory checks. Source must stay frozen during consumers. Before heavy local work require at least 2 GiB physical and 6 GiB virtual free memory. Do not stop foreign workloads or weaken inventory checks to obtain green.

The final human acceptance is one authorized call within the retained budget: audible recap, fresh affirmative, correct event/service/time in the chosen Google calendar and the same independently verified reference in Inbox. A held or unknown outcome is not a confirmed booking. Record source, hosted, provider and human evidence separately.
