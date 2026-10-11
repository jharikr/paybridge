# Local provider worker

Start the mock, API, and worker as separate Node processes from the repository root:

```sh
node apps/mock-fourcs/main.ts .data/mock-fourcs.db 3102
node apps/paybridge/server.ts .data/paybridge.db 3100
node apps/paybridge/worker.ts .data/paybridge.db http://127.0.0.1:3102
```

Each command runs in its own terminal. The worker opens only the Paybridge database and contacts the mock over HTTP. It never reads the mock ledger. Existing files migrate in place and retain payment records and acknowledgments.

Worker arguments are database path, mock origin, HTTP timeout milliseconds, lease milliseconds, and poll milliseconds. Defaults are `.data/paybridge.db`, `http://127.0.0.1:3102`, `3000`, `10000`, and `250`. The timeout must be shorter than the lease. The origin accepts literal loopback HTTP addresses only, `127.0.0.1` or `[::1]`, without a path or credentials. Redirects are rejected. Live provider endpoints are outside this prototype.

The loop atomically claims due PENDING work or expired PROCESSING work with a new token and worker identity. It starts the lease clock after obtaining SQLite write access and commits before HTTP. After commit, it checks that the remaining lease exceeds the HTTP timeout. A claim exhausted by commit contention is left for lease recovery without sending a request. Every execution uses the persisted account, invoice, transaction ID, amount, currency, and synthetic reference. Reclaiming work does not create a payment attempt or choose another transaction ID. SIGTERM and SIGINT stop new claims, allow the bounded in-flight operation to finish, and close the worker's database connection. A killed process leaves its unfinished lease available for recovery.

## SOAP and outcomes

The adapter uses SOAP 1.1 AuthAndPost at `/TranSvcs/ssis.asmx`, with the exact action, field names, and namespaces implemented in `contracts/fourcs.ts`. It resolves controlled synthetic card fields and the owning merchant's provider key inside the adapter. Business references and descriptions are not provider identifiers. Public requests reject card data and provider-account overrides.

XCD is the only supported currency. Integer arithmetic converts its two-decimal minor units, including `1 -> 0.01` and `9999999999 -> 99999999.99`. The ceiling is a mock limit, not a live-provider claim. Invoice and transaction IDs are alphanumeric and at most 16 characters. The builder validates and escapes fields. XML parsing rejects DTDs, entity declarations, duplicate fields, nested scalar values, excessive structure, and wrong namespaces. The HTTP response is bounded to 16,384 received bytes, including chunked responses, and the deadline covers receiving the entire body. Equivalent `text/xml` media types with quoted or unquoted UTF-8 charset parameters are accepted; other charsets are rejected. Optional empty or omitted informational fields become null.

Only matching invoice, transaction ID, amount, and currency with outer OK, service OK, and a recognized financial result establish an outcome:

| Result | Persisted state |
| --- | --- |
| Approved | SUCCEEDED, at the simulated authorization and posting threshold. This does not establish settlement. |
| Declined | FAILED, with `Declined` retained. |
| Selected final Incomplete fixture | FAILED, with `Incomplete` retained separately. |
| DuplicateTransaction | UNKNOWN. Matching echoes do not prove the earlier financial outcome. |
| Timeout, lost reply, invalid HTTP/XML, mismatched echoes, invalid result layers | UNKNOWN. |

One result transaction updates the attempt and intent, increments the revision, completes provider work and clears its claim, appends a financial event, and stores its exact webhook payload. UNKNOWN also creates one REQUIRED reconciliation case in that transaction. Any failure rolls back all those writes. Webhook delivery is separate work; this ticket only persists it.

UNKNOWN completes automatic financial submission. Lookup never contacts the provider. A new attempt remains blocked until manual reconciliation establishes definite failure. The provider repeat operation is not used. Creation and confirmation replays retain their original acknowledgments, while lookup and financial events carry the current state and revision.

## Observation and diagnostics

Completion requires the current claim token, owner, unexpired lease, PROCESSING attempt, and PROCESSING parent. The result transaction acquires a write lock before reading lease time so lock contention cannot bypass expiry. A received response rejected by those guards appends bounded `PROVIDER_RESPONSE_OBSERVED` history with the exact attempt, account, transaction ID, classification, useful references, and observation time. Malformed XML, oversized bodies, and invalid HTTP responses retain their safe classification even when no parsed provider fields are available. These observations change no financial state or revision and create no webhook. Contradictory evidence against an already resolved result emits `provider_observation_conflicts` with the attempt ID. A lost connection or aborted transport has no received-response observation; a rejected stale transport result emits `provider_transport_not_applied`. A hard-aborted request cannot supply a later response observation.

Only allowlisted result codes and bounded parsed references are retained. Arbitrary provider error messages and raw SOAP stay out of storage and logs. Worker diagnostics contain a fixed code, worker identity, and the attempt ID when available. Storage failures leave the unfinished claim for bounded lease recovery. Manual resolution and the full overlapping-process recovery matrix are covered by their dependent tickets.

## Verification

`bun run test tests/provider` runs real API, worker, and mock processes with separate SQLite files. It covers both merchant accounts, exact wire amounts and IDs, approval/decline/incomplete/unknown outcomes, duplicate ambiguity, original acknowledgment replay, stale confirmation rejection, deliberate retries, immutable inputs, result rollback, observation-only history, and migration of an already accepted attempt. A test-only HTTP proxy forwards actual mock requests and alters the returned response to exercise malformed XML, streaming byte limits, deadlines, media types, and redirects. No application route accepts a fabricated payment result.

The reconciliation migration adds a new table and constraints without rebuilding payment tables. Unique attempt ownership, case identity, allowed states, and record retention are enforced in SQLite. Earlier attempt, event, acknowledgment, financial-input, and webhook-payload constraints remain active.
