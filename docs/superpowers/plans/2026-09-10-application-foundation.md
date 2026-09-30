# Application Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. The root and application schedule are already adopted; do not request another approval.

**Goal:** Start the actual application with tested, server-only startup configuration, followed by its real Node web runtime. This foundation is an increment of A, never completion of the full template or auth milestone.

**Architecture:** One private pnpm package in the new local repository. Configuration is a small pure server module consumed by the web entry; framework/runtime resources are acquired only by their owner. No PREP controller, generic configuration service, provider access or empty worker.

**Tech Stack:** Node 24.14.0, pnpm 10.32.1, TypeScript 7.0.2, Effect 4.0.0-rc.111, Vitest 4.1.11; exact web pins are established by the real runtime integration task.

**Spec:** docs/design/BOILERPLATE_DESIGN.md §§3,8,10,12; docs/design/APPLICATION_DELIVERY_CONTINUATION.md A and code slices; docs/design/UI_DESIGN_SYSTEM_DECISION.md.

## Global Constraints

- One package and lockfile; no CI/CD, infra, deployment, remote repository or global install.
- Exact dependency pins. Effect Schema is the sole application runtime validator. One normative typecheck, no broad casts.
- No fake authentication, placeholder product route, empty worker, generic repository/service, secret output or PREP framework.
- First-consumer bounds are positive and finite. Build/config passing does not prove security, provider, auth or template readiness.
- Source and test edits use apply_patch. One implementer writes at a time. Run focused RED/GREEN then independent spec/quality review.
- Use local installed Node/pnpm; dependency resolution may access the public npm registry, not any private credentials. No .env reads or writes in this task.

## Preflight

The repository is new, isolated on codex/application-foundation, with no prior application/tests. Documentation baseline is85aac482a3a7307f64dad4601cfd48b7088e78fa9461daca7945349edf2d524e. Existing imported design has intentional Markdown hard-break whitespace and one historical EOF blank line; do not normalize historical source solely for a lint aesthetic. New source diffs must pass diff-check.

The startup configuration task produces the exact typed values the web entry will consume. It adds no hypothetical DB/provider settings. The runtime-entry investigation determines the maintained Node adapter and output format; no empty adapter is written here. Full auth/persistence/Astryx plus B-E remain tracked in the delivery ledger.

### Task 1: Validate the web process configuration without leaking input

**Files:**
- Create `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`.
- Create `src/platform/config.server.ts`.
- Test `tests/platform/config.test.ts`.
- Create/update `README.md` only for actual commands and current limits.

**Interfaces:**

```ts
export type WebConfig = Readonly<{
  environment: 'development' | 'test' | 'production'
  origin: string
  hostname: '127.0.0.1' | '::1' | '0.0.0.0'
  port: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
}>
export function readWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig
export class ConfigurationError extends Error {
  readonly invalidKeys: readonly string[]
}
```

No process.env read, network, filesystem, listener or runtime acquisition at module import. `readWebConfig` reads only the supplied map, does not mutate it, returns a frozen object, and throws ConfigurationError with invalid key names only. The error message/cause/serialized fields must not retain rejected values or the env map.

The finite input table is:

| Input | Default when absent | Accepted values |
|---|---|---|
| NODE_ENV | development | exact development, test, production |
| APP_ORIGIN | none, always required | bare http(s) origin; no credentials/query/fragment or non-root path; no leading/trailing whitespace; canonical URL.origin output |
| HOST | 127.0.0.1 | exact 127.0.0.1, ::1, 0.0.0.0 |
| PORT | 3000 | canonical unsigned decimal 0..65535; 0 requests an OS-assigned port, not a test-only bypass |
| REQUEST_TIMEOUT_MS | 10000 | canonical decimal integer1..30000 |
| SHUTDOWN_TIMEOUT_MS | 5000 | canonical decimal integer1000..30000, exact multiple of1000 |

APP_ORIGIN must use HTTPS except HTTP with the literal authority hostname localhost,127.0.0.1 or [::1] in development/test (case-insensitive localhost). Reject alternate/shortened numeric IPv4, encoded hostname and expanded IPv6 spellings for this HTTP exception before URL normalization; intended scheme/hostname case and valid-port canonicalization remain allowed. Production rejects HTTP even on loopback. Reject empty explicit settings; reject NaN, Infinity, floats, signed/hex/scientific numeric strings, leading zeroes except literal0, whitespace and unsafe integers. An origin with normalized-away syntax such as /a/.. must not be admitted as a bare origin. The web entry will bind HOST/PORT independently from its externally advertised origin; this supports normal TLS termination without granting trust to forwarded headers.

Unknown unrelated environment keys are ignored, never echoed. Malformed known keys produce deterministic invalidKeys in input-table order. Do not add a schema registry or one service per env variable; use the installed Effect Schema APIs and a small direct function.

Consumer ruling: the selected Nitro Node adapter currently delegates to srvx1.0.4, whose released graceful-shutdown plugin parses SERVER_SHUTDOWN_TIMEOUT as whole seconds. Admit only whole-second shutdown budgets, represented in milliseconds above, rather than promising unsupported sub-second precision or building a signal framework. REQUEST_TIMEOUT_MS remains1..30000. Tests must reject shutdown1,999,1001,1500,30001 and accept1000,5000,30000. This replaces the initial proposed1ms minimum before runtime integration; the product design requires positive finite bounds, not sub-second process grace.

- [x] **Step 1: Set up the local test/compiler graph and write the failing behavior tests.** Package private=true,type=module,engines node=24.14.0/pnpm=10.32.1,packageManager=pnpm@10.32.1. Direct dependency effect=4.0.0-rc.111; devDependencies typescript=7.0.2,vitest=4.1.11,@types/node=26.3.0 (the previously verified tooling baseline; do not use Node>24 runtime APIs). `test` is `vitest run --maxWorkers=1`; `typecheck` is `tsc --noEmit`. Strict compiler, no emit, ES2022, Bundler/ESNext, include src/tests and Vitest config. Do not enable verbatimModuleSyntax for the future TanStack client graph. Use pnpm default dependency-script blocking; do not approve arbitrary build scripts or globally install anything.

Representative required tests, extend with literal rows from the table above:

```ts
import { expect, test } from 'vitest'
import { ConfigurationError, readWebConfig } from '../../src/platform/config.server'

test('returns bounded startup settings without mutating the supplied environment', () => {
  const env = Object.freeze({ APP_ORIGIN: 'https://template.example' })
  expect(readWebConfig(env)).toEqual({
    environment: 'development', origin: 'https://template.example',
    hostname: '127.0.0.1', port: 3000, requestTimeoutMs: 10000,
    shutdownTimeoutMs: 5000,
  })
  expect(Object.isFrozen(readWebConfig(env))).toBe(true)
})

test.each(['0', '-1', '1.5', '1e3', '010', 'NaN', '30001', ' 10'])('rejects request timeout %s', value => {
  expect(() => readWebConfig({ APP_ORIGIN: 'https://template.example', REQUEST_TIMEOUT_MS: value })).toThrow(ConfigurationError)
})

test('does not preserve a rejected credential value in its error', () => {
  const secret = 'must-not-appear-in-any-error-field'
  try {
    readWebConfig({ APP_ORIGIN: `https://user:${secret}@template.example` })
    expect.unreachable('credential-bearing origin was accepted')
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    const configError = error as ConfigurationError
    expect(configError.invalidKeys).toEqual(['APP_ORIGIN'])
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(configError.cause).toBeUndefined()
  }
})
```

Also cover valid lower/upper bounds, missing/empty inputs, all env modes, loopback versus non-loopback HTTP, credentials/path/query/fragment/normalized dot segments, invalid host, stable combined errors, unrelated secret key ignored, and canonical scheme/host casing. Assert accepted values, not just no-throw. Do not test the text of the implementation.

- [x] **Step 2: Observe the focused RED.** Install the exact local dependencies and run `pnpm test tests/platform/config.test.ts`. Record the actual missing-feature failure before production implementation. A setup/tool-resolution problem does not qualify as RED; fix only the tool setup if necessary. No production stub or fake success remains in the task.

- [x] **Step 3: Implement the direct server configuration function with Effect Schema and sanitized errors.** Use `Schema.decodeUnknownSync` against the installed version's appropriate string/literal/number checks. Validate lexical URL and decimal constraints before their normalizing constructors; catch schema failures into key names, not nested raw schema errors. URL parsing is not a second validation framework. No broad cast or generic env loader.

- [x] **Step 4: Run focused GREEN, full current tests and normative typecheck.** Run `pnpm test tests/platform/config.test.ts`, `pnpm test`, `pnpm typecheck`, `git diff --check`. Record actual commands/results, dependency warnings and pin changes. Confirm no .env or provider/network call was made by module evaluation or tests.

- [x] **Step 5: Commit only this task's changed files and hand off.** README states this is the first configuration component, not a working SaaS or completed web runtime. Report exact commit(s), test evidence and concerns in the assigned ignored report file. Independent review follows; the same implementer owns fixes. Do not start the runtime integration task or dispatch subagents.

### Task 2: Start the real web process and prove its lifecycle

**Files:**
- Modify `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `README.md`.
- Create `vite.config.ts`, `src/server.ts`, `src/start.ts`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/health.live.ts`, `src/routes/health.ready.ts`.
- Generate `src/routeTree.gen.ts` with the actual pinned TanStack toolchain; do not hand-write it.
- Create `src/platform/startup.server.ts` only for the concrete validated-config-to-Node-preset binding, if that initialization cannot reside in the existing server entry. A Nitro startup plugin is permitted only if needed to ensure configuration validation before the listener; no empty close hook or resource registry.
- Test `tests/platform/web.test.ts`; put any process fixture under `tests/helpers/`, never a test route in production.

**Interfaces:** consumes the exact `readWebConfig`/`WebConfig` from Task1. Produces one production `.output/` artifact whose executable entry is `.output/server/index.mjs`, public GET/HEAD `/health/live` and `/health/ready`, and the framework's actual not-found response. There is no auth or Workspace route in this source increment; those remain the next consumers in A.

**Actual adapter decision:** use `nitro@3.0.260903-beta` as the sole added Node hosting adapter. TanStack's official Vite/Node guide prescribes it; Start alone exposes a Fetch handler and no Node listener. Nitro already consumes srvx; add neither a direct srvx dependency nor a custom HTTP/static server. This beta pin must pass the actual lock/build/runtime tests, not inherit readiness from documentation. Research evidence and the named shutdown mapping discrepancy are in the task's runtime-entry-contract.md report.

Direct runtime dependencies, in addition to Effect: `@tanstack/react-start=1.168.49`, `@tanstack/react-router=1.170.32`, `react=19.2.8`, `react-dom=19.2.8`. Development/build dependencies: `vite=8.2.2`, `@vitejs/plugin-react=6.1.0`, `nitro=3.0.260903-beta`, `@types/react=19.2.18`, `@types/react-dom=19.2.5`. Keep existing compiler/test pins; no artificial TanStack subpackage version alignment, React Query, Tailwind, Astryx CLI, DB driver or worker without this task's consumer.

- [x] **Step 1: Write tests of real observable startup/lifecycle behavior before the production routes/entry.** Use a child Node process for the eventual built entry with a process-local environment, HOST=127.0.0.1 and a selected test port. Never use or populate .env, contact providers or listen publicly. The test owns its exact process and verifies exit; do not kill by process name or port. Separate configuration failure before listen, actual GET/HEAD health, unsafe-method refusal, not-found privacy, and clean process shutdown cases. A build fixture is permitted, but every asserted route is the real application route, not a mocked handler.

Required HTTP observations include:

```ts
const response = await fetch(`${baseUrl}/health/live`)
expect(response.status).toBe(200)
expect(await response.text()).toBe('ok')
expect(response.headers.get('cache-control')).toBe('no-store')
const unsafe = await fetch(`${baseUrl}/health/live`, { method: 'POST' })
expect(unsafe.status).toBe(405)
const missing = await fetch(`${baseUrl}/workspace-does-not-exist`)
expect(missing.status).toBe(404)
expect(missing.headers.get('cache-control')).toBe('no-store')
```

Live and ready bodies contain no version, configuration, paths, principal, provider/DB status or stack. Ready means only this process's successful configuration/router initialization, never product readiness. HEAD has an empty body and equivalent status. Configuration failures must not open the listener or echo invalid values. Prove actual effective port/bind and the admitted shutdown setting; don't assert only parsed values or documentation.

- [x] **Step 2: Configure the supported build and minimal framework roots.** Use the installed plugin API, with the standard plugin order:

```ts
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [tanstackStart(), nitro(), react()],
})
```

The package commands are `build: vite build`, `start: node .output/server/index.mjs` and a loopback-only Vite `dev`. Keep `typecheck: tsc --noEmit` as the sole normative typecheck; route generation occurs through the actual build before this command. Use `createRootRoute`/`getRouter` and `createServerEntry` from the installed documented exports. Add only a genuine not-found component, without fake dashboard, login screen, CTA or data. Initial 404 copy is plain FR/EN; no webfonts, analytics or external assets. Full Astryx UI/SSR/hydration/CSP/a11y acceptance remains with the first real private journey, not this health smoke.

- [x] **Step 3: Wire startup and lifecycle to effective behavior.** Inspect the exact installed Nitro Node preset before writing the small binding. It uses NITRO_HOST/PORT aliases and delegates shutdown to srvx; the researched beta documentation and implementation disagree about timeout names/units. The application must have one authority for its validated HOST/PORT/SHUTDOWN_TIMEOUT_MS settings. Normalize or reject conflicting framework aliases explicitly without value disclosure. Initialization must happen before listen; a lazy first-request validation is insufficient. No full generic config adapter or custom signal framework. If the documented integration cannot meet a concrete requirement, report that fact rather than adding an unreviewed alternative platform.

Preserve Request.signal through Start and use the configured positive request deadline at the existing thin request boundary; never detach work or read request bodies in this mechanical layer. Install the native `createCsrfMiddleware` once in custom src/start.ts for future server functions. Public health routes are GET/HEAD only, body-free, no-store and noindex; apply safe no-store/noindex/referrer/nosniff headers to the current dynamic responses, including failures. Do not claim future auth/provider protection from these public endpoints.

Shutdown stops admission, drains the listener within the configured grace, and exits without an open handle. Convert the admitted whole-second millisecond value to SERVER_SHUTDOWN_TIMEOUT seconds for the actual resolved srvx version and verify its source/build. Both1.0.3 and current1.0.4 disable their default signal plugin when CI or TEST is nonempty; reject a runtime environment that would silently disable this required behavior, and remove those inherited flags only in the isolated child test environment. Nitro reads host/port before calling useNitroApp, so a callback that changes aliases only after that read is too late; prove the startup binding executes before those reads/listen. Do not add a ManagedRuntime/pool/worker/close registry until something acquired needs it. On Windows, process.kill(SIGTERM) is not proof of POSIX graceful-signal delivery: distinguish a real invoked registered signal handler from OS delivery, and keep the Linux OS-signal acceptance named if unavailable. A controlled test stream belongs only in test fixtures, not a production /test route. Use no IPC/debug endpoint in the production artifact.

- [x] **Step 4: Observe build/typecheck/HTTP/lifecycle results with writers stopped.** Run exact dependency install, `pnpm test`, `pnpm build`, `pnpm typecheck`, focused actual-built-entry tests, and `git diff --check`. Bound each spawned process/test and require owned cleanup. Check the client output for the actual config/Effect/server boundary; use the installed TanStack import protection if available instead of creating a parallel AST platform. Record what the output graph proves and any unperformed browser/Linux acceptance. Failures remain failures; do not increase timeouts or silently drop a case to obtain green.

- [x] **Step 5: Commit and report the real increment.** README gives build/start commands and process-local configuration examples, describes health semantics and states that auth/Workspace/commerce remain incomplete. No deployment or infra integration command is executed. Independent spec/quality review follows, then Oracle reviews this foundation milestone and its named limits; no repetition of the already-closed root/schedule review.
