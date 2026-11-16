# 06: Recover interrupted provider work safely

**What to build:** Restarting Paybridge or mock 4Cs after an interrupted payment preserves the original financial attempt. Recovery either establishes a definite outcome or retains UNKNOWN for investigation, while late responses remain available as evidence without overwriting current state.

**Blocked by:** 05: Execute accepted attempts through the provider worker.

**Status:** completed

**Group:** 3 of 6. Durable mock and provider execution.

**Source:** [Approved specification](../spec.md), [recovery contract](../reference-contract.md#7-recovery-and-reconciliation), and [failure behavior](../reference-contract.md#16-failure-behavior).

**User stories:** 20, 27, 28, 29, 30, 33, 36, 37, 44, 45, 55, 56, 61, 63.

**Testing decisions:** 9, 10, 11, 13.

- [x] Terminate and restart real API, worker, and mock processes at controlled points around command acceptance, provider submission, provider acceptance, and result persistence. Reopen the same isolated durable database files. Do not replace these proofs with object reconstruction in one process.
- [x] A crash after durable confirmation but before submission leaves recoverable provider work. A restarted worker claims it and submits the original account, attempt, transaction ID, invoice, amount, currency, and synthetic input. No new financial attempt is created by work recovery.
- [x] After provider acceptance but before Paybridge records a result, expired work may be reclaimed using the same transaction identity. A duplicate response produces one UNKNOWN attempt and one reconciliation case. Independently inspect the mock ledger to prove there was no second simulated financial effect, including across mock restart.
- [x] Prove abandoned claims are reclaimable, concurrent processes have one claim winner, and a stale claim token cannot complete another worker's execution. Attempt counters count work executions rather than new financial attempts. Clear claim ownership when completing or rescheduling work.
- [x] Coordinate an old request that remains in flight while a claim expires and another worker takes ownership. Local claim fencing protects Paybridge writes; it cannot cancel an already sent request or establish that the provider will never accept it.
- [x] Once UNKNOWN commits, complete provider submission work and stop automatic financial submissions. Reject new confirmations for the intent. A later response, another poll, elapsed time, or a lease expiry cannot automatically convert UNKNOWN into failure or success.
- [x] Preserve each useful late provider response as bounded sanitized append-only observation history tied to the exact attempt, account, and transaction identity. Include classification, useful provider reference, and observation time even when financial completion fails its ownership or state guard.
- [x] Observation-only history leaves state, revision, and financial webhook count unchanged. A stale observation cannot overwrite a current definite result. Ticket 07 also proves this guard after manual resolution and preserves contradictory evidence for investigation.
- [x] Hold a request before provider acceptance, allow Paybridge to time out, and prove UNKNOWN continues to block a fresh attempt while the ledger is empty. Release the held request and retain its actual outcome as evidence. Ticket 07 proves that absent evidence cannot authorize failed reconciliation.
- [x] Separately store a final provider outcome and lose or delay its response. Prove its immutable identity survives restart and later same-ID submissions honor that outcome. Keep this case distinct from the pre-acceptance delay in the tests and diagnostics.
- [x] Inject failure around result persistence and establish that state, revision, history, reconciliation, and webhook work are either committed together or recoverable without partial finalization. Inspect externally visible state and retained records, not only calls to a claim helper.
- [x] Preserve payment history and actionable redacted causes across every recovery case. Do not add cross-application database access to runtime components, automatic UNKNOWN reconciliation, destructive reset commands, or claims about live 4Cs deduplication guarantees.

## Comments

### Implementation and verification

- Confirmed ancestry from integration `7417ab87413518c5498d44c8dc554c7728cab2ac` before editing the isolated ticket 06 worktree. Existing schemas, migrations, retained records, and protocol contracts are unchanged.
- Reused the approved HTTP, process, controlled-clock, and independent database-inspection seams. Added one optional post-claim checkpoint to the real worker, after claim commit and before the remaining-lease check. The first crash test failed waiting for that checkpoint before the hook existed, then passed with the hook. Production supplies no checkpoint.
- `tests/recovery/process.test.ts` kills real API, worker, and mock processes before submission, after acceptance, during definite and unknown result transactions, and after committed results. Recovery retains the original identity and cached acknowledgment, with one financial attempt, cleared completed claims, and exact persisted history. Same-ID submission after a lost decline and mock restart preserves the final decline.
- `tests/recovery/overlap.test.ts` proves competing-process claims, stale-token rejection while the replacement owns a live lease on a PROCESSING payment, actual approval observation after UNKNOWN, and protection of a current definite result. Later clock advancement and a successfully processed second payment prove the worker continues polling without resubmitting completed UNKNOWN work.
- `tests/recovery/delayed-acceptance.test.ts` proves UNKNOWN and blocked confirmation while no provider record exists, then releases the actual delayed request and exports its stored approval through the mock inspector. The aborted worker receives no invented observation.
- Full regression verification passed: 110 tests across 19 files, including the 11 new recovery tests, plus typechecking and `git diff --check`. TypeScript guidance, TDD, unslop, and deslop applied. The cleanup pass removed unused fixture configuration and kept the runtime change to the three-line optional checkpoint. Independent review completed with no findings.

### Independent review and completion

- The independent review-agent reported no findings and independently passed all 110 tests across 19 files, typechecking, and `git diff --check`. No implementation corrections were required.
- All ticket 06 criteria are complete. Manual reconciliation and its resolved-case observation checks remain ticket 07. No live-provider guarantees, schema changes, destructive resets, or runtime cross-application database reads were introduced.
