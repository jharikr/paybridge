# 09: Complete headless checkout and verified return

**What to build:** A headless payer can inspect and confirm an authorized checkout, leave without changing payment state, and return to the correct merchant order. The merchant verifies the financial outcome through persisted Paybridge state before applying a local paid effect.

**Blocked by:** 06: Recover interrupted provider work safely; 08: Persist merchant orders, bindings, and commands.

**Status:** completed

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [checkout contract](../reference-contract.md#9-checkout-protocol-without-a-ui), and [merchant return behavior](../reference-contract.md#10-merchant-return-and-consumer-behavior).

**User stories:** 14, 15, 16, 17, 18, 19, 21, 24, 25, 26, 49, 50, 51, 53, 56, 57, 58, 59.

**Testing decisions:** 5, 6, 7, 15, 16, 17.

- [x] Require the random payment-bound checkout capability for display, confirmation, and leave. A payment ID alone is insufficient. A missing, invalid, or differently bound capability returns the generic not-found response and cannot disclose another payment. Do not treat the capability as a merchant API credential.
- [x] Display returns the agreed JSON payment ID, amount, currency, state, revision, and confirm/leave paths for PENDING or FAILED. Other financial states return the documented conflict. Keep the flow headless, without a payer UI or card-entry form.
- [x] Checkout confirmation calls the shared payment operation with the synthetic reference, expectedRevision, and required command key. Scope identity to the owning merchant and distinguish the checkout operation from other command targets. Apply the same atomic state, revision, ownership, and unresolved-attempt guards as direct confirmation.
- [x] Commit the accepted attempt, work, history, and exact checkout acknowledgment before returning 303. Replays return the original 303 and Location even after financial state changes. Changed input under an existing key conflicts, and a new stale-revision command creates no attempt or work.
- [x] Construct the return URL from the stored permitted destination using a URL builder. Preserve existing query parameters and safely encode the payment ID. Reject unsafe schemes and unapproved origins rather than accepting a caller-supplied redirect target.
- [x] Leave returns 303 after capability validation in PENDING, PROCESSING, FAILED, UNKNOWN, SUCCEEDED, and CANCELLED. It needs no idempotency key and changes no payment state, revision, attempt, provider work, financial history, or webhook. Repeated leave is harmless. Do not implement the former checkout cancellation operation.
- [x] Leaving a payable intent permits later resumption. Leaving an in-flight or unknown payment does not cancel the provider request or enable another attempt. Permanent cancellation remains the authenticated merchant operation, with the sample's cancelled binding preserved.
- [x] The return route establishes merchant context from the configured fixture route and checks that the payment ID belongs to that merchant's known order binding. Missing or substituted bindings return a generic not-found response. Query parameters and navigation alone cannot mark an order paid.
- [x] When local evidence is incomplete or return arrives before a usable final notification, fetch the current Paybridge snapshot with the receiving merchant's credential. Accept PROCESSING and UNKNOWN as legitimate results. Use an applicable final local snapshot when available, following the reference contract.
- [x] Introduce one merchant snapshot-application operation for lookup and later inbox use. Validate owning merchant, intent/order binding, amount, currency, and business reference. Atomically accept only a newer revision and apply the local order-paid effect once on SUCCEEDED. Equal or older snapshots cannot regress state or repeat the effect; revision gaps are allowed.
- [x] Prove lookup accepts a newer PROCESSING snapshot after a previous FAILED state. Race repeated returns and lookup applications to show one durable paid effect. A failed transaction leaves both the local payment view and order effect unchanged. External fulfillment is out of scope.
- [x] Repeat the stale-confirmation scenario through checkout: delayed different-key command after decline conflicts, accepted-key replay retains its original 303, and a deliberate new command with the failed revision succeeds. Prove the same payment rules apply to both confirmation entry points.
- [x] Test capability substitution, ownership-scoped return, return before financial completion or webhook delivery, every-state leave, and safe URL handling through real HTTP. Reject real card payloads and unexpected fields. Keep descriptions inert, sensitive responses uncached, capabilities out of logs, and generated OpenAPI consistent with actual headers, JSON errors, and 303 behavior.

## Implementation evidence

2026-10-11: Completed in `implement/paybridge-poc-09`, based on integration `cf82e3d`, after independent review.

- `contracts/checkout.ts` and `apps/paybridge/checkout.ts` provide capability-bound display, confirmation, and navigation-only leave. `confirmPayment` accepts a discriminated acknowledgment mode and retains checkout's exact `303` in the same transaction as attempt acceptance, provider work, history, and revision. Direct and checkout routes share response handling and financial guards. Return locations use the immutable permitted destination and a URL builder.
- `apps/merchant/snapshots.ts` owns the shared snapshot application operation. It accepts only common lookup/event facts, checks the receiving merchant and bound order's amount, currency, and reference, and applies a newer revision and the local paid effect in one write-first transaction. Equal/older revisions retain the accepted view and paid timestamp; gaps are allowed. Lookup and the new fixture-scoped return route both use it. SUCCEEDED/CANCELLED can reuse final local evidence; FAILED remains refreshable. No migration, receiver, or inbox worker was added.
- Real HTTP/process tests cover capability substitution and deactivated owners, two merchant/provider accounts sharing command keys, exact replay after decline, changed input, stale different-key rejection, deliberate fresh confirmation, competing direct/checkout commands, safe stored URLs, inert descriptions, strict bodies, and leave in all six states. Repeated leave preserves every payment, attempt, command, work, history, and webhook record.
- SIGKILL tests cover checkout acceptance before commit and a lost committed redirect followed by restart and exact replay. Merchant rollback and precommit termination preserve both local payment view and UNPAID order. Twelve concurrent return/lookup calls across two merchant processes apply a revision gap with one paid timestamp. A later merchant restart reuses the retained final snapshot even when Paybridge is unavailable.
- A real Paybridge response gate holds an older FAILED lookup while PROCESSING and SUCCEEDED apply. Releasing that response preserves the newer paid result. An IPC-only test consumer submits real HTTP snapshot facts through the shared persistence operation, proving owner/amount/currency/reference rejection without record changes and a valid successful control case. It adds no runtime endpoint or inbox implementation.
- Applied TDD, TypeScript best practices, unslop, and deslop. Initial checkout/return HTTP tests failed with missing routes. Focused regressions exposed unsafe revisions reaching a database CHECK, missing security headers in Paybridge's inherited error documentation, and JSON media incorrectly advertised for empty text redirects. Boundary validation and OpenAPI schemas now cover those cases. The existing merchant command test now expects authoritative lookup to mark the order paid while acknowledgment replay preserves that state.
- `bun run test` passed **155 tests in 31 files**, including **24 checkout/return tests in 6 files**. `bun run typecheck` passed. Real HTTP requests, JSON errors, response media, redirect/security headers, and request schemas were checked against generated OpenAPI with Ajv. All process coordination stays in trusted test fixtures, and financial outcomes come from the durable synthetic provider.

Independent review found no issues after inspecting the full change and all new files. The reviewer independently passed 72 checkout, merchant, and payment tests in 18 files, plus typechecking and diff checks.

Usage and scope are documented in `apps/paybridge/checkout.md` and `apps/merchant/README.md`. No live-provider claim or external fulfillment effect is added.
