# 11: Apply notifications without repeating merchant effects

**What to build:** The sample merchant consumes durable receipts in any delivery order and converges on the newest verified payment snapshot. Inbox processing and lookup share one guarded operation, so retries, races, and restarts produce one local paid effect.

**Blocked by:** 09: Complete headless checkout and verified return; 10: Deliver signed events into a durable merchant inbox.

**Status:** completed

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [merchant inbox rules](../reference-contract.md#merchant-inbox-transaction-rules), and [ordering guarantees](../reference-contract.md#delivery-and-ordering-guarantees).

**User stories:** 48, 49, 50, 51, 52, 53, 54, 55, 56, 61, 63.

**Testing decisions:** 9, 14, 15.

- [x] Run a local merchant inbox worker over durable pending receipts. Claim with fresh ownership tokens and leases in short transactions, reclaim expired work, and guard completion against stale ownership. Keep recoverable retries on capped backoff without adding a worker framework.
- [x] Before any effect, require the authenticated receiving merchant on the receipt to match the local payment binding and order owner. Validate intent identity, amount, currency, and business reference. Any Paybridge lookup uses that merchant's server-side credential.
- [x] Keep unmatched or conflicting bindings pending with an actionable redacted diagnostic. Prove an event received before its local binding survives and processes once the matching binding is available. Never redirect it to another merchant's order or discard it to satisfy a local foreign key.
- [x] Apply snapshots through the operation introduced for lookup. In one merchant database transaction, compare the persisted revision, apply a newer snapshot, perform the guarded local order-paid effect when appropriate, and mark the claimed inbox receipt processed. Transaction failure rolls back all these effects.
- [x] A repeated receipt or another snapshot at an equal or older revision produces no second paid effect and cannot regress the payment view. Retain the receipt and mark a valid stale snapshot processed so it does not retry forever.
- [x] Accept noncontiguous revisions because creation and processing have no webhook event types. A newer PROCESSING lookup can follow FAILED. Prove an older failed or unknown notification cannot overwrite a newer success.
- [x] Deliver duplicated, delayed, and reordered valid signed notifications through the actual receiver. Verify one durable receipt per event and one local paid effect, using persisted merchant state rather than mock invocation counts.
- [x] Race lookup against inbox processing, including repeated success observations, an older event completing late, and competing worker claims. Guarded revision application and the paid effect must commit once, with stale claim completion unable to alter current work ownership.
- [x] Terminate and restart the inbox worker before application, during its transaction, and after commit. Reopen the same merchant database. Pending work must resume, a partial paid effect must not remain, and committed processing must not repeat the effect.
- [x] A webhook authenticated for one fixture merchant cannot change the other's order, even when business references match or a payload identifies its intent. Preserve receiving context and the failed association for investigation.
- [x] Demonstrate a payment completing during a merchant outage, followed by durable delivery and inbox recovery when the receiver and workers resume. Provider state and financial effect remain unchanged while only notification and local application work retry.
- [x] Preserve historical receipts, revision evidence, and diagnostics for the lifetime of prototype data. The paid effect remains a guarded local database update. Do not add external fulfillment, customer notifications, strict revision-gap waiting, or a separate state-application implementation for webhooks.

## Comments

- 2026-10-11: Implemented the merchant inbox loop and `apps/merchant/worker.ts` entrypoint using ticket 10's retained receipt schema. No schema or migration change was needed. Claims acquire write access before reading lease time; completion checks current ownership and lease before calling the existing shared snapshot operation. Pending association failures use capped retry delays and retain a redacted last diagnostic after recovery.
- TDD evidence: the first real-process success test failed because the inbox entrypoint did not exist. The early-binding test then failed with a receipt stuck PROCESSING instead of PENDING with an association diagnostic. The rollback test failed with a PROCESSED receipt when the injected transaction checkpoint was not yet implemented. Each passed after its corresponding implementation. Added behavior tests cover equal and older revisions, wire-order reversal, lookup races, two workers, stale tokens before and after replacement completion, and real SQLite waits across lease expiry.
- Crash and outage evidence: SIGKILL after claim, inside completion and after commit reopens the same database and preserves atomic local effects. A real receiver outage completes four financial outcomes before delivery resumes. Restarted sender and inbox workers process the original events; local order reads prove application without payment lookup or return. Independent inspection preserves payment intents, attempts, financial history and mock ledger effects.
- Verification before independent review: `bun run test tests/inbox` passed 19 tests across 10 files; `bun run typecheck` and `git diff --check` passed. Applied TypeScript guidance, formatted only new files, and completed `/deslop` over this ticket's tracked diff and additions. Worker usage, IPC readiness, SIGTERM/SIGINT behavior, retained diagnostics and verification pointers are in `docs/merchant-inbox.md`. The combined suite subsequently passed all 221 tests across 58 files, followed by typecheck and diff-check.
- Independent `/review-agent` review reported **No findings** after inspecting all tracked and untracked changes and independently passing the 19 inbox tests across 10 files, typecheck and diff-check. Final `/deslop` and unslop checks found no further changes. Completion updates affect only this ticket record; the verified implementation is unchanged.
