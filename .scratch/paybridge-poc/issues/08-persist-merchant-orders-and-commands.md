# 08: Persist merchant orders, bindings, and commands

**What to build:** The sample merchant application keeps one payment intent bound to each order and can resume interrupted creation or confirmation without issuing a different instruction. Both fixture merchants can use the same business references safely, and retries remain deliberate.

**Blocked by:** 05: Execute accepted attempts through the provider worker.

**Status:** ready-for-agent

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [merchant behavior](../reference-contract.md#10-merchant-return-and-consumer-behavior), and [merchant persistence](../reference-contract.md#merchant-database).

**User stories:** 3, 5, 6, 7, 8, 17, 18, 19, 20, 23, 26, 53, 56, 61, 63.

**Testing decisions:** 5, 6, 7, 9.

- [ ] Implement the sample application's local HTTP-driven order and payment flow with its own durable SQLite database. Keep both seeded merchant contexts in that application, with their own Paybridge credentials, return context, and callback configuration. Communicate with Paybridge over HTTP rather than reading its database.
- [ ] Persist merchant ownership on orders, payment bindings, and prepared commands. Scope business-reference uniqueness and command-key uniqueness to the merchant. Enforce consistent ownership and one intent binding per order with guarded writes and applicable constraints.
- [ ] Persist each normalized creation or confirmation request, operation, target, command number, merchant identity, and stable key before sending HTTP. Use the owning merchant's server-side credential. Distinguish PREPARED from COMPLETED commands and retain the exact acknowledgment.
- [ ] After creation, persist the returned intent binding and acknowledgment before confirmation can proceed. Repeated requests for the same sample order reuse that binding. Paybridge's allowance for repeated merchant references must not cause the sample to create multiple collectible intents for one order.
- [ ] Recover a lost create or confirm response by resending the original stored command and key, including after actual sample-process termination and restart. Cover crashes before send, after remote commit, and before local acknowledgment persistence. No recovery path generates a replacement key or intent merely because a response was lost.
- [ ] Use distinct command numbers and keys for deliberate new attempts after definite failure, on the same intent. Retrieve the current revision using the correct merchant credential. A stale-revision conflict requires a refreshed view and deliberate new confirmation; refreshing must not automatically resubmit the old instruction.
- [ ] Treat cached 201 and 202 responses as acknowledgments of their original commands. A replayed acknowledgment must not regress a newer local payment view or mark an order paid. Ticket 09 introduces authoritative lookup application, and ticket 11 extends that same operation to inbox processing.
- [ ] Retain an explicitly cancelled intent, its local order binding, command records, and history. Reject replacement intent creation for that same sample order. UNKNOWN likewise cannot be escaped by creating another intent or starting another attempt.
- [ ] Demonstrate both merchants using the same business reference without collisions. Substitute merchant context, order ID, intent ID, or command ownership and prove one merchant cannot resume or confirm the other's payment.
- [ ] Demonstrate complete direct creation and confirmation, definite decline, deliberate retry, and eventual approval using real local services. Independently assert the stable order binding, command identities, attempt identities, and mock financial effects.
- [ ] Preserve sensitive cached creation acknowledgments without logging checkout capabilities, provider credentials, or API credentials. Keep outputs headless and synthetic. Do not add onboarding, merchant login, external fulfillment, a generic outgoing queue platform, or replacement-order workflows.

