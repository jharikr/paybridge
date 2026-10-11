# 06: Recover interrupted provider work safely

**What to build:** Restarting Paybridge or mock 4Cs after an interrupted payment preserves the original financial attempt. Recovery either establishes a definite outcome or retains UNKNOWN for investigation, while late responses remain available as evidence without overwriting current state.

**Blocked by:** 05: Execute accepted attempts through the provider worker.

**Status:** ready-for-agent

**Group:** 3 of 6. Durable mock and provider execution.

**Source:** [Approved specification](../spec.md), [recovery contract](../reference-contract.md#7-recovery-and-reconciliation), and [failure behavior](../reference-contract.md#16-failure-behavior).

**User stories:** 20, 27, 28, 29, 30, 33, 36, 37, 44, 45, 55, 56, 61, 63.

**Testing decisions:** 9, 10, 11, 13.

- [ ] Terminate and restart real API, worker, and mock processes at controlled points around command acceptance, provider submission, provider acceptance, and result persistence. Reopen the same isolated durable database files. Do not replace these proofs with object reconstruction in one process.
- [ ] A crash after durable confirmation but before submission leaves recoverable provider work. A restarted worker claims it and submits the original account, attempt, transaction ID, invoice, amount, currency, and synthetic input. No new financial attempt is created by work recovery.
- [ ] After provider acceptance but before Paybridge records a result, expired work may be reclaimed using the same transaction identity. A duplicate response produces one UNKNOWN attempt and one reconciliation case. Independently inspect the mock ledger to prove there was no second simulated financial effect, including across mock restart.
- [ ] Prove abandoned claims are reclaimable, concurrent processes have one claim winner, and a stale claim token cannot complete another worker's execution. Attempt counters count work executions rather than new financial attempts. Clear claim ownership when completing or rescheduling work.
- [ ] Coordinate an old request that remains in flight while a claim expires and another worker takes ownership. Local claim fencing protects Paybridge writes; it cannot cancel an already sent request or establish that the provider will never accept it.
- [ ] Once UNKNOWN commits, complete provider submission work and stop automatic financial submissions. Reject new confirmations for the intent. A later response, another poll, elapsed time, or a lease expiry cannot automatically convert UNKNOWN into failure or success.
- [ ] Preserve each useful late provider response as bounded sanitized append-only observation history tied to the exact attempt, account, and transaction identity. Include classification, useful provider reference, and observation time even when financial completion fails its ownership or state guard.
- [ ] Observation-only history leaves state, revision, and financial webhook count unchanged. A stale observation cannot overwrite a current definite result. Ticket 07 also proves this guard after manual resolution and preserves contradictory evidence for investigation.
- [ ] Hold a request before provider acceptance, allow Paybridge to time out, and prove UNKNOWN continues to block a fresh attempt while the ledger is empty. Release the held request and retain its actual outcome as evidence. Ticket 07 proves that absent evidence cannot authorize failed reconciliation.
- [ ] Separately store a final provider outcome and lose or delay its response. Prove its immutable identity survives restart and later same-ID submissions honor that outcome. Keep this case distinct from the pre-acceptance delay in the tests and diagnostics.
- [ ] Inject failure around result persistence and establish that state, revision, history, reconciliation, and webhook work are either committed together or recoverable without partial finalization. Inspect externally visible state and retained records, not only calls to a claim helper.
- [ ] Preserve payment history and actionable redacted causes across every recovery case. Do not add cross-application database access to runtime components, automatic UNKNOWN reconciliation, destructive reset commands, or claims about live 4Cs deduplication guarantees.

