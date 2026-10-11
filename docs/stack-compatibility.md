# Selected stack compatibility

Ticket 01 uses Node.js 26.8.1 as the server and test runtime. The Prisma SQLite package uses Node's built-in `node:sqlite`; Bun 1.3.4 manages packages. Fastify and Vitest run on Node, including every child process in the recovery tests.

The reproducible dependency set is in `bun.lock`:

| Package              | Verified release |
| -------------------- | ---------------- |
| Prisma CLI           | 8.0.0-rc.21      |
| `@prisma/orm-sqlite` | 8.0.0-rc.16      |
| Fastify              | 5.12.5           |
| ArkType              | 2.2.8            |
| `@fastify/swagger`   | 9.9.2            |
| TypeScript           | 7.0.2            |
| Vitest               | 5.0.3            |

Run the proof from the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The compatibility routes live under `tests/stack/proof/`. They run only when the integration tests launch that fixture. `/proof/:id` is a bounded stack exercise, not a Paybridge business API. No application development server is started by these commands.

## Release selection

The [Prisma release documentation](https://www.prisma.io/docs/orm/release-status) describes the separate CLI and ORM packages and requires Node 22.18 or newer. The [SQLite extension](https://www.prisma.io/extensions/sqlite) supplies the runtime, authoring, control client, and migration support. SQLite remains experimental.

The newest CLI advertised on 2026-10-11 was 8.0.0-rc.22. `bun add --dev prisma@8.0.0-rc.22` failed because its dependency graph included unavailable `@aws-sdk/token-providers@3.1149.0`, `react@^19.3.0`, `scheduler@^0.28.0`, and `@octokit/types@^18.0.0`. That attempt also reported several tarball integrity failures. No failed-download artifact is part of the lockfile.

CLI 8.0.0-rc.21 installed. Paired with SQLite 8.0.0-rc.17, contract emission succeeded but migration planning returned `CLI.UNEXPECTED`, with `undefined is not iterable`. SQLite 8.0.0-rc.16 matches that CLI's ORM tooling and passed the executable checks. Both chosen versions remain on the specified Prisma 8 major. No other ORM or database was substituted.

## Authoring and migrations

The fixture uses the Prisma 8 contract workflow, checked against the installed declarations and [migration documentation](https://www.prisma.io/docs/orm/migrations/how-migrations-work):

```sh
bunx prisma contract emit --config tests/stack/proof/prisma.config.ts
bunx prisma migration plan --config tests/stack/proof/prisma.config.ts --from 20261011T0705_stack_work --name next_change
```

The second command is an example for a future contract change. Generated `contract.json`, `contract.d.ts`, migration operations, and snapshots are committed. The contract begins with `// use prisma-8`. Generated migration type imports need an explicit `.d.ts` suffix under this project's NodeNext configuration.

`createSqliteControlClient().migrate()` applies the same recorded operations through Prisma's control API before the fixture opens the runtime. It accepts the emitted contract, migration directory, and isolated file path. Reopening a migrated file does not replace its records.

SQLite contract authoring in this release cannot express CHECK constraints or partial indexes. The small additions in `migration.ts` use Prisma's `rawSql` operation for those constraints. Run an edited migration to regenerate its operations and metadata:

```sh
node tests/stack/proof/migrations/app/20261011T0700_stack_constraints/migration.ts --config tests/stack/proof/prisma.config.ts
```

The proof enforces a positive safe integer, allowed attempt states, a foreign key, primary-key uniqueness, and a unique index restricted to PROCESSING or UNKNOWN attempts. These assertions run after closing and reopening the database. Prisma's generated contract does not describe the added CHECKs and partial index, so the behavioral checks must remain when later migrations change these tables. Existing application records must never be reset to make a migration pass.

## Runtime behavior

The installed driver opens each connection with `foreign_keys = ON` and `busy_timeout = 5000`. Tests also assert the actual runtime settings after reopening: DELETE journal mode and FULL synchronous mode, SQLite value 2. The proof uses those defaults without a custom SQLite build or WAL configuration.

`db.transaction(callback)` keeps `tx.orm` writes and `tx.execute(db.raw.sql\`...\`.affectedCount().build())` on the same transaction. The test writes through both APIs, injects a failure, and verifies that neither write survives. SQL-shaped input remains literal data. A matching raw update reports one affected row and a nonmatching update reports zero. This follows the [Prisma transaction API](https://www.prisma.io/docs/orm/fundamentals/transactions).

Two real Node processes race the same conditional UPDATE. Exactly one gets a row. An unexpired lease cannot be claimed, an expired lease can, and completion checks the replacement token. A second scenario holds a transaction after both ORM and raw writes. Another process reaches the five-second writer timeout and reports a transient contention result. After SIGKILL releases the holder, the next claim succeeds. A newly launched process reads the original committed record and confirms that the interrupted record is absent.

The timeout bounds one database operation, not an entire payment workflow. It blocks the calling Node process while SQLite waits. Later workers must keep transactions short, perform HTTP outside them, and choose bounded retry policies. The fixture itself does not add a scheduler or worker framework.

## Validation and OpenAPI

`contracts/http.ts` registers a small [Fastify validator compiler](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) backed by the original ArkType validator. JSON Schema has a local identity linking it to that validator. Validation therefore preserves predicates and rejects unknown body fields instead of stripping them. Normal HTTP transport headers remain allowed; the required application header is validated.

Swagger registers before routes. ArkType produces the request schemas used for documentation and the response schemas used by Fastify serialization. Tests compare real HTTP results with generated OpenAPI and independently validate bodies and responses with Ajv. An internal-only fixture field is excluded from the serialized response.

The label's no-surrounding-whitespace predicate demonstrates an [ArkType restriction that JSON Schema conversion cannot encode](https://arktype.io/docs/configuration#tojsonschema). Its explicit conversion fallback adds a description to the schema. The original runtime predicate still rejects the input, and the test proves that rejection leaves no record. Other conversion limitations still throw rather than disappearing silently.

ArkType string lengths count UTF-16 code units, while JSON Schema counts Unicode code points. The parameter and label schemas explicitly describe that stricter runtime limit. Regression cases accept 40 emoji in an 80-unit label and reject 41, even though the latter fits the JSON Schema code-point bound. The same check accepts 16 emoji in the 32-unit identifier and rejects 17. Validation has not been weakened to match the documentation format.

Router-level rejection also uses the JSON error envelope with a generated request ID. Invalid percent encoding returns 400; a route parameter above the router's 100-unit limit returns 414 without echoing the path. Unsupported body media types return 415. OpenAPI includes the 414 and 415 responses, and tests compare the actual responses with the contract.

## Reusable integration support

`tests/support/databases.ts` allocates fresh directories with separate `paybridge.db`, `merchant.db`, and `mock-fourcs.db` paths. Its async disposal removes only that test's newly allocated directory. `tests/support/process.ts` launches the actual Node executable, captures diagnostics, waits for typed-at-the-call-site IPC signals with a ten-second deadline, and terminates children with SIGKILL. Later tickets can use these helpers with their real application entrypoints.

The three authorized local synthetic application targets are `.data/paybridge.db`, `.data/merchant.db`, and `.data/mock-fourcs.db`. Each application owns its file. Payment records, history, command keys, and evidence remain for the lifetime of prototype data. This ticket creates no persistent demonstration files and configures no automatic purge, production target, or destructive reset.

## Verification

On 2026-10-11, `bun run test` passed nine integration tests in three files. `bun run typecheck` passed. Checks cover the installed Prisma runtime and migration operations, actual local HTTP, generated OpenAPI, competing processes, a killed transaction, and process restart. The test expectations use independent literal outcomes and real SQLite files.

This closes the stack compatibility gate only. Payment behavior, provider integration, merchant consumption, and live-provider guarantees remain for their respective tickets.
