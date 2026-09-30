# Authentication Storage Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. The application root/schedule is adopted; this is source work inside it, not a new approval gate.

**Goal:** Deliver the concrete PostgreSQL authentication schema and migration artifact needed by the next real session reader, without pretending a database or login exists.

**Architecture:** Four Better Auth base models plus the already-specified private admission/recovery fields, expressed directly in Drizzle. A small typed Better Auth schema-options fragment describes those fields; it neither starts auth nor supplies a placeholder database. The actual SDK metadata/serialization boundary and the generated migration are checked separately from future live-PostgreSQL enforcement.

**Tech Stack:** Existing Node24.14.0/pnpm10.32.1/TypeScript7.0.2/Effect4.0.0-rc.111/Vitest4.1.11; add exact better-auth1.7.1, drizzle-orm0.45.2, pg8.23.0; dev drizzle-kit0.31.10 and @types/pg8.23.1. Better Auth's Drizzle adapter is1.7.1, not0.45.2. Use its bundled adapter dependency only when the actual facade consumer arrives; no duplicate direct adapter package is needed for this schema task.

**Spec:** docs/design/BOILERPLATE_DESIGN.md §§5,6,8.5,8.6,12; docs/design/APPLICATION_DELIVERY_CONTINUATION.md A; source evidence .superpowers/sdd/auth-workspace/entry-contract.md.

## Global constraints

- No Docker/WSL/service start, database connection, migration application, existing DB/credential use, provider call, .env read/write, remote/push/deployment/infra/CI change. Docker operator permission is pending, not inferred.
- No configured or accepted session, real session-reader result, working auth route, transaction correctness or live constraint enforcement is claimed by this task.
- Use direct typed Drizzle models, no schema generator framework, custom BA adapter, fake auth factory, empty worker/pool, or raw drizzle(pool).transaction.
- Better Auth owns its base model semantics. Effect Schema remains the only application runtime validator; upstream SDK internals are not a second app validation stack.
- TypeScript property keys stay the SDK's camelCase names; SQL column names may be snake_case through Drizzle. Do not set Better Auth fieldName aliases that no longer match the Drizzle property keys.
- A capability not selected is not mounted. Password remains absent, despite the nullable SDK compatibility column. No organization/Workspace/billing/SSO/Redis tables are added preemptively.
- One code writer, tests before source, actual focused verification, independent review, exact pins and one normative typecheck. No handwritten broad casts or synthetic accepted-session proof.

## Task 1: Authentication models, generated migration and first-consumer guard tightening

**Files:**
- Add src/modules/auth/schema-options.server.ts and src/modules/auth/schema.server.ts.
- Add drizzle.config.ts and generated drizzle/ migration SQL plus metadata.
- Add tests/auth/schema.contract.test.ts.
- Modify package.json/lock, tsconfig.json (include the real Drizzle config), vite.config.ts and README.md.
- Modify only the two existing assertion areas in tests/platform/web.test.ts for Oracle M2.
- The existing __root.tsx may be temporarily changed for the two Oracle M1 negative-build experiments, but must be byte-restored before final verification/commit. No permanent route change.

**Interfaces:**

```ts
// schema-options.server.ts
import type { BetterAuthOptions } from 'better-auth'
export const authSchemaOptions = {
  user: { additionalFields: {
    recovering: { type: 'boolean', required: true, defaultValue: false, input: false, returned: false },
    recoveryGeneration: { type: 'number', required: true, defaultValue: 0, input: false, returned: false },
    holdUntil: { type: 'date', required: false, input: false, returned: false },
  } },
  session: { additionalFields: {
    authState: { type: ['ACTIVE', 'MFA_PENDING', 'RECOVERY_RESTRICTED'], required: true, input: false, returned: false },
    authMethod: { type: ['google', 'magic-link', 'passkey', 'totp', 'recovery'], required: true, input: false, returned: false },
    authenticatedAt: { type: 'date', required: true, input: false, returned: false },
    providerIdentity: { type: 'json', required: false, input: false, returned: false },
    recoveryGeneration: { type: 'number', required: true, input: false, returned: false },
    lastActivityAt: { type: 'date', required: true, input: false, returned: false },
  } },
} satisfies Pick<BetterAuthOptions, 'user' | 'session'>

// schema.server.ts exports the four real pgTable values, and their direct map:
export const authSchema = { user, session, account, verification }
```

The exported Drizzle map contains the four concrete pgTable values below, not an interface-only placeholder. Do not add a betterAuth() instance or database factory in this task.

**Required models:** all base fields from the exact SDK getAuthTables output, including id primary keys and timestamps. user: required name/email, unique email, emailVerified false, nullable image. session: required userId FK to user with cascade, expiresAt, unique token, nullable ipAddress/userAgent. account: required issuer/accountId/providerId/userId, unique(issuer,accountId), user FK cascade, nullable accessToken/refreshToken/idToken and expiry fields/scope/password. verification: required identifier/value/expiresAt. Preserve the SDK's session.userId/account.userId/verification.identifier indexes. Use timestamptz with millisecond precision and Date mapping; no local-time timestamps. Required created/updated timestamps have appropriate default-now/update behavior, not a dummy fixed date.

**Private field table:** every field has input:false and returned:false in the SDK options. SQL columns and the options must agree on required/nullability and defaults.

| Model.field | SDK/SQL kind | Required/default |
|---|---|---|
| user.recovering | boolean | required,false |
| user.recoveryGeneration | number/integer | required,0; SQL CHECK >=0 |
| user.holdUntil | date/timestamptz | nullable,no default |
| session.authState | enum text ACTIVE/MFA_PENDING/RECOVERY_RESTRICTED | required,NO default; SQL CHECK enum |
| session.authMethod | enum text google/magic-link/passkey/totp/recovery | required,NO default; SQL CHECK enum |
| session.authenticatedAt | date/timestamptz | required,NO default |
| session.providerIdentity | json/jsonb | nullable,no default; Google admission will own the issuer/subject value |
| session.recoveryGeneration | number/integer | required,NO default; SQL CHECK >=0 |
| session.lastActivityAt | date/timestamptz | required,NO default |

No default ACTIVE, fabricated method or generation fallback for session creation: an unwrapped creator must not insert an authorizable session. Keep BA base fields outside tenant RLS; Workspace/RLS comes with its real consumer. Do not invent date-order/JSON-provider constraints not yet justified by the admission contract. The required nullable account.password column is compatibility storage only; add CHECK password IS NULL because password authentication is explicitly excluded. This does not enable its route or a credential provider.

- [x] **Step 1: Add the exact local dependencies and write failing contract tests.** Use installed getAuthTables/getAuthTablesWithResolvedIndexes and SDK output parsing from better-auth/db, plus Drizzle getTableConfig. These tests validate the model/config boundary supplied to real libraries, not database behavior. Expectations must be literal/independent of authSchemaOptions; deriving both expected and actual from the same descriptor is forbidden. Cover every private field's required/default/input/output contract, required issuer and composite uniqueness, FKs/indexes, timezone-aware dates, absent password storage and no permissive session defaults. A test fixture for SDK output filtering is not an accepted session or authentication proof.

Representative test shape:

```ts
const tables = getAuthTables(authSchemaOptions)
expect(tables.account.fields.issuer.required).toBe(true)
expect(tables.session.fields.authState).toMatchObject({ required: true, input: false, returned: false })
expect(tables.session.fields.authState.defaultValue).toBeUndefined()
// Independently match Drizzle metadata's required authState column, absent
// default, and the declared literal enum constraint. Do not grep source files.
```

Use the real SDK output parser on complete literal User/Session serialization fixtures containing marker values in the private additional fields; assert those fields are removed. Do not label that output as validated auth, and do not assume the base session token is safe to expose through TanStack. The later reader must project a minimal DTO.

- [x] **Step 2: Observe the focused missing-feature RED, then implement only these concrete models/options.** The SDK schema contract is in core/src/db/get-tables.ts and its base schemas. The initial SourceManifest/probe code is evidence, not production code to transplant. Do not install a second validator or a BA CLI merely to write four tables.

- [x] **Step 3: Generate the real Drizzle migration without a connection.** A minimal drizzle.config.ts uses defineConfig with dialect:'postgresql',schema:'./src/modules/auth/schema.server.ts',out:'./drizzle'; no dbCredentials or environment loader. Add db:generate invoking drizzle-kit generate; run with --name auth_storage. Review the complete generated SQL and metadata, correcting the source models and regenerating if necessary. Do not hand-maintain a parallel SQL schema, connect to a server, or execute migrate/push. Live fresh-DB/constraint enforcement remains explicitly unperformed.

- [x] **Step 4: Fold in the already-reviewed Oracle M1/M2, without a separate platform.** Add client.specifiers:[/^effect(?:\/|$)/] to native TanStack importProtection, retaining its defaults/error behavior. Before the guard, exercise retained runtime imports from effect and effect/Schema in the actual client root and observe the missing enforcement; after the guard, require the specific native import-protection failure. Restore the root byte-exact and rebuild positively. Record the same existing manual negative-build method; don't add a source-mutating test runner or a generic sandbox builder.

For M2, assert Allow: GET, HEAD on the existing405 HTTP response. Change the disposal fixture's cancel callback to complete asynchronously behind a test-owned deferred promise; prove the response promise does not resolve before cancellation is released/completed. This strengthens an already-correct behavior, not a new production feature. A short controlled mutation removing the await, then restoring source, may demonstrate test sensitivity; no production server change is requested or committed.

- [x] **Step 5: Verify and commit the real source increment.** Run focused schema contracts, the complete current suite, production build before any artifact-based tests, normative typecheck, and diff-check. Preserve warnings and limits. Confirm schema modules/Better Auth/Drizzle/pg are not in the actual client graph; use existing native protection and the existing output inspection method, not a new verifier. All source/root/server experimental mutations must be restored. Commit only the listed durable files. README states schema/migration generation is implemented but no DB has been created/migrated and auth/session/Workspace is not available. Write actual commands/RED/GREEN/migration review/commit/limits to the ignored task report, then stop for independent review. No Oracle or subagents from the implementer.

## Source increment closure

Implemented at a15987b6c619ae3d04b4472cbfa2cbbe9860fcf3ccc79bfc4aa0d9aa0d905c74. Independent spec/quality review approved with no Critical/Important findings; Oracle app-auth-storage-20260910 returned APPROVE STORAGE SOURCE INCREMENT, P0=0/P1=0. Main independently verified production build,131/131 tests, normative typecheck, synchronized generation, original experimental-file hashes and the actual client chunk graph (97modules; no config/startup/auth-schema/BetterAuth/Drizzle/pg/Effect matches).

Non-blocking retained work: strengthen a few Drizzle metadata assertions at the next auth-schema consumer (email/token uniqueness, actual FK target, required base columns, rendered now() and clock-sensitive update callbacks). One moderate transitive esbuild advisory remains documented; its serve path is not shown reachable in current offline generation, and no audit suppression/untested override was added. Neither review qualifies a database, transaction, login, accepted session, Workspace, UI or complete template. Continue with the physical PostgreSQL lease, then real shared coordinator/BetterAuth delegation and live gates.
