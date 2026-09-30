# projetV0 SaaS template candidate

For a separate product agent working in parallel, read the
[frozen application handoff](docs/handoff/BOILERPLATE_FOR_SPARRA.md).
It distinguishes this application candidate from the GitHub CI starter and
defines explicit update/migration ownership; it is not a production-readiness claim.

This private candidate currently supports these locally qualified application journeys:

- configured Google protocol sign-in;
- magic-link sign-in for an existing User;
- first email signup completed by native user-verified passkey enrollment;
- logout followed by primary sign-in to the same account with that discoverable passkey;
- an active session, account view and logout; and
- explicit personal Workspace creation, read and rename.

The Google and magic journeys were qualified with controlled local provider, TLS,
browser and native-worker fixtures. They are not live Google, Plunk, SES or inbox
acceptance. The passkey return journey was qualified through compiled HTTPS
Chromium with a retained virtual resident authenticator and the native
Better Auth/SimpleWebAuthn/PostgreSQL path; it is not physical-device,
Safari/iOS or older non-resident-key qualification. It grants no step-up,
linking or protected-operation authority. Recovery, complete auth UX, B2B,
commerce and the reusable template derivations remain incomplete.

## Install and build

Use the exact repository pins: Node.js `24.14.0` and pnpm `10.32.1`.

```text
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` emits both `.output/server/index.mjs` and
`.output/worker/index.mjs`. Keep the pinned production `node_modules` beside the
compiled worker: `@hatchet-dev/typescript-sdk` `1.28.2` retains a
package-relative heartbeat dependency at runtime.

## Prepare a new isolated database

These are operator prerequisites, not roles created or repaired by migrations.
Provision them before the first `pnpm db:migrate`. Passwords for login roles must
come from the operator's credential mechanism and must not be committed:

```sql
CREATE ROLE runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE ROLE auth_mail_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE auth_mail_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE auth_mail_relay LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE auth_mail_worker LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE ROLE workspace_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE workspace_bootstrap NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
```

The mail owner and definer may have no members at all, whether those members are
`LOGIN` or `NOLOGIN` roles. None of the four mail roles may itself be a member of
another role. The two Workspace roles permit no membership in either direction,
and `runtime` must have no membership involving either of them.
No runtime role may own the database or public objects, create roles, bypass RLS,
be superuser or have `CREATE` on application schemas.

The migration principal is a separate direct-PostgreSQL identity. On stock
PostgreSQL, these ownership transfers under the no-membership rules require an
operator-supplied superuser; an ordinary database owner or `CREATEROLE` login is
insufficient. A platform-specific identity is acceptable only after the operator
independently proves that it can perform the required ownership transfers without
prohibited membership. No managed-service equivalent is assumed or qualified.
This elevated identity is used only by the one-shot migration and is never
supplied to the web or worker. PostgreSQL must be exactly `16.15`; the web endpoint
must separately be an operator-verified transaction-mode PgBouncer endpoint.

Supply the direct `MIGRATION_DATABASE_URL` and, if needed, the bounded `DB_*`
timeouts to the one-shot migration process, then run:

```text
pnpm db:migrate
```

This applies the repository's forward sequence `0000` through `0012` in one owned
transaction. It does not run at web startup, invent missing roles, repair unsafe
roles or reconcile rejected existing data. For the two login roles, migration
`0002` grants only the two relay admission functions and the worker
claim/finalize/purge functions. Migration
`0004` grants only the following Workspace authority to the exact `runtime` login:
schema usage, `SELECT` plus display-name/update-time `UPDATE` on `workspace`,
`INSERT` on `workspace_audit`, and `EXECUTE` on
`app_private.resolve_personal_workspace(text,text,boolean)`. It also grants the
bootstrap role only its function-internal table authority. PUBLIC function and
table access remains revoked.

After migration, grant the existing web login the Better Auth, auth-mail and
initial-enrollment privileges actually consumed by the current application:

```sql
GRANT USAGE ON SCHEMA public TO runtime;
GRANT SELECT,INSERT,UPDATE,DELETE
  ON public."user",public.account,public.session,public.verification TO runtime;
GRANT SELECT,INSERT ON public.passkey TO runtime;
GRANT UPDATE (counter) ON TABLE public.passkey TO runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.additional_passkey_intent TO runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.first_google_passkey_intent TO runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.google_account_intent TO runtime;
GRANT INSERT ON public.auth_session_revocation TO runtime;

GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime;
GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
  ON public.email_delivery TO runtime;
GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag)
  ON public.email_delivery TO runtime;
GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime;
```

Do not broaden `runtime` to provider outcomes or outbox-admission updates. Grant
database `CONNECT` and provision independently verified PgBouncer authentication
for `runtime`, `auth_mail_relay` and `auth_mail_worker`; a DSN label alone does not
prove the backend identity. See [auth mail operator notes](docs/auth-mail-operator.md)
and [personal Workspace boundary](docs/personal-workspaces.md) for the ownership,
RLS and retention contracts.

## Configure the web process

Supply configuration directly to the process. The entrypoint does not implicitly
load an existing `.env`.

Every auth-enabled web profile needs:

| Setting | Contract |
| --- | --- |
| `NODE_ENV`, `APP_ORIGIN` | External application origin; production requires HTTPS |
| `DATABASE_URL` | Exact `runtime` login through the verified transaction-mode endpoint |
| `REDIS_URL` | Authenticated database-0 limiter URL; exact shape below |
| `RATE_LIMIT_HMAC_SECRET`, `RATE_LIMIT_KEY_ID` | Dedicated limiter secret (at least 32 characters) and versioned key ID |
| `TRUSTED_PROXY_IPS` | Exact comma-separated ingress socket addresses; no CIDR or wildcard |
| `AUTH_SECRET` | Better Auth secret of at least 32 characters |

`DB_CONNECT_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`,
`DB_CLEANUP_TIMEOUT_MS` default to `2000`, `3000`, `1000`; `DB_POOL_MAX`
defaults to `10`. The corresponding Redis defaults are `2000`, `1000`, `1000`.
PostgreSQL URLs accept only no query or one `sslmode=disable|verify-full` setting.
`REDIS_URL` must use `redis:` or `rediss:`, include a hostname and nonempty
password, contain no query or fragment, and use only an empty path, `/` or `/0`.
For shape only, use `rediss://:<password>@<redis-host>:<port>/0`; every placeholder
must be replaced through the operator's credential/configuration mechanism.
The application listener defaults to `127.0.0.1:3000`; `HOST` and `PORT` are the
supported private bind settings. For the same-host loopback examples below, its
port must differ from the browser-facing `APP_ORIGIN` port so trusted ingress can
own that origin. Different hosts or namespaces still require independent external
origin and private-bind configuration, but not necessarily different numeric
ports. `REQUEST_TIMEOUT_MS` defaults to `10000` and `SHUTDOWN_TIMEOUT_MS` to
`5000`. TLS terminates at the external ingress, not the application listener.

Choose one explicit authentication profile:

### Nonproduction Google-only loopback HTTP

Use `NODE_ENV=development` and a loopback HTTP `APP_ORIGIN`. For the built local
example, keep the external origin/callback pair at
`http://localhost:3000` and
`http://localhost:3000/api/auth/callback/google`, while binding the private
application listener separately with `HOST=127.0.0.1` and `PORT=3001`. The
operator-owned ingress on port `3000` must route to that private listener and
preserve the trust/header rules below. Supply both `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`; omit all magic settings.

For Vite development, an external `APP_ORIGIN=http://localhost:5173` likewise
needs a distinct private listener, for example
`pnpm run dev --port 5174 --strictPort`, behind the operator-owned ingress on
`5173`. OAuth redirect registration always uses the external `APP_ORIGIN`, never
the private application or Vite listener port.

HTTP is accepted only for loopback outside production. Controlled protocol tests
do not authorize live Google credentials or replace a real provider ceremony.

### Conditional first passkey for an existing Google identity

This consumer requires the same still-valid application session, an existing
personal Workspace, an already-linked Google identity and zero stored passkeys.
Its additional, exact redirect is
`<APP_ORIGIN>/api/auth/first-passkey/google/callback`. The existing primary-login
redirect remains separate. Registration of this redirect and qualification of
the actual Google project require separate operator authorization.

The flow requests Google's `auth_time` claim and accepts only an actual Google
authentication less than five minutes old. Availability depends on the Google
project and returned claims; Google does not guarantee on-demand account
reauthentication. Selecting an account, consent, a newly issued token, and a
recent application session do not substitute for that proof. Missing or old
proof leaves the first key unauthorized and preserves the original session.

After the provider return, the account page checks protected intent status.
Creating the key is an explicit action; reload does not create a credential.
Cancellation affects this intent. An unconfirmed Finish must be reconciled by
its protected status read, never automatically resubmitted. Receipts are readable
for 24hours from creation; lazy per-user cleanup removes at most100 older rows
on Begin and promises no exact-time erasure. An unavailable receipt never means
that no key was added. No new worker is needed. Controlled local acceptance does
not prove real Google claim availability or physical-authenticator usability.

### Magic-enabled HTTPS

Use an HTTPS `APP_ORIGIN` behind trusted TLS ingress. Supply all three web-side
magic settings:

- `AUTH_MAIL_KEY_ID` and `AUTH_MAIL_KEYS_JSON`: the dedicated AEAD keyring and
  current ID; each base64 value decodes to exactly 32 bytes;
- `AUTH_MAIL_PROFILE_JSON`: the immutable `MailProfile` with `appOrigin`,
  `apiOrigin`, `projectId`, `credentialId`, `from:{name,email}`, `reply` and
  `replayWindowSeconds`.

The profile's `appOrigin` must exactly equal `APP_ORIGIN`; both it and the approved
mail API origin must be HTTPS. Keep `replayWindowSeconds:null` until the selected
provider project's idempotency retention is observed and approved. Google remains
optional in this profile and is enabled only when both Google client values are
present. Any partial Google or magic configuration fails startup.

Ingress must reject direct access to the application listener and overwrite
`x-real-ip` with exactly one address. The application verifies the ingress socket
against `TRUSTED_PROXY_IPS`; direct browser access to the listener is not a
qualified trusted-ingress path. Auth POSTs are same-origin protected. This
repository does not provide or qualify a proxy/certificate installation recipe.

## Configure the mail worker

The worker receives the same `AUTH_MAIL_KEY_ID` and `AUTH_MAIL_KEYS_JSON` needed
to decrypt existing snapshots, plus these worker-only values:

- `AUTH_MAIL_RELAY_DATABASE_URL` and `AUTH_MAIL_WORKER_DATABASE_URL`, using the
  two distinct non-owner logins;
- `AUTH_MAIL_API_ORIGIN`, `AUTH_MAIL_PROJECT_ID`,
  `AUTH_MAIL_CREDENTIAL_ID` and the scoped `AUTH_MAIL_PLUNK_SECRET`;
- `HATCHET_CLIENT_TOKEN`, `HATCHET_CLIENT_HOST_PORT`,
  `HATCHET_CLIENT_API_URL` and `HATCHET_CLIENT_TLS_STRATEGY=tls`; and
- `NODE_ENV=production` plus the applicable bounded `DB_*` settings.

The binding values must exactly match the immutable web-created snapshot. Only the
worker receives the relay/worker DSNs, Plunk secret and Hatchet binding. It does not
need `AUTH_SECRET`, Google client values or `AUTH_MAIL_PROFILE_JSON`; the web does
not receive worker database, Plunk or Hatchet credentials. The worker entrypoint
also does not load an existing `.env`.

The current pinned worker accepts Hatchet V1 with engine `v0.101.27`. `tls` is the
normal strategy; `none` is limited to an explicit test-only loopback process and
is not a deployment fallback.

## Start the two processes

After build, migration, grants and process-local configuration, start web and
worker as separately owned processes:

```text
pnpm start
```

```text
pnpm start:worker
```

`pnpm start` runs only `.output/server/index.mjs`; `pnpm start:worker` runs only
`.output/worker/index.mjs` and exposes no web listener. Google-only use does not
need the mail worker. A magic-link request can be created by the web, but durable
delivery requires the separately configured worker.

`GET /health/live` reports only process liveness. `GET /health/ready` covers the
web's startup store/role/Workspace checks and current admission state; it does not
probe idle connections, providers, inbox delivery or product readiness.

## Runtime boundaries

Google code exchange is fixed to `https://oauth2.googleapis.com/token` with native
certificate and hostname verification, at most four admitted exchanges per auth
instance, no queue and no application retry. The request lifetime carries the
ingress deadline and cancellation signal; cancellation destroys owned
DNS/request/socket work, and auth shutdown closes admission and joins admitted
exchanges. This is transport ownership, not a whole-server drain. Networks that
require a proxy, custom resolver or hosts override are not qualified.

The local mail qualification covers the real SQL snapshot, controlled TLS,
pinned native engine, bounded retry/recovery/exhaustion history and owned worker
shutdown. It does not prove provider retention, inbox receipt, external delivery,
production monitoring, arbitrary churn/scalability or a hard process-stop bound.
Unknown provider outcomes remain governed by stored database replay authority;
finite retry exhaustion remains a failed run, not guaranteed delivery. The
operator note defines the remaining tombstone, audit and external-provider gates.

## Repository verification

The ordinary source checks are separate from the real-store suite:

```text
pnpm test
pnpm typecheck
pnpm test:integration
```

Run `pnpm build` first. Browser tests additionally require
`pnpm exec playwright install chromium`; TLS fixtures require OpenSSL. The
integration suite requires the local `desktop-linux` Docker Desktop context and a
Linux/amd64 engine, creates only labeled disposable PostgreSQL `16.15`, PgBouncer
`1.25.2`, Redis `7.2.16`, Node `24.14.0` and Hatchet resources, and reads no
existing `.env`. These fixtures are local evidence, not a supported deployment
topology.

### Explicit Google linking and local unlinking

The account page exposes a separate Google connection control for an active
session with an existing personal Workspace and passkey. Linking verifies that
key, then requests Google's account chooser with the existing scopes. Its exact
additional redirect is `<APP_ORIGIN>/api/auth/account/google/callback`; register
it only in the separately authorized Google project/environment. Primary login
and first-passkey redirects remain separate. Provider email never selects or
merges a local User, and this operation stores only the provider subject binding.

Unlinking verifies a surviving passkey and deletes the exact local Account row.
It works without Google credentials and does not revoke Google consent. A result
lost in transit can be checked through the operation selector on the account
page; do not automatically resend an uncertain operation. Historical receipts
last 24 hours from creation for the still-valid original session, independently
of subsequent connection changes. The schema requires migration
`0010_google_account`; apply migrations only to the intended environment.

This consumer is undergoing local native/browser qualification. Source tests and
generated schema do not prove real Google chooser behavior, physical passkeys,
genuine BFCache or screen-reader speech. No workstation checkout, Oracle, or
`.codex` directory is required by the application.

### Fresh-passkey session controls

The account page provides explicit passkey verification to view sessions, move
to another page, refresh, or revoke one selected other session. It returns only
the session ID, current-session marker, creation time, last activity and effective
expiry. The current session uses the existing Sign out action. These commands
validate the native cookie without cache or refresh and leave the authorizing
session unchanged; ordinary account-page activity remains a separate existing
activity update. An otherwise valid ACTIVE session can use these controls during
the recovery hold; recovering/restricted/stale-generation sessions cannot.

Migration `0011_session_management` adds a minimal atomic revocation fact.
The web role needs only `INSERT` on this table, never `SELECT`, `UPDATE` or
`DELETE`; insertion failure rolls back revocation and proof consumption. Its
copied identifiers have no parent FK and survive User/Workspace closure without
automatic expiry. Continuing storage and linkability costs require a
product-specific retention/governance decision before production adoption.
See [personal Workspace boundary](docs/personal-workspaces.md).

A lost revocation response stays unconfirmed. A deliberate new passkey
verification checks that exact session independently of the visible page:
absent, still active, or existing but ineligible. Absence does not prove which
earlier request removed it. No automatic resend or historical receipt is used.
Each authenticated Begin opportunistically cleans at most100 expired physical
verification rows in this User's namespace, deleting only valid singletons and
skipping duplicate/malformed groups. There is no wall-clock purge guarantee for
inactive Users. Native local qualification and the account UI/browser gates are
tracked separately; this feature does not complete the remaining auth lifecycle.

### Internal recovery code and linked Google proof

Migration `0012_recovery_admission` adds current code batches, one-way code
digests, bounded Google attempts and an insert-only rotation fact. The four
commands are available only through the application auth factory's private
invocation. No route or UI publishes them. The fixed future callback spelling
is `<APP_ORIGIN>/api/auth/recovery/google/callback`; an internally constructed
URL does not establish provider registration or a browser flow.

The migration grants `runtime` only SELECT/INSERT/UPDATE/DELETE on the three
operational recovery tables and INSERT on the fact. The fact has no parent
foreign keys and follows the existing no-auto-expiry audit baseline described
in [personal Workspace boundary](docs/personal-workspaces.md). Runtime cannot
read or purge it. A future privileged, narrowly scoped data migration under
the migration principal may remove it only after a separate retention decision;
there is no current purge API or legal retention period. Storage and linkable
identifiers continue to accrue. Operational code/attempt cleanup is bounded to
admitted User-locked Begins and gives no exact erasure time.

Code rows reference the current batch with NO ACTION on update/delete. Rotation
deletes that User's old code rows before replacing the batch. Any later User
closure must likewise delete code rows before the batch/User; the User cascade
alone cannot be assumed to perform that order. This internal increment stops at
one unused Google proof: it does not spend a code, consume the proof, create a
recovery session, enter PREPARED/Activation, or complete recovery.

## Remaining gates

- Task 9: linked-passkey assertion for protected security actions, explicit
  linking/purpose grants and selected complete TOTP.
- Task 10: recovery, session/account lifecycle and personal closure while
  preserving the documented Workspace audit-survival rule.
- Task 11: complete auth UX and integrated portable acceptance.
- External acceptance: physical authenticators, other browsers/devices, native
  zoom, live Google, Plunk, SES, inbox and operator-owned infrastructure checks.
- Full template: organizations/B2B, Stripe commerce and reusable derivations.

Completing this setup or these three local journeys does not waive any of those
gates or make this candidate a ready SaaS template.
