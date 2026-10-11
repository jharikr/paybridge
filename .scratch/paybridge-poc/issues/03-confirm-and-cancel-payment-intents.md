# 03: Accept confirmations and enforce merchant cancellation

**What to build:** A merchant can durably accept one payment attempt against the revision it observed, or permanently cancel an intent before processing starts. Replays preserve the identity of the original instruction, and competing or rejected commands cannot leave partial financial work.

**Blocked by:** 02: Create and retrieve merchant-owned payment intents.

**Status:** ready-for-agent

**Group:** 2 of 6. Merchant boundary and payment commands.

**Source:** [Approved specification](../spec.md), [command contract](../reference-contract.md#8-merchant-api-contract), and [idempotency lifecycle](../reference-contract.md#12-idempotency-rules-and-lifecycle).

**User stories:** 3, 4, 12, 16, 19, 20, 22, 26, 27, 28, 35, 45, 56, 57, 59, 63.

**Testing decisions:** 5, 6, 7, 9, 16, 17.

- [ ] Route confirmation and cancellation through shared transactional payment operations, with the owning merchant established by authentication. Do not duplicate payment rules in route handlers. A stopped provider worker must not prevent durable command acceptance.
- [ ] Require a controlled synthetic payment-method reference, a valid command key, and a positive safe-integer expectedRevision for confirmation. Reject real card fields, unsupported input, and caller-supplied provider-account substitutions.
- [ ] Include expectedRevision, synthetic reference, operation, method, and target in the canonical command hash. Match an authenticated completed command before checking current revision or payment state. Return its exact original acknowledgment; changed input, operation, or target under the same key conflicts.
- [ ] For a new command, atomically require the current revision, PENDING or definite FAILED, and no PROCESSING or UNKNOWN attempt. An outdated revision returns 409 payment_revision_conflict without financial work. Missing or invalid revision input returns 400.
- [ ] In one transaction, allocate the next attempt number, retain the owning provider account and durable synthetic input, generate a globally unique valid provider transaction identity, change the intent to PROCESSING, increment revision, append history, enqueue one provider work item, and cache the completed acknowledgment.
- [ ] Enforce unique attempt numbering, one provider work item per attempt, and a partial unique constraint preventing multiple unresolved attempts per intent. Provider account, transaction identity, and synthetic input remain fixed on that attempt. Use collision checking for alphanumeric transaction identifiers of at most sixteen characters.
- [ ] Return 202 and the documented lookup Location only after durable acceptance. The acknowledgment identifies the exact attempt and acceptance revision. It establishes neither financial approval nor permission to mark an order paid.
- [ ] Prove concurrent same-key requests replay one acknowledgment and different-key requests based on one revision accept at most one attempt. A rollback or pre-commit process crash leaves neither partial work nor a stranded command reservation. A post-commit lost response survives restart and replays the original acknowledgment.
- [ ] Cancellation atomically permits only PENDING to CANCELLED, increments revision, appends history, and creates one durable payment.cancelled webhook payload. Return the documented 200 snapshot. Repeating cancellation returns the unchanged snapshot without another event, work item, or revision increment; other states conflict.
- [ ] Race cancellation against confirmation through HTTP. Exactly one valid transition wins, and the losing command leaves no partial attempt, cancellation history, or webhook. SUCCEEDED and CANCELLED remain terminal, and UNKNOWN cannot authorize another attempt.
- [ ] Retain records and keys without expiry. Use the agreed bounded contention and in-progress errors. Keep external calls outside command transactions, diagnostics redacted, sensitive responses uncached, and OpenAPI consistent with real responses.
- [ ] Close this slice with observable HTTP acceptance, replay, cancellation, rollback, and restart evidence. Ticket 05 supplies the actual decline-to-retry and delayed-command proofs; ticket 06 supplies unresolved recovery outcomes. Do not add a fake provider result endpoint to make this ticket appear complete.

