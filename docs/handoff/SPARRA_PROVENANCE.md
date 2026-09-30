# Sparra local derivative provenance

Sparra starts from the frozen R1 source archive, not the infrastructure starter.

- Source delivery commit (Git SHA-256): `f932b25356c82d9a5c89d0849409f043b05f95cb2206b1d7870878c00cc4e4c6`.
- ZIP SHA-256: `58F5F513D99EDCAD628E5FC214E7B989349E1BA4133AA0E91CB4F5E5B58B010A`.
- Original import commit (local Git SHA-1): `06dcf574e6ae9c4ea1dafcf3f362e784c7110575`.
- Adopted scope/setup commit: `83712f786455b6d7d9cd78d3fb0c9e8d4556a5f2`.
- Dedicated root: `C:/Users/louis/Documents/ChatGPT/sparra`, branch `z/sparra-site-audio`, no remote.

The controller imported all 262 files unchanged into a new directory. Task 1 independently opened the ZIP read-only, confirmed the archive hash, confined every source path to this root and compared every file's Git blob with the original import. No extraction, overwrite or producer change occurred. Original source remains recoverable from the import commit; DELIVERY metadata is retained in R1_DELIVERY.json alongside the producer guide and verification receipt.

Pins and the nice-grpc patch remain unchanged: Node 24.14.0, pnpm 10.32.1, TypeScript 7.0.2, Effect 4.0.0-rc.111, Astryx 0.5.4. Frozen installation, normative typecheck, web/worker build and source tests qualified the intact derivative baseline on 30 September 2026: 53 files, 682 tests passed. Integration tests are separate and were not run for this baseline.

Task 1 adds a public French landing, its SSR metadata and narrowly scoped index/media policy. GET/HEAD root HTML with a 2xx status alone is indexable and allows local media; private routes, errors, redirects, other methods and non-HTML responses retain the private policy. The existing R1 auth, Workspace authority, runtime stores and startup checks remain authoritative. Disposable wire fixtures prove local HTTP behavior, not real store/provider operation.

The marketing content describes a service being prepared for a pilot. Knowledge examples are fictitious and read-only; appointments remain to be confirmed without a linked agenda, and human fallback still requires qualification. Contact links compose an email. There is no public recovery route, new business migration, live voice provider, commerce activation, push or deployment in this lot. French residency, compliance, physical authenticators and real-provider acceptance are not established by this local work.

Future R1 updates require an explicit comparison against this frozen base. Do not recursively overwrite the product, move the source snapshot or automatically synchronize the producer. Applied migrations remain immutable and must be reconciled on the product's own state before any separately authorized integration.
