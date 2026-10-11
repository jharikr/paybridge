# Signed webhook delivery and receipt

The Paybridge worker delivers the exact stored `payment.succeeded`, `payment.failed`, `payment.unknown`, and `payment.cancelled` event bodies. Delivery retries preserve the event ID, revision and bytes. They do not repeat the financial payment or change its result.

Run the merchant API and Paybridge worker in separate terminals after starting the Paybridge API and mock:

```sh
node apps/merchant/server.ts .data/merchant.db 3101 http://127.0.0.1:3100 http://127.0.0.1:3101
node apps/paybridge/worker.ts .data/paybridge.db http://127.0.0.1:3102 3000 10000 250 1000 60000
```

Worker arguments are the Paybridge database path, mock origin, HTTP timeout, lease duration, poll interval, initial webhook retry delay and retry cap. All durations are milliseconds. The command shows the defaults. Timeout must be shorter than the lease and initial retry delay must not exceed the cap. Retries double their delay up to the cap and continue while delivery remains unsuccessful. Delivery resumes only when workers run and the receiver becomes available.

The process runs the provider loop on its main thread and the webhook loop on a Node worker thread. Each owns a Paybridge database connection. The installed SQLite driver uses synchronous busy waits; two asynchronous loops on one event loop can block the transaction that would release their lock. Separate threads let that transaction finish. Both loops keep external HTTP outside transactions. No broker or general job framework is involved.

SIGTERM and SIGINT stop new work, allow bounded in-flight HTTP and completion to finish, and close both connections. A thread exception or unexpected thread exit stops the other loop and fails the process. SIGKILL leaves committed claims available after lease expiry. The provider-only test entrypoints remain available for financial recovery tests.

## Wire contract

Each merchant has one seeded destination and secret. The destinations are `/api/webhooks/paybridge/merchant-a` and `/api/webhooks/paybridge/merchant-b`; their synthetic secrets are `mock-webhook-secret-a` and `mock-webhook-secret-b`. Neither destination nor secret comes from payment input or event fields.

The sender uses `Content-Type: application/json`, `Paybridge-Event-Id`, `Paybridge-Timestamp` and `Paybridge-Signature`. The timestamp is current Unix seconds. The signature is `v1=` followed by the lowercase hexadecimal HMAC-SHA256 of the UTF-8 timestamp, one period, and the exact persisted body bytes. Every HTTP attempt calculates its timestamp and signature again. Any 2xx acknowledges receipt; redirects are rejected and response bodies are cancelled without reading them. Non-2xx, disconnects and deadlines retain retryable work with a bounded diagnostic code.

The receiver accepts at most 16,384 bytes of UTF-8 JSON. It selects its merchant from the configured route, checks signature format and length, compares decoded HMAC bytes in constant time, and verifies the timestamp before decoding or parsing. `WEBHOOK_TOLERANCE_SECONDS` configures the merchant process's window from 0 to 3,600 seconds, default 300. Both future and past boundaries are inclusive. The receiver rejects malformed UTF-8, a byte-order mark, invalid event facts, conflicting duplicate identity fields, unknown fields and a mismatched event header. `createdAt` is a valid UTC timestamp with seconds or exactly three fractional digits.

`/openapi.json` documents the JSON shape, headers and response schemas. Valid authentication does not prove ownership of a local order. Receipt stores the authenticated receiving merchant separately; the later snapshot transaction must check that context against the binding and business facts.

| Response | Meaning |
| --- | --- |
| 204 | The exact receipt is committed, or an identical receipt already exists in the same receiving context. Order processing remains pending. |
| 400 | Invalid event schema, encoding or identity. |
| 401 | Invalid signature, timestamp or receiving context. |
| 409 | The event ID already belongs to different bytes or a different authenticated receiving merchant. |
| 413 / 415 | Request too large or unsupported media type/charset. |
| 500 / 503 | Receipt failed to commit. A temporary storage failure includes `Retry-After: 1`. |

Every response includes `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Diagnostics contain fixed causes and request/event/worker identifiers, without signature headers, secrets or raw payloads.

## Durable ownership

A short sender transaction takes SQLite write access, reads fresh lease time and claims due or expired work with a new token. After commit it checks that the full HTTP deadline fits the remaining lease. Completion takes write access before checking fresh time and requires the same token, owner, PROCESSING state and unexpired lease. A stale success cannot finish another sender's claim; a stale failure cannot reschedule it.

The merchant commits the exact UTF-8 payload, its SHA-256 hash, event ID, receiving merchant, intent ID, type, revision and receipt time before 204. An early receipt has no payment-binding foreign key and stays PENDING until processing can match it. Event identity and receipt bytes cannot be updated or deleted. Processing claims must have complete lease ownership, counters cannot decrease, and a processed receipt cannot be reset. The [merchant inbox worker](merchant-inbox.md) consumes receipts through the shared `applyPaymentSnapshot` transaction; receipt alone does not pay an order.

The additive merchant migration retains existing orders, bindings and cached acknowledgments. The Paybridge migration adds claim indexes without rebuilding financial tables or changing stored event bodies. No retention purge is introduced.

## Verification

`bun run test tests/webhooks` launches real APIs, workers and receivers against isolated SQLite files. It verifies byte-sensitive signatures, independent HMAC calculations, two merchant contexts, configured timestamp bounds, actual OpenAPI responses, early receipts, immutable records, concurrent duplicates, bounded contention, capped retries and HTTP transport failures.

The test command caps concurrent test files at four. Vitest's default on the development host starts 13 file workers, each spawning multiple Node services, which exhausted five-second orchestration budgets during combined runs. This cap leaves process races within each test concurrent and changes no test timeout, HTTP deadline or lease duration.

SIGKILL cases reopen the same files before receipt commit, after commit before acknowledgment, after acknowledgment, after sender claim, after response and inside completion. Overlap cases keep the replacement sender's claim live while releasing an older success or failure. Separate cases hold SQLite writers and readers past a lease to verify claim and completion time checks. Controlled scheduling clocks leave real transport deadlines intact.

The outage test stops the merchant while the production worker finishes cancellation, approval, decline and UNKNOWN. It kills the worker, restarts both services, and checks all four receipts against their original bytes and IDs. Independent database inspection proves unchanged payment states, attempts, financial history and mock ledger effects. Migration tests deliver an old pending event and replay an old cached creation acknowledgment after upgrade. Thread-failure and SIGTERM tests check process exit and retained retry work.
