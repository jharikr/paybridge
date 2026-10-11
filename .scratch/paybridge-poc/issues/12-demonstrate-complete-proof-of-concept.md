# 12: Run and document the complete proof of concept

**What to build:** The owner can reproduce the complete synthetic payment journey and its failure recovery from documented commands, with evidence showing what the prototype establishes and which live-provider questions remain unanswered.

**Blocked by:** 07: Resolve investigations from matching final evidence; 11: Apply notifications without repeating merchant effects.

**Status:** completed

**Group:** 6 of 6. Complete demonstration and verification.

**Source:** [Approved specification](../spec.md), [minimum verification suite](../reference-contract.md#19-minimum-verification-suite), and [completion requirements](../reference-contract.md#21-implementation-readiness-and-completion).

**User stories:** 59, 61, 63, 64.

**Testing decisions:** 1, 2, 3, 9, 17.

- [x] Provide reproducible installation, fixture setup, process launch, demonstration, and verification commands using the selected stack and Bun tooling. Record the supported runtime and required local configuration. Use the existing three applications and their separate databases, with Paybridge API/workers, merchant API/inbox worker, and mock API entrypoints.
- [x] Run the same implementation through the applications' real public HTTP interfaces and trusted local reconciliation commands. Use controlled synthetic input, isolated durable database files, and actual process termination/restart. Runtime applications must not bypass HTTP by reading each other's databases.
- [x] Demonstrate both merchant direct confirmation and headless checkout/303/return. Include both fixture merchants, capability and ownership isolation, stable order bindings, exact command replay, current lookup, signed receipt, and a single local paid effect.
- [x] Reproduce approval, decline, definitive incomplete, deliberate retry, delayed stale confirmation, pending-only cancellation, harmless repeat cancellation, every-state checkout leave, and retention of a cancelled sample order binding. Prove acknowledgments and navigation do not establish financial completion.
- [x] Run the combined provider failure matrix: malformed or mismatched responses, lost responses, duplicate identities, crashes before and after acceptance, mock restart, overlapping claims, and stale completions. Inspect the mock ledger as independent evidence of simulated financial effects.
- [x] Separately demonstrate delayed acceptance with initially absent evidence and delayed response after an immutable stored outcome. Show UNKNOWN blocking fresh attempts, manual success and failed reconciliation from matching final evidence, rejected absent evidence, repeated/conflicting resolutions, and retained late observations without state overwrite.
- [x] Run webhook and inbox outage, duplicate, reordered, revision-gap, lost-acknowledgment, lookup-race, and restart cases. Establish durable receipt before acknowledgment and one local paid effect even when processing resumes after a crash.
- [x] Execute the existing focused checks from the preceding tickets and the assembled journey against the same implementation. Report failures with their concrete scenario and retained evidence. Do not defer missing rollback, ownership, or recovery behavior to documentation or replace real process proofs with in-memory doubles.
- [x] Compare generated OpenAPI with actual requests, responses, headers, status codes, and error shapes for every implemented route. Confirm strict runtime validation and document restrictions that JSON Schema cannot express. Keep examples executable with synthetic values and accurate about cached acknowledgment versus current state.
- [x] Review demonstration output and diagnostics for credentials, capabilities, raw provider payloads, and real card fields. Keep descriptions inert, redirects constrained, sensitive responses uncached, and servers pointed only at local mock configuration.
- [x] Trace the approved six concern groups and all specification user stories and testing decisions to their ticket acceptance criteria and resulting verification evidence. Record checks that remain unverified explicitly; a successful approval example or typecheck alone cannot close this ticket.
- [x] Document the simulation assumptions and exclusions, especially live NCBA/4Cs identity retention, concurrency and failover guarantees, real card-data recovery, live tokenization, settlement finality, and production compliance. No customer deployment, real card collection, onboarding portal, additional provider, or promise of exactly-once distributed delivery is part of completion.
- [x] Preserve prototype payment records, keys, evidence, and history for their data lifetime. Document fresh isolated demonstration data setup without destructive reset of existing records. Explain that an inconclusive case may remain UNKNOWN and requires investigation rather than a forced terminal status.

## Comments

- Implementation started from integration `cce6692387434f0413239dd4fcbbf4d47401f78b`. Bun frozen installation passed. The approved test seams are real public HTTP, trusted reconciliation/inspection commands, owned process termination/restart, and independent inspection of synthetic records. The demonstration retains each fresh private directory on success or failure. HTTP contract corrections and their tests are proceeding on a separate branch and will merge before final verification.

- TDD evidence: the initial retained journey failed before the CLI existed; the outage slice failed before a durable manifest existed; the seven-order reconciliation slice failed its literal receipt/outcome counts before implementation. Occupied-port and SIGTERM tests failed before configurable reservation and interruption handling. The resulting five tests pass through real public HTTP, trusted CLIs, private files and owned processes. Read-only demo inspection uses a bounded five-second SQLite busy timeout.
- Reviewed HTTP-contract subtask `0ebe240dd195ec9c2042a5db19fdea14b9076934` was merged as `199cc22909429c863cb7b17e7175c881e7e3bd3f`. Its independent review had no findings. The route inventory and observed schema/header/error comparisons are in `docs/http-contracts.md`.
- Combined verification on 2026-10-11 passed 235 tests in 65 files, typecheck and diff-check. Full log: `/tmp/paybridge-poc-ticket12-combined-suite.log`. `/deslop`, TypeScript guidance and unslop were applied to the complete candidate, including standalone helpers and documentation.
- Separate retained run: `bun run demo --data-parent /Users/jharik/Developer/transac/paybridge/.data`, exit 0, directory `/Users/jharik/Developer/transac/paybridge/.data/demo-5a89f31b-052c-4c0f-93e7-b86d56b81ce8`. It retains seven orders, eight attempts, seven ledger identities/four effects, eleven delivered/processed events and one expected unresolved UNKNOWN case. Read-only integrity, permission, JSON redaction and eight matched process-stop checks passed. The implementation fingerprint and earlier retained success/failure runs are recorded in `docs/verification-trace.md`.
- Candidate is ready for fresh independent whole-ticket review. Ticket status/checklist and whole-spec completion remain open until that review and the root's final standards/spec review finish.

- Independent whole-ticket review inspected the complete integration-to-candidate diff and reported one P3 documentation finding: the source fingerprint includes documentation under application directories. The two descriptions now name the exact included directories and exclude only root README/AGENTS and `docs/`. No algorithm or source bytes changed. The reviewer independently passed 53 tests in 15 files, typecheck/diff-check, exact fingerprint, three database integrity checks, financial totals, private permissions, redaction and stopped-process checks.
- Independent correction recheck resolved that finding with no remaining findings and verified diff-check plus the unchanged source fingerprint `1b45f5b0999aa08814ba1ebe0a3fa8341d9ef18b3a17d32d276119b0e64cf7d4`. Ticket 12 is complete. Overall specification closure remains pending the root's final standards/spec review; the PR remains draft.
