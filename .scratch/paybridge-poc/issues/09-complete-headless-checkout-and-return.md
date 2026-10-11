# 09: Complete headless checkout and verified return

**What to build:** A headless payer can inspect and confirm an authorized checkout, leave without changing payment state, and return to the correct merchant order. The merchant verifies the financial outcome through persisted Paybridge state before applying a local paid effect.

**Blocked by:** 06: Recover interrupted provider work safely; 08: Persist merchant orders, bindings, and commands.

**Status:** ready-for-agent

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [checkout contract](../reference-contract.md#9-checkout-protocol-without-a-ui), and [merchant return behavior](../reference-contract.md#10-merchant-return-and-consumer-behavior).

**User stories:** 14, 15, 16, 17, 18, 19, 21, 24, 25, 26, 49, 50, 51, 53, 56, 57, 58, 59.

**Testing decisions:** 5, 6, 7, 15, 16, 17.

- [ ] Require the random payment-bound checkout capability for display, confirmation, and leave. A payment ID alone is insufficient. A missing, invalid, or differently bound capability returns the generic not-found response and cannot disclose another payment. Do not treat the capability as a merchant API credential.
- [ ] Display returns the agreed JSON payment ID, amount, currency, state, revision, and confirm/leave paths for PENDING or FAILED. Other financial states return the documented conflict. Keep the flow headless, without a payer UI or card-entry form.
- [ ] Checkout confirmation calls the shared payment operation with the synthetic reference, expectedRevision, and required command key. Scope identity to the owning merchant and distinguish the checkout operation from other command targets. Apply the same atomic state, revision, ownership, and unresolved-attempt guards as direct confirmation.
- [ ] Commit the accepted attempt, work, history, and exact checkout acknowledgment before returning 303. Replays return the original 303 and Location even after financial state changes. Changed input under an existing key conflicts, and a new stale-revision command creates no attempt or work.
- [ ] Construct the return URL from the stored permitted destination using a URL builder. Preserve existing query parameters and safely encode the payment ID. Reject unsafe schemes and unapproved origins rather than accepting a caller-supplied redirect target.
- [ ] Leave returns 303 after capability validation in PENDING, PROCESSING, FAILED, UNKNOWN, SUCCEEDED, and CANCELLED. It needs no idempotency key and changes no payment state, revision, attempt, provider work, financial history, or webhook. Repeated leave is harmless. Do not implement the former checkout cancellation operation.
- [ ] Leaving a payable intent permits later resumption. Leaving an in-flight or unknown payment does not cancel the provider request or enable another attempt. Permanent cancellation remains the authenticated merchant operation, with the sample's cancelled binding preserved.
- [ ] The return route establishes merchant context from the configured fixture route and checks that the payment ID belongs to that merchant's known order binding. Missing or substituted bindings return a generic not-found response. Query parameters and navigation alone cannot mark an order paid.
- [ ] When local evidence is incomplete or return arrives before a usable final notification, fetch the current Paybridge snapshot with the receiving merchant's credential. Accept PROCESSING and UNKNOWN as legitimate results. Use an applicable final local snapshot when available, following the reference contract.
- [ ] Introduce one merchant snapshot-application operation for lookup and later inbox use. Validate owning merchant, intent/order binding, amount, currency, and business reference. Atomically accept only a newer revision and apply the local order-paid effect once on SUCCEEDED. Equal or older snapshots cannot regress state or repeat the effect; revision gaps are allowed.
- [ ] Prove lookup accepts a newer PROCESSING snapshot after a previous FAILED state. Race repeated returns and lookup applications to show one durable paid effect. A failed transaction leaves both the local payment view and order effect unchanged. External fulfillment is out of scope.
- [ ] Repeat the stale-confirmation scenario through checkout: delayed different-key command after decline conflicts, accepted-key replay retains its original 303, and a deliberate new command with the failed revision succeeds. Prove the same payment rules apply to both confirmation entry points.
- [ ] Test capability substitution, ownership-scoped return, return before financial completion or webhook delivery, every-state leave, and safe URL handling through real HTTP. Reject real card payloads and unexpected fields. Keep descriptions inert, sensitive responses uncached, capabilities out of logs, and generated OpenAPI consistent with actual headers, JSON errors, and 303 behavior.

