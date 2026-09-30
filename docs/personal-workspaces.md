# Personal Workspace boundary

Status: personal Workspace creation, read, rename, reload and process-restart
persistence are locally qualified through the current authenticated application
consumer. This is a completed personal-Workspace slice, not organization/B2B or
full-template readiness.

This slice provides explicit POST provisioning, read and rename on the existing application transaction owner. An initial GET lookup does not create a Workspace. The default stored name is `Workspace`; rename trims a single line and permits at most80 JavaScript UTF-16 code units. SQL independently requires a nonempty bounded name and rejects controls and line separators. Values are rendered as escaped text.

Better Auth validates the cookie and returns the exact session ID to the private principal reader. Public account DTOs contain only userId, name and email. Every Workspace handler obtains its principal again; actor/session IDs are never accepted from a form. The same physical transaction locks User, exact Session, then Workspace, revalidates state/generation/expiry using a current database-time sample, resolves authority under the sentinel, selects and verifies the tenant setting, and re-reads the active owned Workspace before exposing its store. Auth/tenant scope nesting and changed personal-session nesting fail closed.

Before the one-shot migration sequence, the operator must provision
`workspace_owner` and `workspace_bootstrap`. Both are `NOLOGIN`, `NOINHERIT`,
`NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE` and `NOREPLICATION`,
without memberships in either direction. The exact web login `runtime` must also
already exist as a non-owner `LOGIN` with `NOINHERIT`, `NOSUPERUSER`,
`NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE` and `NOREPLICATION`, and it may not
have membership involving either Workspace role. Migration `0004` validates the
two Workspace roles and requires `runtime` to exist for its policies and grants;
web readiness validates the exact login, attributes and memberships. Neither path
creates or repairs production roles. The disposable fixture alone creates them
locally.

Migration `0004` grants `runtime` schema usage, the exact bootstrap function's
`EXECUTE`, selected-tenant `SELECT`, display-name/update-time `UPDATE` and audit
`INSERT`. It grants the bootstrap role only the table authority used inside that
function. Workspace tables use FORCE RLS. The bootstrap definer is not their
owner, its qualified function pins `search_path` to `pg_catalog,pg_temp`, and
PUBLIC `EXECUTE` is revoked. On stock PostgreSQL, the required schema creation and
ownership transfers under the no-membership rule require an operator-supplied
superuser for the one-shot migration; an ordinary database owner or `CREATEROLE`
login is insufficient. A platform-specific identity may substitute only when the
operator independently proves equivalent transfer authority without prohibited
membership. No managed-service equivalent is assumed or qualified, and this
elevated principal never belongs in the web or worker process.

Custom transaction-local GUCs guarantee lifetime, not authenticity against arbitrary SQL already running as the same runtime role. The accepted boundary is the confined application operation plus SQL revalidation and least privileges; this is not an arbitrary-SQL sandbox. The function rejects absent/wrong tenant context, absent/malformed correlation and invalid authority. A same-role arbitrary SQL caller with valid arguments can reproduce those custom settings; no stronger claim is made.

Provisioning inserts exactly one `personal-created` fact in the winning insertion branch. A changed name inserts `display-name-changed` in the same transaction; unchanged names and refused requests add no success fact. Audit failure rolls the mutation back. Facts contain only fixed action, copied actor and Workspace IDs, server-generated correlation UUID and database time, plus their own row UUID. No names, emails, sessions, tokens or free-form payloads are copied.

Audit identifiers deliberately have no parent foreign keys: future personal closure can delete Workspace/User rows without silently erasing the facts or encountering an audit FK restriction. Facts are append-only, and this baseline has no automatic expiry or cascade deletion. They remain stored until a separately explicit module-owned retention operation is adopted. This has continuing storage cost and retains linkable identifiers; product-specific retention and governance remain requirements before production adoption. Task10 must preserve this survival rule. This current slice introduces no purge API, service or scheduler and claims no legal retention period or legal-compliance status.

This personal slice does not implement organizations, membership, invitations or
B2B ownership. Local controlled Google and magic/browser evidence is not a live
Google provider ceremony, physical-authenticator matrix or external mail/inbox
acceptance. Task 9 still owns linked-passkey protected actions/linking and selected
complete TOTP. Task 10 owns recovery, session/account closure and the retention
decision that must preserve the audit-survival rule above. Task 11 owns complete
auth UX and integrated portable acceptance. B2B, Stripe and reusable derivations
remain full-template gates.

## Session revocation facts and existing Workspace authority

The session-management consumer resolves an already-existing active personal
Workspace with the same owner and `create_if_missing=false`; it never provisions
one. Each list/page/reconciliation or exact other-session revocation requires a
fresh signed passkey verification bound to the original native session, User,
Workspace and generation. Its local authority reads do not touch or renew the
original session. Ordinary account-page activity outside those commands may
still update last activity. Current ACTIVE authority may use these controls
during holdUntil; recovering, restricted, expired and stale-generation authority
remain refused.

After migration `0011_session_management`, grant only:

```sql
GRANT INSERT ON public.auth_session_revocation TO runtime;
```

No runtime read/update/delete grant is needed for this minimal append-only fact.
RLS permits insertion only in auth-global scope, and the fact is inserted after
the exact native deletion is established, under the same transaction. A failed
or vetoed audit insertion rolls the deletion and proof/counter changes back.
The fact copies actor, authorizing-session, target-session and Workspace IDs,
plus its own UUID, correlation UUID and database time; it stores no token,
assertion, IP/UA or provider data.

These identifiers intentionally have no parent FK. Future User/Workspace
closure must preserve these facts alongside workspace_audit. There is no
automatic expiry, cascade, purge API or scheduler in this slice. Continuing
storage and linkability costs, and a product-specific retention/governance
decision before production, remain explicit requirements; no legal period or
compliance result is claimed.
