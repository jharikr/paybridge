# 08: Persist merchant orders, bindings, and commands

**What to build:** The sample merchant application keeps one payment intent bound to each order and can resume interrupted creation or confirmation without issuing a different instruction. Both fixture merchants can use the same business references safely, and retries remain deliberate.

**Blocked by:** 05: Execute accepted attempts through the provider worker.

**Status:** completed

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [merchant behavior](../reference-contract.md#10-merchant-return-and-consumer-behavior), and [merchant persistence](../reference-contract.md#merchant-database).

**User stories:** 3, 5, 6, 7, 8, 17, 18, 19, 20, 23, 26, 53, 56, 61, 63.

**Testing decisions:** 5, 6, 7, 9.

- [x] Implement the sample application's local HTTP-driven order and payment flow with its own durable SQLite database. Keep both seeded merchant contexts in that application, with their own Paybridge credentials, return context, and callback configuration. Communicate with Paybridge over HTTP rather than reading its database.
- [x] Persist merchant ownership on orders, payment bindings, and prepared commands. Scope business-reference uniqueness and command-key uniqueness to the merchant. Enforce consistent ownership and one intent binding per order with guarded writes and applicable constraints.
- [x] Persist each normalized creation or confirmation request, operation, target, command number, merchant identity, and stable key before sending HTTP. Use the owning merchant's server-side credential. Distinguish PREPARED from COMPLETED commands and retain the exact acknowledgment.
- [x] After creation, persist the returned intent binding and acknowledgment before confirmation can proceed. Repeated requests for the same sample order reuse that binding. Paybridge's allowance for repeated merchant references must not cause the sample to create multiple collectible intents for one order.
- [x] Recover a lost create or confirm response by resending the original stored command and key, including after actual sample-process termination and restart. Cover crashes before send, after remote commit, and before local acknowledgment persistence. No recovery path generates a replacement key or intent merely because a response was lost.
- [x] Use distinct command numbers and keys for deliberate new attempts after definite failure, on the same intent. Retrieve the current revision using the correct merchant credential. A stale-revision conflict requires a refreshed view and deliberate new confirmation; refreshing must not automatically resubmit the old instruction.
- [x] Treat cached 201 and 202 responses as acknowledgments of their original commands. A replayed acknowledgment must not regress a newer local payment view or mark an order paid. Ticket 09 introduces authoritative lookup application, and ticket 11 extends that same operation to inbox processing.
- [x] Retain an explicitly cancelled intent, its local order binding, command records, and history. Reject replacement intent creation for that same sample order. UNKNOWN likewise cannot be escaped by creating another intent or starting another attempt.
- [x] Demonstrate both merchants using the same business reference without collisions. Substitute merchant context, order ID, intent ID, or command ownership and prove one merchant cannot resume or confirm the other's payment.
- [x] Demonstrate complete direct creation and confirmation, definite decline, deliberate retry, and eventual approval using real local services. Independently assert the stable order binding, command identities, attempt identities, and mock financial effects.
- [x] Preserve sensitive cached creation acknowledgments without logging checkout capabilities, provider credentials, or API credentials. Keep outputs headless and synthetic. Do not add onboarding, merchant login, external fulfillment, a generic outgoing queue platform, or replacement-order workflows.

## Implementation evidence

2026-10-11: Completed in `implement/paybridge-poc-08` from integration `7417ab8` after independent review and correction recheck.

- `apps/merchant/` owns its Prisma contract, migration history, runtime database, fixture configuration, HTTP API, and durable command operations. `contracts/merchant.ts` defines strict inputs and public order/command results. Runtime reads only the merchant file and calls Paybridge over HTTP.
- Orders and command keys are merchant-scoped. The migration enforces consistent order ownership, one intent binding per order, one PREPARED command per order/operation, immutable order input and command identity, completed acknowledgment retention, and lifetime record retention. It creates only the approved separate merchant database and leaves prior application migrations unchanged.
- Creation and confirmation persist normalized request bytes, operation, target, command number, owner, and key before HTTP. Creation completes its acknowledgment and binding atomically. The command list and recovery route let a restarted caller resume the exact stored instruction. Temporary contention returns a bounded 503 with Retry-After; it never allocates a replacement key.
- Real HTTP journeys prove both merchants using the same reference, provider account routing, decline then deliberate approval on the same intent, retained stale-revision rejection, and blocked ownership substitutions. Cancelled and UNKNOWN payments retain their original sample binding. Command acknowledgments and read-only current-status lookup leave the local applied revision and order-paid state unchanged.
- Real process tests send SIGKILL before send, after response receipt, and inside local completion for both operations. Separate cases lose the response after remote commit and restart both caller and Paybridge API. Recovery reuses exact request/key/acknowledgment bytes. A local rollback leaves PREPARED work without a partial binding. Two merchant processes race twelve order creations, intent creations, and confirmations and converge on one of each logical record.
- `bun run test` passed 119 tests in 22 files, including 20 merchant tests. `bun run typecheck` and `git diff --check` passed. Merchant OpenAPI was checked against real requests and responses with Ajv. Focused negative tests exposed and fixed strict-input rejection after schema composition, SQLite's nullable CHECK behavior for unapplied snapshots, and transient writer-error classification.
- Applied TDD, TypeScript best practices, unslop, and deslop. The idempotence principle shaped prepared-command recovery; records guidance shaped immutable identity, exact acknowledgment retention, and the separate migration history. Authoritative local snapshot application and the paid effect remain in ticket 09; the webhook receiver remains in ticket 10. No generic outgoing queue or replacement-order flow was added.
- Independent review passed all 20 original merchant tests, typecheck, and diff-check, and found two response-header gaps. Red-green regressions now prove `nosniff` on sensitive responses, cached replay, and errors, and validate actual acknowledgment/security/Retry-After headers against the generated OpenAPI schemas. Both fixes passed all 21 merchant tests in 6 files, typecheck, and diff-check after deslop. The independent correction recheck found no remaining issues and passed the same 21 tests, typecheck, diff-check, and real HTTP header/OpenAPI probes.

Usage, routes, recovery behavior, and these scope boundaries are documented in `apps/merchant/README.md`.
