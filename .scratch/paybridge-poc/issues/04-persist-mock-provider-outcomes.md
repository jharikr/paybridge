# 04: Persist deterministic mock 4Cs outcomes

**What to build:** A synthetic SOAP caller can submit a transaction to mock 4Cs and observe a reproducible result. Accepted transaction identity and final outcome survive duplicate requests, overlapping execution, deliberately lost responses, and provider restart.

**Blocked by:** 01: Prove the selected stack.

**Status:** completed

**Group:** 3 of 6. Durable mock and provider execution.

**Source:** [Approved specification](../spec.md) and [provider rules](../reference-contract.md#6-4cs-provider-rules-and-mock-fidelity).

**User stories:** 29, 30, 32, 36, 43, 56, 63, 64.

**Testing decisions:** 8, 9, 10, 11, 16.

- [x] Implement the selected SOAP 1.1 SSISProcessTransaction and AuthAndPost subset over local HTTP, with two synthetic provider-account fixtures. The mock owns its separate durable SQLite database and does not read Paybridge or merchant databases.
- [x] Validate synthetic merchant credentials and the agreed transaction, invoice, amount, currency, and request fields. Expose the outer operation result, service ResultCode, and financial result as distinct protocol layers. Preserve the separate approval, decline, and selected definitive incomplete outcomes.
- [x] Uniquely identify an accepted transaction by provider account and transaction ID. Atomically retain its request identity, matching evidence fields, and immutable final synthetic outcome before emitting, delaying, or losing the response. Different accounts remain isolated even when an external caller uses the same transaction ID.
- [x] Every concurrent, delayed, restarted, and duplicate submission path honors an already stored outcome. Reusing an accepted identity returns the provider-style DuplicateTransaction result, not a replay invented to look like the original financial response. No duplicate creates a second simulated financial effect or replaces a stored decline with approval.
- [x] Supply deterministic scenarios for approval, decline, definitive incomplete, malformed response, mismatched echoes, invalid service results, duplicate handling, lost response, delayed response, and pre-acceptance delay or failure. Coordinate failure windows explicitly so tests do not depend on arbitrary sleep timing.
- [x] Demonstrate the difference between holding a request before acceptance and withholding a response after committing the final outcome. A held unaccepted request may later execute. An absent ledger entry or one rejected submission cannot certify that every outstanding same-ID submission is unable to execute.
- [x] Prove stored outcomes and duplicate behavior survive actual mock process termination and restart. Race same-ID submissions and independently inspect the persisted ledger to establish the number and identity of simulated effects.
- [x] Make matching synthetic ledger facts available to the test harness and trusted local operator for investigation. Include provider account, transaction ID, invoice, amount, currency, final outcome, and useful non-sensitive references. Do not add a live provider status API, automatic Paybridge reconciliation API, or transaction-closure operation.
- [x] Bound SOAP bodies, safely serialize fields, and disable DTD and external-entity processing. Exercise valid XML and injection-like input. Use only controlled synthetic payment data and sanitized diagnostics, with no sensitive request-body logging.
- [x] Document durable deduplication and finality as simulation assumptions. Do not claim live-provider retention, failover behavior, settlement finality, tokenization, or exactly-once distributed execution. The provider's repeat operation is not used as lookup or recovery.



## Implementation evidence

2026-10-11: Implemented on `implement/paybridge-poc-04`, based on integration commit `772c3b9`. The mock owns `apps/mock-fourcs`, its emitted Prisma contract and retained migrations, `contracts/fourcs.ts`, and `tests/mock-fourcs`. Independent review and the correction recheck passed.

- `bun run test tests/mock-fourcs` passed 13 tests across real HTTP and real Node processes. Independent SQLite inspection checks matching account, transaction, invoice, amount, currency, final outcome, and simulated effect count.
- `bun run test` passed all 22 current integration tests in five files. `bun run typecheck` passed.
- The two-process, 12-request same-ID race passed eight consecutive focused runs after the contention correction. Exactly one response approves, eleven return DuplicateTransaction, and the ledger contains one effect. The original assertion remains strict.
- Actual SIGKILL/restart preserves approval and decline. Explicit IPC checkpoints demonstrate abandoned pre-acceptance requests executing after release, rejected submissions not closing outstanding work, delayed replies after committed acceptance, and a late same-ID request unable to replace an earlier decline.
- XML checks cover namespace aliases, duplicate fields/structures, unsupported operations and currency, exact money bounds, injection-like values, disallowed card inputs, DTDs/entities, XML version, unsupported media/actions, and body limits. Diagnostics exclude SOAP bodies, credentials, and card fields.
- The read-only operator CLI reports matching safe evidence and distinguishes absent records. No lookup or reconciliation HTTP endpoint was added. All references and credentials are synthetic; provider source material remains outside the repository.
- Applied TypeScript best practices, TDD at the approved HTTP/process seams, and deslop. The idempotence principle led to the account-scoped unique insert; the records guidance led to immutable ledger triggers.

### Contention finding

A full-suite run initially failed because one racing request returned HTTP 500. A focused rerun reproduced `database is locked` on its second run. The installed Prisma `setupDriverExecution` performs first-use marker verification on the held transaction connection. That SELECT precedes the application's INSERT inside a DEFERRED transaction and can introduce a competing lock upgrade. The ledger acceptance is one complete statement, so it now uses `db.runtime().execute(db.raw.sql...affectedCount().build())` in SQLite autocommit mode. This retains atomic immutable facts and unique identity without a multi-await transaction. No catch-all retry or weakened assertion was added. Temporary diagnostic instrumentation was removed. See the mock README for the implications for later multi-row workers.


### Independent review correction

The reviewer reproduced one P2: Fastify's built-in text/plain and application/json parsers let those media types reach the SOAP operation as strings. Added real HTTP regression cases for plain XML and JSON-stringified XML; the first case failed with HTTP 200 before the correction. The mock now removes default parsers before registering text/xml, so both requests return 415 with no ledger entry. The same test then submits valid SOAP and establishes approval. The correction adds no alternate parser or fallback route. The independent reviewer reran all 13 mock tests and typecheck, confirmed the 415 responses and absent ledger effects, and reported no remaining findings in ticket04 scope. `git diff --check` passed.
