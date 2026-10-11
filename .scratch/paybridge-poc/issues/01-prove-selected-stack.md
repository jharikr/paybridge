# 01: Prove the selected stack

**What to build:** A small executable proof that the selected stack can validate an HTTP request, commit a durable SQLite change, return the documented response, and recover correctly after rollback, contention, and process restart. Payment features may depend on these capabilities only after this proof passes.

**Blocked by:** None (can start immediately).

**Status:** completed

**Group:** 1 of 6. Stack and persistence.

**Source:** [Approved specification](../spec.md) and [reference contract](../reference-contract.md#20-confirmed-stack-and-small-implementation-choices).

**User stories:** 59, 60, 61, 62, 63.

**Testing decisions:** 1, 2, 3, 4, 9, 17.

- [x] Use TypeScript, Fastify, Prisma ORM 8, SQLite, ArkType, the Fastify Swagger plugin, and Vitest. Use Bun and bunx for package tooling. Select and record a supported server runtime, mutually compatible package releases, and a reproducible lockfile. Package-manager choice alone must not determine the server runtime.
- [x] Verify the selected Prisma 8 SQLite extension and its actual authoring, migration, and transaction APIs against authoritative documentation and the installed packages. Report a concrete failed requirement before changing any fixed technology. Documentation or successful installation alone does not close this ticket.
- [x] Exercise a narrow request-to-persistence-to-response path using the real selected driver and isolated local SQLite files. Valid input must produce an independently asserted durable result. Invalid input must produce the agreed JSON error shape without a committed change. Keep this compatibility proof bounded; it does not add a public business API to the approved contract.
- [x] Prove parameter binding, affected-row reporting, commit, and rollback across the mixture of ORM and raw database operations needed by the payment design. An injected failure must leave none of the transaction's partial writes committed.
- [x] Prove foreign-key enforcement, check constraints, uniqueness, and a partial unique constraint suitable for one unresolved attempt per intent. Run each proof through the actual migration and connection configuration, including after reopening the database.
- [x] Start competing processes against the same isolated database and prove an atomic work claim has one winner. Show bounded contention handling, expired-claim reclamation, and rejection of completion with an obsolete claim token. Document the connection settings on which these results depend.
- [x] Terminate and relaunch a real process against the same database file. Prove committed records survive and an interrupted transaction leaves no partial commit. Do not substitute object reinitialization or an in-memory repository for this test.
- [x] Integrate ArkType with Fastify for bodies, parameters, and relevant headers. Prove bounded input, strict rejection of unsupported fields, normalized validation errors, and the response serialization path. Do not silently strip fields or weaken validation to satisfy documentation generation.
- [x] Register Swagger before the demonstrated routes and generate OpenAPI from their actual schemas. Compare real valid and invalid requests with the generated contract. Document runtime restrictions that cannot be represented in JSON Schema and prove they remain enforced.
- [x] Establish reusable Vitest integration support for isolated databases, local HTTP processes, deterministic failure coordination, and actual process termination/restart. Keep expectations independent of the implementation being tested. Later tickets extend this support for their own behavior.
- [x] Record the three authorized synthetic database targets, one per application, and retain prototype records for their data lifetime. Use fresh isolated test files rather than destructive resets of existing data. Keep the demonstration local; this ticket does not configure a production database, deployment, or worker platform.

## Comments

- 2026-10-11: Implemented the bounded stack proof in `tests/stack/` with shared ArkType/Fastify setup at `contracts/http.ts` and reusable isolated-database/process support at `tests/support/`. `bun run test` passes eight tests and `bun run typecheck` passes. Independent review is pending before completion.
- The verified package versions, failed newer-version checks, Prisma migration additions, actual connection settings, process recovery evidence, authorized local targets, and retention limits are recorded in [stack compatibility](../../../docs/stack-compatibility.md). No dependent payment feature has started in this branch.
- Independent review found three HTTP contract gaps. Added regression checks and normalized router errors, documented UTF-16 runtime string limits alongside JSON Schema code-point bounds, and included unsupported-media-type responses in OpenAPI. The updated nine-test suite and typecheck pass; review recheck is pending.

- Independent review recheck reported no findings. All three HTTP contract findings are resolved. Final verification passed nine integration tests, typechecking, frozen-lockfile installation, Prisma migration integrity, and whitespace checks. The stack gate is complete; payment behavior remains in dependent tickets.
