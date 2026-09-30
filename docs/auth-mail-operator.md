# Auth mail application consumer

This is the locally qualified native mail/worker core used by existing-user magic
login and first email signup. It is not qualified external delivery or complete
authentication; Google remains separate. No web route exposes an arbitrary send
operation. The named authorized auth caller supplies a validated `MailProfile` to
`materializeDelivery(lease, commandId, envelope, profile)` or
`reconcileAuthorizedObligation`; materialization joins the existing physical auth
transaction. It seals one final inline Plunk request and creates exactly one
outbox. Existing token-only rows never become sendable.

## Explicit database prerequisites

On a new derived database, the operator must provision four distinct roles before
applying migration `0002`. The migration validates their attributes and refuses
missing/unsafe roles. It neither creates nor repairs existing roles. Use securely
supplied login passwords through the operator's credential mechanism, not a
committed SQL script:

```sql
CREATE ROLE auth_mail_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE auth_mail_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE auth_mail_relay LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE auth_mail_worker LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
```

The owner and definer may have no members at all, including `NOLOGIN` members.
None of these four mail roles may itself be a member of another role. Migration
`0002` refuses any topology that violates either rule; temporary membership is
not a migration workaround.

On stock PostgreSQL, the ownership transfers under these no-membership rules
require an operator-supplied superuser for the one-shot migration. An ordinary
database owner or `CREATEROLE` login is insufficient. A platform-specific
migration identity is acceptable only when the operator independently proves it
can perform the required transfers without prohibited membership; no managed
service equivalent is assumed or qualified. Never supply this elevated migration
identity to web or worker.

The four auth mail tables use FORCE RLS; the definer is not their owner. Relay has
only the two named admission `EXECUTE`s; worker has only claim-delivery,
finalize-delivery and purge `EXECUTE`s. Both use the existing auth sentinel through
the same physical owner implementation. Provision `CONNECT` on the selected
database and transaction-mode PgBouncer authentication separately for the two
actual logins; a DSN label is not backend-identity proof. Worker readiness checks
actual session/current user and dangerous membership.

The web login is exactly `runtime`; it is not an operator-selected alias. On a new
isolated project database, grant only the current Better Auth, initial-enrollment
and mail authority after migrations `0000`–`0007`:

```sql
GRANT USAGE ON SCHEMA public TO runtime;
GRANT SELECT,INSERT,UPDATE,DELETE
  ON public."user",public.account,public.session,public.verification TO runtime;
GRANT SELECT,INSERT ON public.passkey TO runtime;
GRANT UPDATE (counter) ON TABLE public.passkey TO runtime;

GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
  ON public.email_delivery TO runtime;
GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime;
```

Initial enrollment uses `SELECT,INSERT` on `passkey`; primary native passkey login
adds only `UPDATE(counter)`. Later passkey security/linking work may require a separately reviewed grant change. Do
not grant worker outcomes or outbox-admission columns to web. SQL guards also
reject forged provider/admission outcomes even when a fixture deliberately grants
broader table DML. No runtime role should own public objects, own the database,
create roles, bypass RLS or have schema `CREATE`.

## Frozen profile and replay policy

`MailProfile` contains `appOrigin`, `apiOrigin`, `projectId`, `credentialId`, `from:{name,email}`, `reply`, `replayWindowSeconds`. Reuse APP_ORIGIN validation for the application origin. The API is a fixed operator-approved HTTPS origin with `/v1/send`; no user URL, mutable template, arrays of recipients, custom headers or dynamic content is accepted. Content is fixed French/English and the token exists only in the direct `/auth/magic/confirm#token=...` fragment. The one-way verifier is separate from the encrypted final snapshot.

`projectId` and `credentialId` are explicit, nonsecret operator binding labels. They do not discover or prove Plunk account identity. Worker binding must exactly match the snapshot. Credential rotation uses a new label; replay under a mismatched/current replacement credential is held. No provider credential is stored in SQL, the outbox, snapshot or Hatchet input.

The default profile uses `replayWindowSeconds:null`: first attempt is allowed, but an unknown outcome has no replay authority. Supply `1..600` only after the selected project's actual retention is observed and approved. SQL writes `firstAttemptAt` once and sets `replayNotAfter=min(command expiry,firstAttemptAt+qualified window)`. Later defaults cannot extend it. Neither a lease expiry, native cancellation nor Hatchet TTL authorizes replay.

Hatchet admission TTL and schedule timeout are ten minutes, matching the maximum auth command lifetime. Provider execution budget is at most ten seconds, intersected with the fresh DB clock/expiry/15-second claim lease and, on retries, the persisted provider replay deadline through actual HTTP emission. Admission lease is 30 seconds. Ambiguous native admission never re-admits automatically. Polling processes one admission per second. Work/transport capacity is one. These bounds are local policy, not provider retention promises.

The current locally qualified pinned native policy uses `retries:4` and
`backoff:{factor:5,maxSeconds:30}` for the static task, with the separate client
retrier still limited to one attempt. Native controlled-engine evidence covers
bounded temporary recovery, immutable expiry refusal, finite exhaustion and usable
status/history for that fixture. The configured `5/25/30/30` arithmetic is not an
exact observed timing claim, a runtime SLO or a total at-least-once lifetime bound.
Every invocation still asks SQL for fresh effect authority. Positive retries do
not serialize, repair or independently authorize provider effects.

Only `worker_stopping`, `outbox_in_flight`, `capacity_busy` and `claim_unresolved` deliberately reject the native task boundary with constant safe codes. The owned handler itself always fulfills after its actual work settles. Malformed/stale/missing/expired/terminal refusals do not deliberately retry; an already-cancelled parent returns cancelled. Rejected acquisition during parent cancellation and all post-effect/finalization uncertainty remain effect_unknown. An observed queued response with unconfirmed finalization may return only its queuedEvidence and captured emailId alongside effect_unknown; it is not a persistence or inbox receipt and grants no replay authority. Task-wide native retries may also apply to engine-originated failures; that behavior remains a qualification gate.

Finite retry exhaustion is an observable failed run, not delivery or guaranteed
eventual recovery. A fulfilled task can also represent business refusal or an
unknown provider effect. The pinned local fixture demonstrated usable bounded
status/history; this is not a production monitoring or retention guarantee. Raw
SDK logging remains disabled, and no replay API or additional recovery scheduler
is implemented.

Queued200 purges ciphertext/nonce/tag while preserving an admissible verifier. Matching409 proves prior queued acceptance only and supplies no email UUID. Invalid/missing receipts remain unknown. Expiry sweeping also covers accepted verifier-only rows. Content with exhausted/missing replay authority is purged; non-content tombstones have no automatic deletion in this increment and reject missing/stale/terminal jobs. This does not claim cryptographic erasure of backups or change backup retention.

## Build and process configuration

Use the repository's pinned Node `24.14.0`/pnpm `10.32.1`, one lockfile and
`pnpm install --frozen-lockfile`. `pnpm build` builds web and
`.output/worker/index.mjs`; `pnpm start:worker` starts only the mail worker, with
no web HTTP listener. Keep production `node_modules` alongside the output: SDK
`1.28.2` remains external because its heartbeat thread resolves package-relative
JavaScript. The build emits an empty owned Hatchet YAML file; no existing
`.hatchet.yaml` is a source of settings.

The web receives `AUTH_SECRET`, the optional complete Google client pair and, for
magic, `AUTH_MAIL_KEY_ID`, `AUTH_MAIL_KEYS_JSON` and the complete
`AUTH_MAIL_PROFILE_JSON`. Its profile `appOrigin` must exactly equal the HTTPS
`APP_ORIGIN`. The web never receives relay/worker DSNs, Plunk or Hatchet
credentials. See the repository README for the Google-only HTTP and magic-enabled
HTTPS web profiles.

The worker shares only the envelope keyring and receives these process-local
values explicitly:

- `AUTH_MAIL_RELAY_DATABASE_URL`, `AUTH_MAIL_WORKER_DATABASE_URL`: distinct non-owner logins; for the setup documented here, use the separately provisioned and independently verified transaction-mode PgBouncer endpoint described above.
- `AUTH_MAIL_KEY_ID`, `AUTH_MAIL_KEYS_JSON`: the same AEAD keyring used to create the snapshots, current ID and a JSON object of base64-encoded 32-byte keys. Keep old decrypting keys only until their admissible snapshots expire/purge.
- `AUTH_MAIL_API_ORIGIN`, `AUTH_MAIL_PROJECT_ID`, `AUTH_MAIL_CREDENTIAL_ID`, `AUTH_MAIL_PLUNK_SECRET`: exact frozen Plunk binding and scoped secret.
- `HATCHET_CLIENT_TOKEN`, `HATCHET_CLIENT_HOST_PORT`, `HATCHET_CLIENT_API_URL`, `HATCHET_CLIENT_TLS_STRATEGY=tls`: selected V1 tenant/engine. The application checks V1 and engine `v0.101.27`. Explicit test-only loopback permits `none`; it is not a production fallback.
- Existing bounded `DB_*` options and `NODE_ENV=production` apply. No `.env` is loaded by this entrypoint.

SIGINT/SIGTERM stop new owned work, cancel the relay/handlers, then join the real handlers, HTTP sockets, native DNS callbacks, SDK lifecycle and per-login pools. SDK `stop()` alone is not drain evidence. DNS lookup has no Node cancellation API: the business deadline destroys the socket but capacity and shutdown remain held until its callback completes. Consequently no hard OS/process shutdown bound is claimed, and an external forced kill leaves the durable attempting marker for later safe reconciliation.

## Qualification boundary

Additional passkeys use the direct `@simplewebauthn/server` pin `13.3.3`, the
existing browser `13.3.0` helper, and Better Auth/passkey `1.7.4`. Migration
`0008_additional_passkey.sql` adds the auth-owned intention table. The actual
application login needs the additional grant:

```sql
GRANT SELECT,INSERT,UPDATE,DELETE ON public.additional_passkey_intent TO runtime;
```

Retain the existing passkey `SELECT,INSERT`, column-level `UPDATE(counter)`, and
`app_private.resolve_personal_workspace(text,text,boolean)` EXECUTE permissions.
The account screen requires an existing personal Workspace and an existing key;
it never provisions either during addition. The user first proves an existing
key, then explicitly creates a different key. One fixed attempt deadline starts
at challenge issuance, lasts at most five minutes and is capped by the effective
session deadline. Reauthentication does not extend it. The three commands preserve
the session and its activity timestamp, while native registration still sets a
challenge cookie. Cancelling a submitted finish cannot prove rollback: refresh
the account's key list deliberately when the outcome is unconfirmed. Restart
requires a new intent and existing-key proof; no stored registration response is
automatically resent. The personal-only path adds no organization authority.

Local native positive-path evidence is recorded in the Task9B dossier. Remaining
native matrices and compiled-browser acceptance are tracked separately there;
this operational description does not claim device/provider or full-template readiness.

Local source/store/role/controlled-TLS/native-engine tests qualify the pinned
worker/retry lifecycle, not Plunk/SES delivery. Before a real send the operator
must authorize account/region/key, verified sender and owned recipient, observe
idempotency retention, set project tracking to DISABLED, explicitly configure a
real SES no-tracking configuration set with no Open/Click events and no VDM
override, and verify the delivered direct fragment link with no redirect/pixel.
There is no SMTP/emulator substitution, implicit account setup or current
infrastructure credential discovery.

Run a fresh `pnpm build`, then `pnpm test`, `pnpm typecheck` and
`pnpm test:integration`. Docker integration suites use exclusively labeled
disposable dependencies and assert unchanged unrelated inventory. The native
application test nests its owned engine fixture inside its stores fixture and
removes the engine first. TLS fixtures require OpenSSL (`openssl` on POSIX,
Git-for-Windows bundled OpenSSL on Windows); they generate and erase their own
short-lived certificates and keys. Never overlap these inventory-protected suites
with helper/MCP/container bootstrap.
