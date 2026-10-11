# Local mock 4Cs

Run from the repository root with Node.js 26.8.1 and the installed Bun dependencies:

```sh
node apps/mock-fourcs/main.ts
```

The default listener is `127.0.0.1:3102`. The mock owns `.data/mock-fourcs.db` and applies its recorded Prisma 8 migrations when it opens that file. Existing ledger records remain. To use an isolated file and an ephemeral port:

```sh
node apps/mock-fourcs/main.ts /tmp/my-synthetic-run/mock-fourcs.db 0
```

The process prints its bound URL as structured JSON. It never logs SOAP bodies, card fixtures, or merchant keys. No application accesses another application's database.

The sole payment operation is SOAP 1.1 `SSISProcessTransaction` at `POST /TranSvcs/ssis.asmx`. `contracts/fourcs.ts` contains its request serializer, SOAPAction, and controlled synthetic fixtures. The selected operation is `AuthAndPost`. Only XCD is supported. Amounts have exactly two decimal places, converted with integer arithmetic. The range is 1 to 9,999,999,999 minor units. This conservative fixture ceiling is a mock choice, not a verified live-provider limit.

The mock accepts `mock-provider-key-a` for `mock-account-a` and `mock-provider-key-b` for `mock-account-b`. These are synthetic local fixtures, distinct from Paybridge API credentials. The request serializer resolves a synthetic payment reference into the allowed mock card fields. Arbitrary card input, unknown fields, repeated fields, incorrect namespaces, DTDs, external entities, processing instructions, and oversized bodies are rejected. The 16 KiB byte limit, XML depth limit, and element count limit apply before any ledger write. Serialization escapes XML text. The parser checks namespace URIs rather than a particular prefix.

## Outcomes and failure fixtures

| Synthetic reference | Acceptance and response |
| --- | --- |
| `pm_mock_approved` | Record approval and one simulated financial effect; reply Approved. |
| `pm_mock_declined` | Record final decline and zero effects; reply Declined. |
| `pm_mock_incomplete` | Record selected final incomplete and zero effects; reply Incomplete. |
| `pm_mock_malformed` | Record approval, then emit malformed XML. |
| `pm_mock_mismatched_echo` | Record approval, then change the echoed transaction ID. |
| `pm_mock_invalid_service` | Record approval, then return GeneralError with an arbitrary Approved financial field. |
| `pm_mock_invalid_operation` | Record approval, then return an unsuccessful outer result with an arbitrary Approved financial field. |
| `pm_mock_lost_response` | Record approval, then destroy the response connection. |
| `pm_mock_delayed_response` | Record approval before waiting to send the response. |
| `pm_mock_held_before_acceptance` | Wait before attempting to record approval. Another submission may record a final result meanwhile. |
| `pm_mock_fail_before_acceptance` | If no record is visible, reject this submission with Unavailable. This does not prevent another submission from executing. |
| `pm_mock_decline_lost_response` | Record final decline, then destroy the response connection. |

The outer operation result, service ResultCode, and FinancialResultCode are distinct. Financial approval is meaningful only when both outer and service results are OK and all required echoes match. HTTP 200 alone establishes nothing about the payment.

An accepted identity is unique by provider account and transaction ID. The mock stores its invoice, amount, currency, safe fixture reference, request fingerprint, final outcome, and references in one atomic INSERT through the Prisma runtime. The unique constraint chooses the winning insert across processes. Every later accepted same-ID path returns DuplicateTransaction, including a request that waited before acceptance. It does not return a replay of the original financial response. A later request cannot replace a decline with an approval. SQLite triggers reject updates and deletion of accepted facts.

Normal local delay fixtures wait two seconds. Integration tests launch the real entrypoint with `--test-control` and a parent IPC channel. A held checkpoint emits `before-acceptance` or `after-acceptance`, account, transaction ID, and an opaque gate ID. A parent releases it with `{ "kind": "release", "gateId": "..." }`. Every successful acceptance emits `after-acceptance`; its gate ID is null unless the response is deliberately held. Controls are unavailable over HTTP and are rejected without parent IPC. Tests wait for those signals, inspect the independent ledger, and release or kill the process. They do not infer acceptance from elapsed time.

## Operator evidence

A trusted local operator can inspect the mock-owned ledger through a read-only process:

```sh
node apps/mock-fourcs/inspect.ts .data/mock-fourcs.db mock-account-a TXN1
```

A recorded result includes the provider account, transaction ID, invoice, minor-unit amount, currency, final outcome, simulated effect count, host reference, approval code, acceptance time, and request fingerprint. No card fields, credentials, or request XML are retained. A missing record returns `kind: absent`. It cannot establish non-payment: a request held before acceptance may still execute. Compare all evidence fields to the attempt before recording a manual reconciliation in Paybridge.

The inspector is test/operator tooling. There is no provider status endpoint, closure operation, or automatic Paybridge reconciliation API. `SSISProcessTransactionRepeat` is unsupported and is never used for lookup or recovery.

## Guarantees and limits

Durable account-scoped deduplication and immutable final outcomes are simulation assumptions. They hold for the lifetime of retained prototype data. The mock does not claim live-provider retention or failover behavior, settlement finality, tokenization, bank certification, or exactly-once distributed execution. Approved means the mock's authorization-and-posting threshold, not settled funds. Its selected final Incomplete outcome is distinct from a bank decline.

Run `bun run test tests/mock-fourcs` and `bun run typecheck`. The suite uses real HTTP, Prisma migrations, independent read-only SQLite inspection, competing Node processes, IPC gates, SIGKILL, and actual restart. It demonstrates why neither a missing row nor rejection of one submission closes every outstanding same-ID request.

### Prisma concurrency detail

The ledger calls `db.runtime().execute(plan)` with a parameterized raw INSERT plan built with `.affectedCount().build()`. An explicit `db.transaction(...)` was unnecessary and produced intermittent `database is locked` failures in the two-process race. The installed Prisma runtime verifies its marker on first use. Inside a transaction it reads that marker on the held DEFERRED connection before executing the caller's first statement, so a nominally write-first cold transaction can still upgrade a read lock. The SQLite driver also acquires a synchronous connection per transaction. Multiple transactions in one Node process must not wait on locks held by another transaction whose completion needs that same event loop.

The final ledger insert runs in SQLite autocommit mode, includes all accepted facts, and relies on its unique constraint for duplicates. The driver retains its five-second busy timeout. There is no retry loop hiding arbitrary database failures. Other application commands spanning multiple rows still need transactions and must address initialization and local transaction scheduling explicitly. This mock's one-statement solution is not a replacement for those transactions.

XML parsing uses the namespace-aware events documented by [saxes](https://github.com/lddubeau/saxes). The application rejects DTDs and declares no external entity resolver.
