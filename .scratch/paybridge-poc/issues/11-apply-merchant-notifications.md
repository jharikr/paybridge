# 11: Apply notifications without repeating merchant effects

**What to build:** The sample merchant consumes durable receipts in any delivery order and converges on the newest verified payment snapshot. Inbox processing and lookup share one guarded operation, so retries, races, and restarts produce one local paid effect.

**Blocked by:** 09: Complete headless checkout and verified return; 10: Deliver signed events into a durable merchant inbox.

**Status:** ready-for-agent

**Group:** 5 of 6. Sample merchant, checkout, and notifications.

**Source:** [Approved specification](../spec.md), [merchant inbox rules](../reference-contract.md#merchant-inbox-transaction-rules), and [ordering guarantees](../reference-contract.md#delivery-and-ordering-guarantees).

**User stories:** 48, 49, 50, 51, 52, 53, 54, 55, 56, 61, 63.

**Testing decisions:** 9, 14, 15.

- [ ] Run a local merchant inbox worker over durable pending receipts. Claim with fresh ownership tokens and leases in short transactions, reclaim expired work, and guard completion against stale ownership. Keep recoverable retries on capped backoff without adding a worker framework.
- [ ] Before any effect, require the authenticated receiving merchant on the receipt to match the local payment binding and order owner. Validate intent identity, amount, currency, and business reference. Any Paybridge lookup uses that merchant's server-side credential.
- [ ] Keep unmatched or conflicting bindings pending with an actionable redacted diagnostic. Prove an event received before its local binding survives and processes once the matching binding is available. Never redirect it to another merchant's order or discard it to satisfy a local foreign key.
- [ ] Apply snapshots through the operation introduced for lookup. In one merchant database transaction, compare the persisted revision, apply a newer snapshot, perform the guarded local order-paid effect when appropriate, and mark the claimed inbox receipt processed. Transaction failure rolls back all these effects.
- [ ] A repeated receipt or another snapshot at an equal or older revision produces no second paid effect and cannot regress the payment view. Retain the receipt and mark a valid stale snapshot processed so it does not retry forever.
- [ ] Accept noncontiguous revisions because creation and processing have no webhook event types. A newer PROCESSING lookup can follow FAILED. Prove an older failed or unknown notification cannot overwrite a newer success.
- [ ] Deliver duplicated, delayed, and reordered valid signed notifications through the actual receiver. Verify one durable receipt per event and one local paid effect, using persisted merchant state rather than mock invocation counts.
- [ ] Race lookup against inbox processing, including repeated success observations, an older event completing late, and competing worker claims. Guarded revision application and the paid effect must commit once, with stale claim completion unable to alter current work ownership.
- [ ] Terminate and restart the inbox worker before application, during its transaction, and after commit. Reopen the same merchant database. Pending work must resume, a partial paid effect must not remain, and committed processing must not repeat the effect.
- [ ] A webhook authenticated for one fixture merchant cannot change the other's order, even when business references match or a payload identifies its intent. Preserve receiving context and the failed association for investigation.
- [ ] Demonstrate a payment completing during a merchant outage, followed by durable delivery and inbox recovery when the receiver and workers resume. Provider state and financial effect remain unchanged while only notification and local application work retry.
- [ ] Preserve historical receipts, revision evidence, and diagnostics for the lifetime of prototype data. The paid effect remains a guarded local database update. Do not add external fulfillment, customer notifications, strict revision-gap waiting, or a separate state-application implementation for webhooks.

