# Google Agenda privacy remediation

## Purpose and authority

Complete the existing Google Agenda production-verification work, under the human instruction to continue Sparra autonomously and keep it simple. On 28 October, the authenticated Google verification center showed four completed review stages and five privacy findings last reviewed on 24 October. This is a clarification of existing processing, not new Google access or a new product feature. The registered URL remains `https://sparra.fr/confidentialite`.

## Chosen approach

Update the existing public page in French and English, with distinct sections for Google data accessed, uses, recipients, protection, and retention/deletion. Preserve its existing application/home/contact links. This is the agent's minimal implementation choice under the user's opt-out from further approval questions. Adding a deletion framework, changing Calendar behaviour, or canceling the existing Google review would not address this documentary repair proportionately.

## Required factual content

- Identify Sparra and its optional Sparra Agenda integration. Name Google account subject/email; calendar IDs, names, time zones and access roles; busy intervals used for offers; and the identifiers, state, times and correlation data of Sparra appointments. Distinguish received/used fields from persisted connection, selected-calendar, policy, offer and command data. Do not claim HTTP responses can never contain other fields.
- Explain account connection, calendar choice, availability, offered slots, explicitly confirmed booking and result verification/Inbox. `calendar.events` permissions are broader than the selected calendar, while Sparra uses the selected calendar for its appointments. Busy intervals are not persisted in the audited Calendar tables. Google events contain service, times and a private Sparra reference, not a full transcript, fabricated guest or caller contact details.
- Name Google, Telnyx audio and OpenRouter with its selected model providers. Necessary service/slot data derived from Google may enter the dialogue and spoken audio. Google OAuth tokens and account/calendar identification are not automatically projected to voice models. Do not invent current model-provider names from a historical export, or universal provider training, logging or ZDR guarantees. Preserve the existing first-party no-advertising/no-general-model-training commitment and Limited Use link.
- State the proved protections: HTTPS public/Google exchanges, server-side AES-256-GCM token encryption bound to Workspace/connection, authenticated owner and tenant isolation. Do not promise application encryption for every ordinary metadata/ANI column, encrypted disks or DB TLS not established by the source.
- Explain 30-day call-content access and deletion/cleanup, separately from Google data. Offers have five-minute validity, not a five-minute deletion TTL. Successful settled disconnection disables booking and clears tokens/Google subject/email, but selected calendar/policy and follow-up records remain. External revocation detection disables booking and can require reconnection without immediate local erasure. Erasing a call deletes its offers and terminal/never-sent commands; potentially sent uncertain operations retain minimal Google identifiers/times for reconciliation until resolved. No unsupported maximum erasure SLA or global 30-day Google purge. Events already in Google remain under the owner's control. Use existing `contact@sparra.fr` for requests concerning remaining Google data; do not invent a complete self-service account-deletion feature or instant backup erasure.

## Evidence and limits

App baseline: `e3207a2298731dedd28b655284f10c899aa0b3cb`. Relevant sources are `src/modules/calendar/{connection.server,google.server,token-crypto.server,schema.server}.ts`, `drizzle/0025_sparra_calendar_booking.sql`, `0020_sparra_local_audio_store.sql`, `0028_sparra_knowledge_confirmation.sql`, and the existing voice Calendar DTO/context projection. Two independent read-only source audits established these boundaries. Official review guidance: https://support.google.com/cloud/answer/13806988 and https://developers.google.com/terms/api-services-user-data-policy .

The existing France/application-and-main-database statement is retained as the existing operator-attested scope; no new residence claim is added. Source does not establish universal upstream-provider retention or complete account deletion. The page must not claim Google has approved data access. Keeping the URL unchanged requires a factual reply in the existing Google review thread after publication; no Console write or email is part of the code task.

## Global constraints

Keep Node 24.22.1, pnpm 10.32.1 and the frozen lockfile. No dependencies, migrations, auth/session/Workspace behaviour, Calendar/Voice/worker changes, provider-account changes, calls, events, financial rule or cap changes. Preserve active peers and all deployed data. Only this task's isolated checkout is writable. Hosting, publication and reply to Google remain separate evidence gates.
