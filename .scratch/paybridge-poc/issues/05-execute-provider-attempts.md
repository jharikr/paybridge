# 05: Execute accepted attempts through the provider worker

**What to build:** An accepted payment attempt progresses through the owning merchant's mock provider account to a definite result or UNKNOWN. The merchant can retrieve that persisted result, deliberately retry a definite failure, and distinguish an acceptance acknowledgment from financial completion.

**Blocked by:** 03: Accept confirmations and enforce merchant cancellation; 04: Persist deterministic mock 4Cs outcomes.

**Status:** ready-for-agent

**Group:** 3 of 6. Durable mock and provider execution.

**Source:** [Approved specification](../spec.md), [provider rules](../reference-contract.md#6-4cs-provider-rules-and-mock-fidelity), and [transaction boundaries](../reference-contract.md#15-required-transaction-boundaries-and-workers).

**User stories:** 1, 17, 18, 19, 20, 26, 27, 28, 30, 31, 32, 33, 34, 35, 37, 45, 55, 56, 57, 59.

**Testing decisions:** 5, 6, 8, 10, 16, 17.

- [ ] A local provider loop claims committed due work in a short transaction with a fresh claim token, worker identity, and expiring lease. Commit the claim before external HTTP, bound the provider timeout below the lease, and guard completion by ownership and current financial state. Do not add a broker or worker framework.
- [ ] Build the selected SOAP AuthAndPost request using the attempt's immutable provider account, transaction ID, synthetic reference, and the intent's stable invoice and financial inputs. Provider credentials are resolved server-side. Re-execution of an existing work item never chooses a fresh transaction ID or changes its account.
- [ ] Convert positive integer minor units with explicit supported currency metadata and integer-based formatting. Prove exact wire amounts and the agreed identifier limits. Resolve synthetic card fields only inside the adapter from controlled fixture references; public requests never accept real card data.
- [ ] Safely serialize SOAP fields, bound requests and responses, and disable external entities and DTD processing. Demonstrate ordinary requests and injection-like inputs. Return and log only bounded sanitized diagnostics, never raw provider payloads or credentials.
- [ ] Interpret outer operation, service result, and financial result in order. Validate required response structure and echoed identity/financial fields. HTTP 200 or an arbitrary financial approval attached to an invalid service result cannot establish success.
- [ ] A definite approval produces SUCCEEDED at the authorization-and-posting threshold. A decline and the selected definitive incomplete fixture produce FAILED with distinct preserved codes. These results do not claim completed settlement.
- [ ] Timeout, lost or malformed response, mismatched echoes, invalid response layers, and DuplicateTransaction produce UNKNOWN when a definite outcome cannot be established. Complete financial submission work and create exactly one REQUIRED reconciliation case. Do not treat duplicate identity as approval or use the provider repeat operation for recovery.
- [ ] Each result transaction updates attempt and intent, increments revision for the status change, appends history, completes provider work, and creates the exact durable financial event and webhook payload together. A failure rolls back the entire result. Observation-only records do not advance revision or create financial webhooks.
- [ ] Prove request routing for both merchants with the mock ledger as independent evidence. Attempt identity, account, invoice, amount, and currency must match the owning merchant's request. Credential or identifier substitution cannot move a payment to another account.
- [ ] Exercise the direct-confirm journey through real HTTP, provider work, and lookup for approval, decline, incomplete, and UNKNOWN. Lookup returns persisted state without initiating another provider request. Cancellation is rejected after processing or any provider outcome, and success remains terminal.
- [ ] Send two different confirmation keys based on one revision, commit a decline before the delayed command arrives, and prove the delayed command conflicts without another attempt. Replay the accepted command after decline and receive its original 202. Then use a deliberate new key and current failed revision to create the next attempt with a new transaction ID.
- [ ] Replay creation after financial state changes and receive its original 201 and checkout capability. Demonstrate that current lookup and financial events, rather than cached acceptance responses, carry the latest revision. Preserve immutable inputs and the full attempt history.
- [ ] Verify the database constraints and rollback of result, event, reconciliation, and outbox writes through focused integration cases. Keep the implemented HTTP errors and state descriptions in OpenAPI accurate. Ticket 06 adds the real crash, overlapping worker, and delayed-response recovery proofs.

