# 12: Run and document the complete proof of concept

**What to build:** The owner can reproduce the complete synthetic payment journey and its failure recovery from documented commands, with evidence showing what the prototype establishes and which live-provider questions remain unanswered.

**Blocked by:** 07: Resolve investigations from matching final evidence; 11: Apply notifications without repeating merchant effects.

**Status:** ready-for-agent

**Group:** 6 of 6. Complete demonstration and verification.

**Source:** [Approved specification](../spec.md), [minimum verification suite](../reference-contract.md#19-minimum-verification-suite), and [completion requirements](../reference-contract.md#21-implementation-readiness-and-completion).

**User stories:** 59, 61, 63, 64.

**Testing decisions:** 1, 2, 3, 9, 17.

- [ ] Provide reproducible installation, fixture setup, process launch, demonstration, and verification commands using the selected stack and Bun tooling. Record the supported runtime and required local configuration. Use the existing three applications and their separate databases, with Paybridge API/workers, merchant API/inbox worker, and mock API entrypoints.
- [ ] Run the same implementation through the applications' real public HTTP interfaces and trusted local reconciliation commands. Use controlled synthetic input, isolated durable database files, and actual process termination/restart. Runtime applications must not bypass HTTP by reading each other's databases.
- [ ] Demonstrate both merchant direct confirmation and headless checkout/303/return. Include both fixture merchants, capability and ownership isolation, stable order bindings, exact command replay, current lookup, signed receipt, and a single local paid effect.
- [ ] Reproduce approval, decline, definitive incomplete, deliberate retry, delayed stale confirmation, pending-only cancellation, harmless repeat cancellation, every-state checkout leave, and retention of a cancelled sample order binding. Prove acknowledgments and navigation do not establish financial completion.
- [ ] Run the combined provider failure matrix: malformed or mismatched responses, lost responses, duplicate identities, crashes before and after acceptance, mock restart, overlapping claims, and stale completions. Inspect the mock ledger as independent evidence of simulated financial effects.
- [ ] Separately demonstrate delayed acceptance with initially absent evidence and delayed response after an immutable stored outcome. Show UNKNOWN blocking fresh attempts, manual success and failed reconciliation from matching final evidence, rejected absent evidence, repeated/conflicting resolutions, and retained late observations without state overwrite.
- [ ] Run webhook and inbox outage, duplicate, reordered, revision-gap, lost-acknowledgment, lookup-race, and restart cases. Establish durable receipt before acknowledgment and one local paid effect even when processing resumes after a crash.
- [ ] Execute the existing focused checks from the preceding tickets and the assembled journey against the same implementation. Report failures with their concrete scenario and retained evidence. Do not defer missing rollback, ownership, or recovery behavior to documentation or replace real process proofs with in-memory doubles.
- [ ] Compare generated OpenAPI with actual requests, responses, headers, status codes, and error shapes for every implemented route. Confirm strict runtime validation and document restrictions that JSON Schema cannot express. Keep examples executable with synthetic values and accurate about cached acknowledgment versus current state.
- [ ] Review demonstration output and diagnostics for credentials, capabilities, raw provider payloads, and real card fields. Keep descriptions inert, redirects constrained, sensitive responses uncached, and servers pointed only at local mock configuration.
- [ ] Trace the approved six concern groups and all specification user stories and testing decisions to their ticket acceptance criteria and resulting verification evidence. Record checks that remain unverified explicitly; a successful approval example or typecheck alone cannot close this ticket.
- [ ] Document the simulation assumptions and exclusions, especially live NCBA/4Cs identity retention, concurrency and failover guarantees, real card-data recovery, live tokenization, settlement finality, and production compliance. No customer deployment, real card collection, onboarding portal, additional provider, or promise of exactly-once distributed delivery is part of completion.
- [ ] Preserve prototype payment records, keys, evidence, and history for their data lifetime. Document fresh isolated demonstration data setup without destructive reset of existing records. Explain that an inconclusive case may remain UNKNOWN and requires investigation rather than a forced terminal status.

