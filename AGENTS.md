# projetV0 SaaS template

This is the private application candidate, not the infrastructure repository or a probe repository. It is not yet a ready SaaS template.

- Follow the adopted design in docs/design/. Astryx supersedes historical shadcn references. Keep one package/lockfile, vertical modules and separate web/worker entrypoints only when each has a real consumer.
- Do not add CI/CD, infrastructure, deployment, remote repositories, provider credentials or migrations against existing services. Local build/test activity is scoped to this repository and explicitly disposable test dependencies.
- Keep secrets out of source, browser payloads, logs, reports and Oracle inputs. Never read an existing .env to populate fixtures.
- Use exact dependency pins and one normative typecheck. Inspect upstream source/types for the installed version; no broad casts to hide incompatibility.
- Prefer recent official maintained releases compatible with the selected stack. The user's 11 September clarification prioritizes clean, supported code without overbuilding over unexplained private patches. Check registry/release metadata and exact source before attributing a fix to an upgrade; qualify the affected contract before repinning. Do not change the package graph underneath an active task or treat a package update as permission to upgrade existing infrastructure.
- Write behavior tests before production changes, observe RED, implement the smallest passing code, then review. Use a fresh implementer per task and an independent spec/quality review; Oracle reviews important design choices and milestone closure, not routine edits.
- No fake login, placeholder routes, mock adapters in runtime, generic repositories/services, empty worker, universal endpoint DSL or imported PREP controller/receipt machinery. Test doubles stay in tests and do not prove real-provider behavior.
- Auth, tenant, transaction, recovery, monetary and side-effect safety requirements are not waived by early candidate development. Do not declare a capability ready until its actual consumer gates pass.
- Keep work local on codex/application-foundation. Preserve unrelated changes. No push, deployment or new global tooling.

The user's 10 September 2026 approval adopted the local application root and independent application schedule in docs/design/APPLICATION_DELIVERY_CONTINUATION.md. No second root/schedule approval is needed to specify and execute its code tasks. Full-template completion still includes B2B commerce, derivations and all applicable product gates.

The subsequent explicit authorizations and "Vasy" adopted docs/superpowers/specs/2026-09-10-auth-preparation.md, including the pre-tenant-auth-email exception and source-guided adapter pilot. Do not re-ask that adoption. Use the incorporated design clauses, reuse existing app/probe tests, and prioritize the selected packages' native agent guides plus matching upstream source/tests. Effect guidance starts at node_modules/effect/AGENTS.md; TanStack skills are shipped in its installed packages. Generic examples never override the selected stack or enable password, another SQL stack, a catch-all auth mount, shadcn or provider I/O from callbacks. Source checkouts are read-only development references, not app imports. Oracle reviews each delivery step; no closed preparation review is repeated merely because execution resumes.
