# 04: Persist deterministic mock 4Cs outcomes

**What to build:** A synthetic SOAP caller can submit a transaction to mock 4Cs and observe a reproducible result. Accepted transaction identity and final outcome survive duplicate requests, overlapping execution, deliberately lost responses, and provider restart.

**Blocked by:** 01: Prove the selected stack.

**Status:** ready-for-agent

**Group:** 3 of 6. Durable mock and provider execution.

**Source:** [Approved specification](../spec.md) and [provider rules](../reference-contract.md#6-4cs-provider-rules-and-mock-fidelity).

**User stories:** 29, 30, 32, 36, 43, 56, 63, 64.

**Testing decisions:** 8, 9, 10, 11, 16.

- [ ] Implement the selected SOAP 1.1 SSISProcessTransaction and AuthAndPost subset over local HTTP, with two synthetic provider-account fixtures. The mock owns its separate durable SQLite database and does not read Paybridge or merchant databases.
- [ ] Validate synthetic merchant credentials and the agreed transaction, invoice, amount, currency, and request fields. Expose the outer operation result, service ResultCode, and financial result as distinct protocol layers. Preserve the separate approval, decline, and selected definitive incomplete outcomes.
- [ ] Uniquely identify an accepted transaction by provider account and transaction ID. Atomically retain its request identity, matching evidence fields, and immutable final synthetic outcome before emitting, delaying, or losing the response. Different accounts remain isolated even when an external caller uses the same transaction ID.
- [ ] Every concurrent, delayed, restarted, and duplicate submission path honors an already stored outcome. Reusing an accepted identity returns the provider-style DuplicateTransaction result, not a replay invented to look like the original financial response. No duplicate creates a second simulated financial effect or replaces a stored decline with approval.
- [ ] Supply deterministic scenarios for approval, decline, definitive incomplete, malformed response, mismatched echoes, invalid service results, duplicate handling, lost response, delayed response, and pre-acceptance delay or failure. Coordinate failure windows explicitly so tests do not depend on arbitrary sleep timing.
- [ ] Demonstrate the difference between holding a request before acceptance and withholding a response after committing the final outcome. A held unaccepted request may later execute. An absent ledger entry or one rejected submission cannot certify that every outstanding same-ID submission is unable to execute.
- [ ] Prove stored outcomes and duplicate behavior survive actual mock process termination and restart. Race same-ID submissions and independently inspect the persisted ledger to establish the number and identity of simulated effects.
- [ ] Make matching synthetic ledger facts available to the test harness and trusted local operator for investigation. Include provider account, transaction ID, invoice, amount, currency, final outcome, and useful non-sensitive references. Do not add a live provider status API, automatic Paybridge reconciliation API, or transaction-closure operation.
- [ ] Bound SOAP bodies, safely serialize fields, and disable DTD and external-entity processing. Exercise valid XML and injection-like input. Use only controlled synthetic payment data and sanitized diagnostics, with no sensitive request-body logging.
- [ ] Document durable deduplication and finality as simulation assumptions. Do not claim live-provider retention, failover behavior, settlement finality, tokenization, or exactly-once distributed execution. The provider's repeat operation is not used as lookup or recovery.

