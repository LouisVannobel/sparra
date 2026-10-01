# Native Voice bridge qualification

Status: implementation under qualification. No shared/live migration, provider
acceptance, connected writer/browser overflow acceptance or production readiness
is implied by this document.

The App's immutable migrations0000–0015 remain unchanged. Generated forward0016
is the canonical procedural function source; the consumed Drizzle definitions
and snapshot describe its product/private tables and policies.

## Operator provisioning

Before applying0016, the operator must create `sparra_voice_definer` with exactly
NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE and
NOREPLICATION, with no incoming or outgoing role memberships. The migration
checks this prerequisite. Only owned disposable tests create fixture roles.

For each deployment, provision a distinct constrained service LOGIN through the
operator's existing secret handling process. Never grant it role memberships.
As administrator, insert its binding into `voice_private.deployment_binding`
using the catalog OID of that exact role and the already-existing Workspace:
`service_login`, `service_role_oid`, `deployment_id`, `workspace_id`,
`connection_id`, `to_e164`, `admission_enabled`, and `audio_enabled=false`.
The identity tuple is immutable. Renaming or dropping/recreating the role does
not inherit the binding. Reassignment requires a new login/deployment identity.

For the example operator-selected role `sparra_voice_pilot`, grant only:

```sql
GRANT USAGE ON SCHEMA voice TO sparra_voice_pilot;
GRANT EXECUTE ON FUNCTION voice.begin_call_v1(text,uuid,jsonb) TO sparra_voice_pilot;
GRANT EXECUTE ON FUNCTION voice.ingest_operation_v1(jsonb) TO sparra_voice_pilot;
GRANT EXECUTE ON FUNCTION voice.lease_recording_purge_v1(text,integer,integer) TO sparra_voice_pilot;
GRANT EXECUTE ON FUNCTION voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz) TO sparra_voice_pilot;
GRANT EXECUTE ON FUNCTION voice.lease_call_erasure_v1(text,integer,integer) TO sparra_voice_pilot;
GRANT EXECUTE ON FUNCTION voice.ack_call_erasure_v1(uuid,uuid,timestamptz) TO sparra_voice_pilot;
```

Grant no public/private table privileges, auth/resolver function privileges,
schema creation or role membership. The migration cannot enumerate arbitrary
future service-login names, and exposes no runtime provisioning function.
The pool must preserve PostgreSQL `session_user`; a forced shared backend user
cannot implement these bindings. Owned tests use the existing transaction-mode
PgBouncer with two separately authenticated logins.

## Native behavior to qualify

All six entrypoints resolve `session_user` plus its catalog role OID, then lock
the physical Workspace before call/cleanup state. Their private policy helpers
read binding only; no caller tenant setting supplies machine authority. Only
the existing OLD-derived erase trigger temporarily receives a SQL-derived local
tenant setting, restored within the transaction.

Begin alone pins a business revision. Thirty-day retention derives from original
admission. New admission allows at most300seconds of age and30seconds in the
future. A committed pin is retried with the same call/routing. No SQL provider
I/O or result production occurs.

The ingest digest is SHA256 over UTF8 PostgreSQL JSONB text of the complete
operation, including original nullable fields and only present optional fields.
It is not the SQLite compact command digest. The ledger stores scope, IDs,
digest and time boundaries, never the operation body. Authority and strict form
validation precede receipt lookup. Aggregate encrypted turns remain bounded by
actual `octet_length(encrypted_turns::text)<=524288`; overflow is atomicPV202.
Durable per-call loss is monotone and independently consumed by the native Node
decoder/DTO and FR/EN request detail.

Both ack functions return SQL NULL, tested with `IS NULL` in addition to Python
None shape checks. Exact successful token/outcome/time replay is retained until
the cleanup replay boundary. A failed recording acknowledgement never completes
erasure. Local cleanup and all known remote obligations must join before public
completion; late real recording identities requeue the fence. Cleanup identities
survive call deletion and remain when admission is disabled or Workspace is
deleting. Audio-off facts create no fabricated recording lease.

## Owned commands and external boundary

```text
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-voice-bridge.test.ts --maxWorkers=1
pnpm exec vitest run tests/sparra/message-crypto.test.ts tests/ui/sparra-panels.test.tsx --maxWorkers=1
pnpm typecheck
```

The integration driver pins Python3.13.15 and checks installed package pins,
imports actual Voice models and PsycopgOperationSink with bytecode disabled,
uses stdin for generated fixture credentials and never reads an existing.env.
Native owner reads use Better Auth's admitted Google protocol fixture and the
existing personal Workspace transaction. One owned fixture/worker and one heavy
command at a time; gate heavy runs on2GiB physical/6GiB virtual, lightweight checks
on2GiB/2GiB. Record actual output, resource samples and owned cleanup in the task
report. The real writer's durable drop decisions and compiled browser overflow
witness belong to the subsequent connected qualification tasks.
