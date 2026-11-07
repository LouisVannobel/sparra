# Residual dependency security qualification — 7 November 2026

## Scope and resolution

The two remaining audit findings are removed with three exact parent-scoped resolutions. Direct application/tool pins, the zod override, application/schema source and the migration tree are unchanged.

| Actual dependency edge | Before | Qualified resolution |
| --- | --- | --- |
| `@esbuild-kit/core-utils@3.3.2 > esbuild` | `0.18.20` (`~0.18.20` declared) | `0.25.12` |
| `eslint@10.11.0 > minimatch` | `10.2.6` (`^10.2.5` declared) | `11.0.5` |
| `@eslint/config-array@0.23.5 > minimatch` | `10.2.6` (`^10.2.4` declared) | `11.0.5` |

These are deliberate resolutions outside the parents' declared ranges. Passing the scoped contracts below does not establish universal backward compatibility or upstream parent support. There is no global esbuild/minimatch override and no audit suppression.

`pnpm install --lockfile-only` preserved all unrelated resolutions, including Sentry, OpenTelemetry, direct pins and patch hashes. The graph delta removes esbuild 0.18.20 and its platform packages, reuses existing esbuild 0.25.12, replaces minimatch 10.2.6 with 11.0.5, and adds the latter's required `@isaacs/nonrecursive-glob-match@1.1.0`. Docker's dependency-pruning stage removes its obsolete esbuild 0.18.20 binary paths and retains the 0.25.12 paths.

The retained override is `zod@4.6.1: 4.6.6`. Retained patch SHA-256 values:

| Patch | SHA-256 |
| --- | --- |
| `patches/@hatchet-dev__typescript-sdk@1.28.2.patch` | `d4c0f21c2f37dd7b888618297f73dc4c1b2739bfd56a87a1f584e6df06e50f74` |
| `patches/nice-grpc@2.1.17.patch` | `46f96eec92487aadc40ba2e93cd504819bf12d671a59d1afe819b41842f372fd` |

## Exact sources and consumed contracts

The installed parent sources and declarations were inspected before changing the graph:

- `@esbuild-kit/core-utils@3.3.2/dist/index.js` and `index.d.ts` declare and call `transform(code, filePath, options?)` and `transformSync(code, filePath, options?)`. They consume esbuild `transform`/`transformSync`, `version`, `keepNames`, source files/maps, target, loader and format. The native defaults are ESM for async transform and CommonJS for sync transform. This archived parent's own [published metadata](https://www.npmjs.com/package/@esbuild-kit/core-utils?activeTab=dependencies) still declares esbuild `~0.18.20`.
- `@esbuild-kit/esm-loader@2.6.5/dist/index.js` consumes core-utils to transpile imports. It is resolved through the installed Drizzle Kit parent and exercised as Node's actual loader. Drizzle Kit's CLI separately bundles tsx; successful CLI generation does not exercise this archived loader.
- [ESLint 10.11.0 `eslint-helpers.js`](https://github.com/eslint/eslint/blob/v10.11.0/lib/eslint/eslint-helpers.js) uses the named `Minimatch` constructor, `{dot:true}`, `match(path)`, and `match(directory,true)` for partial directory pruning. It normalizes relative file patterns to forward slashes.
- The installed `@eslint/config-array@0.23.5/dist/esm/index.js` imports `Minimatch`, caches instances, uses `{dot:true}` plus optional `flipNegate`, and calls `match` for files/ignores. Its independent minimatch edge is resolved and tested as well as ESLint's edge.
- The [minimatch 11.0.5 source](https://github.com/isaacs/minimatch/blob/v11.0.5/src/index.ts) retains these public methods but uses a nonrecursive path-segment matcher. Its level-2 `**/..` preprocessing checks the pattern-row and cell budgets before allocating a new row. The installed source throws `RangeError` with `optimizationLevel 2: too many patterns from '**/..'` for the bounded regression case.
- The publisher's [minimatch advisory GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) identifies globparts amplification in 10.2.6. The selected [11.0.5 changelog](https://github.com/isaacs/minimatch/blob/v11.0.5/changelog.md) and [preprocessing-limit tests](https://github.com/isaacs/minimatch/blob/v11.0.5/test/preprocess-limits.ts) are the exact fix references; the executable local regression uses a small cap rather than the advisory's large input.
- The [esbuild advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99) covers the default development-server CORS policy through 0.24.2; its fix begins at 0.25.0. The chosen 0.25.12 already exists elsewhere in this lockfile.

## Regression evidence and native compatibility

`tests/runtime/dependency-security-contracts.test.ts` contains eight real-consumer tests. Resolution starts at Drizzle Kit → archived esm-loader → core-utils → esbuild, and React Doctor → ESLint → config-array, rather than importing a convenient root library copy.

Before graph changes, the three security tests failed for the intended reasons under Node 24.22.2:

- The core-utils-resolved esbuild context served an owned marker from `127.0.0.1` on an OS-assigned port and returned wildcard ACAO to `https://foreign-origin.invalid`.
- Both parent-resolved minimatch copies expanded six small `**/../a/b` components into 64 rows despite a cap of 63. This is a bounded child with a 3-second containment limit, not a large CPU stress test.

After repair all eight tests pass:

- The entire loopback-server lifecycle runs in a filtered owned Node child, including creation, a successful no-Origin control request, the same URL's foreign-Origin request, `context.dispose()` and `stop()`. Both requests must return the owned marker successfully; the foreign response must have no ACAO header, which also rejects reflected-origin allowances. The environment excludes `ESBUILD_BINARY_PATH`; neither the native binary nor the server inherits the repository cwd or ambient provider settings. A timeout/error is never rewritten as success.
- Each actual minimatch parent first constructs a small under-limit matcher with the same `optimizationLevel:2` and cap 63, outside the error-catching block, and proves that it accepts JavaScript and rejects CSS. It then rejects the small cap case with the precise intended limit `RangeError`. The test also permits a result within the cap; unrelated exceptions, stack overflow and child timeout fail.
- Real core-utils async and sync TypeScript transforms preserve a named exported function, an imported value and source-map source/content/mappings. Emitted ESM and CommonJS execute and compute 42.
- A filtered Node child runs the actual archived esm-loader with static and dynamic `.mts` imports containing enums. This requires transpilation and cannot pass through native type stripping alone.
- Actual ESLint discovers exactly the intended brace/extglob files, dot file and nested files; the real `no-debugger` rule fires on each. Generated and explicit ignored files are excluded, partial directories remain traversable, and Windows-style input patterns pass on Windows.
- Actual config-array selects/ignores the same relative fixture contracts for both POSIX and Windows base paths. Both actual parent matchers separately prove partial-directory behavior and Windows separator handling.
- Actual Drizzle Kit generation consumes all six original schema paths and produces 45 tables and 76 policies. Assertions cover auth, Workspace, Sparra, billing, calendar and the private Voice schema plus representative RLS policies. The first generation's entire SQL output tree is inventoried by relative filename and SHA-256, including the required metadata snapshot and journal. The second generation must report `No schema changes` and preserve that complete file/byte state.

Each child runs from an owned OS-temp directory with a filtered environment, owned `TEMP`/`TMP`/`TMPDIR`, explicit empty `DOTENV_CONFIG_PATH`, empty `DOTENV_KEY`, and `ESBK_DISABLE_CACHE=1`. The last flag is verified in installed core-utils source: it selects an in-memory map instead of its shared disk cache/expiry. No existing dotenv file supplies fixtures. Drizzle uses absolute forward-slash schema paths and `out:'./sql'` relative to the owned child cwd; the relative output avoids the CLI's Windows absolute-snapshot path-join defect. Nothing writes repository migration output or connects to a database/provider.

The existing `maintained_doctor_changed_scope_reports_actual_component_rule` canary also passes. Doctor uses Oxlint; this is additional consumer coverage, separate from the ESLint/minimatch contracts.

## Accepted minimatch 11 semantic corrections

The [11.0.5 README](https://github.com/isaacs/minimatch/blob/v11.0.5/README.md) documents its new matcher and UNC behavior. This qualification accepts the following corrections, with assertions through both actual parent matchers:

- Under `platform:'win32'`, `//host/share/*.js` now matches `//HOST/SHARE/file.js`; the host/share components are case-insensitive. Extended `//?/UNC/host/share/*.js` and ordinary `//host/share/file.js` are equivalent. These cases were false with 10.2.6.
- `a/b/?(x)` no longer matches `a/b/` through an empty trailing extglob segment (10.2.6 returned true).

The consumers exercised here use normalized relative globs and selected nonempty file paths. The tests qualify these actual parent contracts and explicitly accept the listed corrections; they do not assert that every arbitrary glob has identical results across major versions.

## Local verification and remaining delivery gates

All commands used Node `v24.22.2` at the head of `PATH`, pnpm `10.32.1`, and child `process.execPath`. Logs are retained locally in `.superpowers/residual-security-20261107/`:

| Command | Result | Log |
| --- | --- | --- |
| `pnpm exec vitest run tests/runtime/dependency-security-contracts.test.ts --maxWorkers=1 -t 'loopback server\|bounds level-2'` before repair | Three expected failures | `red.log` |
| Exact final CORS child replayed against retained local esbuild 0.18.20 payload, without graph changes | Expected assertion failure: successful control/foreign marker responses, foreign ACAO `*` instead of null | `red-cors-review-hardening.log` |
| Native consumer baseline before adding accepted v11 semantic assertions | Five pass | `baseline-consumers.log` |
| `pnpm install --lockfile-only` | Pass, minimal reviewed graph delta | `lockfile-only.log` |
| `pnpm install --frozen-lockfile` | Pass | `frozen-install.log` |
| `pnpm exec vitest run tests/runtime/dependency-security-contracts.test.ts --maxWorkers=1` after repair | Eight pass, initial isolation hardening | `green.log` |
| Same eight tests after independent review and Oracle's three narrow amendments | Eight pass, final CORS child/control, under-limit minimatch control and byte-identical SQL replay | `green-review-hardening.log` |
| `pnpm audit --json` | Zero advisories; no muted entries; 664 dependencies | `audit-full.json` |
| `pnpm audit --prod --json` | Zero advisories; no muted entries; 406 dependencies | `audit-production.json` |
| `pnpm run typecheck` | Pass after final test hardening | `typecheck-review-hardening.log` |
| `pnpm run lint` | Pass after final test hardening; includes new test | `lint-review-hardening.log` |
| `pnpm run build` | Pass, web and worker output | `build.log` |
| `pnpm exec vitest run tests/quality-policy.test.ts --maxWorkers=1 -t maintained_doctor_changed_scope_reports_actual_component_rule` | Selected existing canary passes | `doctor-canary.log` |

The original normative RED log predates the final isolation/control hardening. The final CORS child was additionally replayed under Node 24.22.2 against the original 0.18.20 payload still retained locally, and its ACAO assertion failed for the intended reason. This replay did not restore or mutate the lockfile or installed parent edges. The native baseline predates the deliberately changed v11 semantic assertions, so the final compatibility test is not expected to pass unchanged on the old graph. The final review amendments change tests and this note only; the graph and previously built application source are identical.

Oracle session `sparra-residual-deps-contract-20261107` completed with a conditional GO for the scoped cross-version choice and the three narrow amendments recorded above. Independent source review approved their final implementation and repeated all eight tests. The full native `pnpm test` suite requires its Docker/native cohorts and remains a hosted CI gate owned by release coordination. Local scoped qualification is not full-suite, image, deployment or live-provider acceptance. PR/main CI, immutable image verification and the explicitly narrow web-only deployment remain separate delivery gates.

## Removal criteria

Remove an override only when its selected parent natively declares and resolves a fixed compatible version, or the actual archived consumer has been removed through an independently qualified parent change. Re-run the security regression and actual parent contracts, frozen install, both audits and normal release gates on that graph. Do not remove an override solely because an unrelated root copy is fixed or one audit scope is clean. Any future parent-version change must re-evaluate these version-specific selectors and the Docker pruning paths.
