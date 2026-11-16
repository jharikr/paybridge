# 10: Deliver signed events into a durable merchant inbox

**What to build:** A committed payment event reaches the configured merchant endpoint as a signed notification and is durably received before acknowledgment. Outages, duplicate delivery, and crashes retry the same event without changing the financial payment.

**Blocked by:** 08: Persist merchant orders, bindings, and commands.

**Status:** completed

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [webhook contract](../reference-contract.md#11-webhook-contract), and [merchant receipt rules](../reference-contract.md#merchant-inbox-transaction-rules).

**User stories:** 46, 47, 48, 52, 53, 54, 55, 56, 59, 61, 63.

**Testing decisions:** 9, 14, 15, 17.

- [x] Deliver the stored payment.succeeded, payment.failed, payment.unknown, and payment.cancelled snapshots through one configured endpoint and signing secret per merchant. Endpoint configuration is seeded, not supplied per payment. Keep stable event identity, revision, and exact payload bytes from the transaction that recorded the financial result.
- [x] The local webhook loop claims due work atomically with a fresh token and expiring lease. Commit before bounded external HTTP. Guard completion by claim ownership, reclaim expired work, and use capped backoff for failed deliveries. Reuse the local worker architecture without adding a broker or scheduling platform.
- [x] For each HTTP attempt, sign the UTF-8 bytes of timestamp, a period, and the exact stored body using HMAC-SHA256. Send the agreed event ID, Unix-seconds timestamp, and versioned lowercase-hex signature headers. Retry with the same event ID and body but a current timestamp and newly calculated signature.
- [x] Determine the receiving merchant and signing secret from the configured callback destination. Never select either from untrusted body data. Preserve raw body bytes for verification, bound request size, validate signature encoding and length, and compare decoded signatures in constant time.
- [x] Enforce a configurable timestamp window with the agreed 300-second default in both past and future directions. Verify schema, supported event type, and matching header/body identity. Invalid schema or identity returns 400; invalid signature or timestamp returns 401.
- [x] Persist a verified receipt with event ID, authenticated receiving merchant, intent ID, revision, exact payload, receipt time, and pending processing state before returning 204. Do not require the local payment binding to exist for receipt persistence. A restrictive foreign key must not discard an early valid event.
- [x] A verified duplicate with identical bytes and receiving context returns 204 without another work item. Reusing an event ID with different bytes or receiving merchant returns 409 and an actionable diagnostic. Prove both same-merchant duplication and cross-merchant substitution.
- [x] A failed receipt commit returns the agreed 503 or 500 response, never success. Any 2xx acknowledges delivery to Paybridge; non-2xx responses, timeouts, and lost acknowledgments retain retryable work. Receipt acknowledgment does not claim that the merchant order has already been updated.
- [x] Terminate the merchant before receipt commit, after receipt commit but before acknowledgment, and after acknowledgment. Prove the appropriate redelivery or durable pending receipt after restart. A lost acknowledgment may cause duplicate delivery, but not duplicate receipt identity.
- [x] Terminate the delivery worker around send and completion, and race expired or overlapping claims. Prove stale completions cannot overwrite current delivery ownership and pending work survives restart with its original payload and event identity.
- [x] Simulate a merchant outage, then restore it and continue the workers. Delivery must resume without changing payment state, financial attempt identity, provider ledger effects, or the persisted financial event. Do not promise eventual delivery while the receiver remains unavailable or workers remain stopped.
- [x] Generate matching OpenAPI for the merchant receiver's raw-body contract, headers, validation errors, and acknowledgment statuses. Test actual byte-sensitive signatures, tampering, timestamp boundaries, schema failures, and configured merchant context. Retain receipts and redacted diagnostic causes for the prototype data lifetime.

## Comments

### Implementation and focused verification

The sender and receiver now use the persisted event bytes and destination-specific HMAC authentication. Receipt commits exact bytes and authenticated context before 204; early receipts remain PENDING without a payment-binding foreign key. Additive migrations retain old orders, acknowledgments and financial events while adding the inbox and delivery indexes.

The installed SQLite driver performs synchronous busy waits. A real two-loop delivery test exposed lock waits when both connections shared one Node event loop. The worker now keeps provider execution on the main thread and webhook delivery on a worker thread, each with its own connection. The same test passes within its three-second deadline. Thread failure and unexpected normal exit fail the process; SIGTERM closes both loops after bounded in-flight work. The existing provider-only recovery fixtures are unchanged.

Initial focused verification with `bun run test tests/webhooks` passed 34 tests across 12 files after integrating ticket 09. The startup-failure regression added during review brings the final webhook coverage to 35 tests. `bun run typecheck` and `git diff --check` pass. Tests cover exact UTF-8/HMAC bytes, real OpenAPI request/response/header validation including 500/503, early receipt retention, two-process duplicates, all receiver/sender crash boundaries, stale success and failure fencing, write/commit lease delays, capped retries, transport bounds, migration retention and a real outage/restart across all four event types. The outage assertions retain exact payment, attempt, event and mock ledger records.

TDD regressions caught unimplemented receipt/delivery, missing OpenAPI authentication headers, UTF-8 BOM stripping, invalid calendar dates, conflicting duplicate JSON identity keys returning 500, and unexpected thread exit being treated as successful shutdown. Each now passes after the corresponding correction. The deslop pass removed untyped JSON assumptions, reused the common merchant snapshot facts, and checked the complete ticket diff for unnecessary abstractions and diagnostics that expose private data.

### Review corrections and final verification

Independent review identified two integration-test defects. Financial record helpers compared full webhook rows while the combined worker legitimately advanced delivery counters and claims. A reduced real-process probe confirmed that payment, attempt, event and exact payload records stayed unchanged while the delivery count advanced from 0 to 2; the provider-only comparison stayed at 0. Both financial/navigation snapshot helpers now retain every immutable webhook column. The assembled tests still run the combined worker, and the sender tests assert mutable delivery ownership and retry state.

The thread-failure fixture posted readiness and immediately threw, allowing the error to reach the supervisor before the queued readiness message. An eight-worker reproduction observed that ordering once. The corrected fixture waits for an explicit test-process release through a validated, test-only channel after readiness. A separate pre-ready failure case verifies startup cleanup. Production IPC and worker behavior did not change for these review corrections.

The combined suite also exposed test-file resource contention. Installed Vitest defaults to available CPU count minus one, 13 file workers on this host, with each test file launching several Node services. Multi-process checkout and lost-response restart tests hit their unchanged 5-second orchestration budgets. Isolated cases took 2.3–2.4 seconds; eight concurrent checkout copies took 3.5–3.7 seconds. Capping concurrent test files at four made the full suite pass; the checkout case took 2.835 seconds and the two lost-response restart cases took 2.505 and 2.534 seconds. Every within-test process race, HTTP deadline, lease and test timeout remains unchanged.

Final verification passes all 202 tests across 48 files, plus `bun run typecheck` and `git diff --check`. The correction recheck returned **No findings**, including independent checkout, merchant recovery, webhook, reconciliation and recovery checks. The final deslop and unslop passes found no remaining cleanup. The branch includes integration through ticket 09.

Ticket 11 owns receipt consumption and the atomic order-paid effect; this ticket acknowledges durable receipt only. Local simulation assumptions remain unchanged.
