# Merchant inbox processing

The merchant receiver commits an authenticated receipt before acknowledging delivery. A separate local worker applies its payment snapshot and marks the receipt processed in one merchant database transaction. Receipt acceptance alone does not pay an order.

Run the inbox worker alongside the merchant API and Paybridge worker:

```sh
node apps/merchant/worker.ts .data/merchant.db 10000 250 1000 60000
```

The arguments are merchant database path, claim lease, poll interval, initial retry delay and retry cap. Durations are milliseconds; the command shows defaults. The lease accepts 1–300,000 ms, polling 1–60,000 ms, initial delay 1–300,000 ms, and cap 1–3,600,000 ms. Initial delay must not exceed the cap. Retries double up to the cap and continue while the receipt cannot be applied. The worker opens only the merchant database. It uses no provider or Paybridge connection and makes no HTTP requests.

Startup applies the existing merchant migrations and verifies the Prisma contract before reporting `{ "kind": "ready", "workerId": "inbox_..." }` to a parent process over Node IPC. Standalone CLI runs have no startup banner. SIGTERM and SIGINT interrupt idle polling, stop new iterations and close the database after the current local operation finishes. SQLite contention remains bounded by the driver's five-second busy timeout. SIGKILL leaves committed work for a later worker to reclaim after lease expiry. Restart the same command against the same file; startup never clears receipts or orders.

## Claim and application

Each claim takes SQLite write access before reading fresh time, sets a new token and worker ID, and increments the attempt count. It selects a due PENDING receipt or expired PROCESSING receipt. Application takes write access again and checks the same event, token, worker, PROCESSING state and a still-live lease. A claim exhausted by commit contention cannot apply a snapshot. An old worker cannot complete or reschedule a replacement worker's claim, even if its own scheduling clock still considers the old lease valid.

The worker parses the retained payload and passes its common payment snapshot to `apps/merchant/snapshots.ts`. This is the same operation used by lookup and verified return. It requires the authenticated receiving merchant to own both the binding and order, then checks intent identity, amount, currency and business reference. An early receipt can remain pending without a binding. A wrong association never redirects work to another merchant, even when both orders share a business reference.

A newer revision replaces the local payment snapshot. SUCCEEDED changes an UNPAID order to PAID and records its first paid timestamp. Equal or older revisions preserve the accepted view and paid timestamp; their valid receipts still become PROCESSED. Revision gaps are valid because creation and PROCESSING transitions do not emit notifications. In all cases, snapshot application, any local paid effect and receipt completion commit together. Failure rolls them all back. External fulfillment is outside this prototype.

Unmatched or conflicting associations return to PENDING with `inbox_binding_unmatched` or `inbox_binding_conflict`. A rolled-back application can retry with `inbox_application_failed`. These fixed codes, the event ID and worker ID provide diagnostics without logging payloads, credentials, checkout capabilities or signatures. A stale worker reports `inbox_claim_lost` without altering the receipt. A storage failure retains retryable work and reports a fixed storage or iteration diagnostic.

The receipt retains its original bytes, hash, receiving context, identity, revision and receipt time. Processing adds attempts, scheduling, ownership and completion facts. `last_error` retains the most recent application diagnostic even after recovery; it is not a separate history of every polling attempt. PROCESSED receipts cannot be reset or deleted. No retention purge or schema change is introduced by this worker.

## Observe notification application

After creating and confirming a bound order, wait for notification delivery and inbox processing before making a payment lookup or visiting the return handler. Those two routes can apply the same verified snapshot themselves. Read only the local order to observe the inbox result:

```sh
curl --fail http://127.0.0.1:3101/merchant-a/orders/ORDER_ID
```

Use the order ID from its creation acknowledgment. This route reports `state`, `paidAt` and the bound payment intent ID without contacting Paybridge. For independent evidence, inspect the merchant database read-only: the corresponding `webhook_inbox` row must be PROCESSED, `merchant_payments.last_applied_revision` must match the accepted event, and the order's original `paid_at` must survive redelivery and restart. The worker may be stopped while inspecting completed records. The [webhook delivery guide](webhook-delivery.md) describes sender retries and signed receipt acceptance.

## Verification

`bun run test tests/inbox` starts real Node APIs and workers against three isolated database files. The cases cover authenticated receiving context, wrong amount/reference bindings, early binding recovery, revision gaps, equal and older snapshots, out-of-order wire delivery, duplicate receipts, lookup races, competing claims and a single retained paid timestamp. Independent mock ledger inspection counts actual financial effects.

SIGKILL cases terminate the worker after claim, during the application transaction and after commit. Restart reopens the same database and proves that partial snapshots and paid effects do not survive. Other cases hold SQLite readers and writers beyond the lease, reject stale ownership while a replacement claim is still PROCESSING and after it is PROCESSED, and verify capped backoff without changing receipt facts. The production entrypoint also proves IPC readiness and graceful interruption of a long idle poll.

The outage journey binds four orders, stops the receiver, and lets Paybridge finish cancellation, approval, decline and UNKNOWN. After receiver and worker restart, all four original receipts become PROCESSED. Only the approved order becomes PAID. Local order reads establish this result without triggering a payment refresh. Paybridge intents, attempts, financial events and mock ledger records remain identical while delivery and local application retry.

Failure checkpoints and scheduling clocks exist only in test process entrypoints. There is no public fault route or production state override.
