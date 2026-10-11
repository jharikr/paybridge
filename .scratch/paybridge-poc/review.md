# Paybridge proof of concept design review

Status: completed interview record. The owner approved the [consolidated reference contract](reference-contract.md) and requested publication of the [ready-for-agent specification](spec.md). Q1 through Q10 are settled, including the approved testing boundaries and technical corrections.

## Sources

- Owner clarifications on 2026-10-11, following the first grilling round.
- [Paybridge TypeScript reference implementation specification, Draft 2](/Users/jharik/.t3/userdata/attachments/83914c9c-750a-4f17-a8ce-f5d2f35da951-3fb0e6fb-73a0-45f6-b422-19454875ae19-md.md).
- [FMX SSIS SSL Secure Transaction Service Revision 2.2](/Users/jharik/.t3/userdata/attachments/83914c9c-750a-4f17-a8ce-f5d2f35da951-d22442bc-60c7-4404-bc20-7fa9699e9bdc-pdf.pdf), supplied provider reference. Live applicability is not established.

## Settled

- This is a local, synthetic proof of concept demonstrating the journey and failure handling, not a customer release.
- The proposed stack is fixed. The original plan remains the review baseline rather than a prompt to redesign the technology.
- The product direction is hosted checkout for independent merchants using their own NCBA/4Cs merchant keys.
- The current baseline excludes UI, real card collection, live provider connectivity, and self-service onboarding. Future product descriptions do not add those to this milestone.
- ASP.NET portability is removed as a design criterion. A later Go implementation is possible, not a current deliverable.
- [Glossary](../../GLOSSARY.md) defines the merchant separately from its integrating application.
- [ADR 0001](../../docs/adr/0001-build-a-simulated-typescript-proof-of-concept.md) and [ADR 0002](../../docs/adr/0002-use-each-merchants-own-provider-credentials.md) record these boundaries.
- Q5 accepted: the merchant owns order-to-intent identity and reuses its stored binding and command keys. Paybridge protects each intent rather than enforcing uniqueness across intents using merchant_reference. See [ADR 0003](../../docs/adr/0003-keep-order-identity-with-the-merchant.md).
- Q6 accepted: leaving checkout is navigation only. Terminal cancellation requires an explicit merchant action before processing starts. See [ADR 0004](../../docs/adr/0004-separate-checkout-navigation-from-cancellation.md).
- Q7 accepted: reject a new confirmation based on an outdated payment revision. Identical completed commands still replay their original acknowledgement before current-state checks. See [ADR 0005](../../docs/adr/0005-require-the-current-revision-for-new-confirmations.md).

## Final round outcome

Q8 accepted: the prototype retains an explicitly cancelled intent and its sample order binding. Replacement payment intents for the same cancelled sample order are deferred.

Q9 reaffirmed an existing requirement, not a new choice. The owner correctly identified that Draft 2 section 7 already requires UNKNOWN, manual investigation, and a recorded resolution. The review clarification is that an absent provider record alone does not establish non-payment while an old submission might still execute. Inconclusive evidence leaves the case open and blocks another attempt.

The owner described reconciliation as checking the outcome, which may be success or definite non-payment. Manual reconciliation is not a step whose purpose is merely to confirm success.

## Accepted confirmation amendment

- Both merchant and checkout confirmation bodies include expectedRevision as a required positive safe integer, alongside the synthetic payment-method reference. The existing lookup and checkout snapshots supply the revision.
- Authenticate and validate the request, then match its command key and normalized request. Include expectedRevision in the request identity. An identical completed command returns its cached acknowledgement before checking current payment state.
- For a new command, compare expectedRevision with the stored payment revision in the same transaction that checks confirmable state and the absence of an unresolved attempt, creates the attempt, advances state, and creates durable work.
- Missing or invalid expectedRevision is 400. A new command with an outdated revision is 409 payment_revision_conflict and creates no attempt or provider work.
- The sample caller refreshes its view after a revision conflict and requires a deliberate new confirmation based on the new revision and a new command key. It must not automatically turn a stale command into a retry.
- This check validates the application state on which a command was based. It cannot prove a human read a message.
- Verification must include two different keys based on the same revision, a decline committed before the delayed request arrives, replay of the original accepted key after the decline, and a deliberate new command based on the failed revision.

## Proposed technical corrections

These are review findings, not accepted implementation changes.

- Exercise two seeded merchants with separate synthetic provider credentials, API credentials, callbacks, and account-scoped evidence. Verify credential routing as well as cross-merchant access rejection. Draft section 13 lacks an explicit merchant-to-provider-account mapping despite using provider account identity in the mock.
- Treat the mock's durable account-scoped transaction deduplication as an explicit assumption. The supplied provider guide requires unique transaction identifiers and reports duplicates, but does not establish namespace, retention, concurrency, or durability semantics. See PDF pages 2, 5, and 7, and draft sections 6 and 7.
- A missing mock transaction cannot establish definitive non-payment if a submitted request could still arrive. Resolve to FAILED only from a final immutable outcome for the exact provider account, transaction ID, invoice, amount, and currency, such as a stored synthetic decline. Every later submission with that transaction identity must honor the same stored outcome. A pre-acceptance rejection of one submission is insufficient if another could still arrive. Otherwise retain UNKNOWN; a timeout or expired local claim does not cancel remote processing.
- Preserve sanitized late provider observations even when a stale worker cannot change current payment state. Conflicting evidence must remain available for investigation.
- Document cached create responses as containing a checkout credential. Hashing the separate token column does not remove the usable token from an exact cached response containing checkoutUrl. Specify its protection and keep it out of logs and diagnostics.
- Define SUCCEEDED as the selected authorization-and-posting threshold, not settlement finality. The supplied guide describes AuthAndPost as eligible for a later settlement cycle, PDF page 6; the draft already disclaims settlement finality.
- Keep synthetic payment-method references distinct from live provider tokenization. The supplied guide does not define tokenization or a transaction-status lookup API. Live card-data recovery remains unproven.
- Correct the opening reference to nonexistent section 22 and remove ASP.NET references when revising the source plan.

## Primary-source comparisons

- [Stripe PaymentIntent guidance](https://docs.stripe.com/payments/payment-intents) recommends reusing an intent after interrupted checkout and storing its identity on the merchant's cart or session, with a stable creation idempotency key. That supports the existing merchant-side binding but does not establish business-reference uniqueness in Paybridge.
- [Stripe's intent lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle) separates retryable failed attempts from permanent intent cancellation. [Checkout session creation](https://docs.stripe.com/api/checkout/sessions/create) defines cancel_url as a back-button destination; it is not a guarantee that the underlying payment has been cancelled.
- [PCI SSC's outsourcing guidance](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/) says outsourcing payment processing does not eliminate merchant PCI responsibilities. Hosted checkout may reduce merchants' card-data handling; it must not be described as removing every compliance responsibility. This is a boundary for future product claims, not a certification requirement added to the synthetic prototype.

These are design comparisons, not proof that 4Cs implements Stripe's mechanisms or guarantees.

## Disposition of remaining findings

- Replacement intents after explicit cancellation are deferred by Q8.
- UNKNOWN and manual reconciliation remain the original requirements, reaffirmed in Q9. The revised spec clarifies evidence finality and leaves inconclusive cases open.
- Delayed requests, stale workers, late observations, and the associated restart demonstrations are covered in Draft 3 sections 6, 7, 15, and 19.
- Checkout response caching explicitly retains a usable token in sensitive local records. No production secret infrastructure or new token-expiry subsystem is added to this synthetic prototype.
- Merchant notification and revision behavior remain as specified. A final consistency check found that two fixture merchants required receiving merchant context in sample orders, commands, inbox receipts, webhook verification, and return lookup. Draft 3 propagates that ownership and its checks without adding an application or database.
- Official Prisma 8 documentation confirms an experimental SQLite extension and transaction support. API and migration behavior differ from Prisma 7; local rollback, constraints, parameter binding, atomic claims, restart durability, and the validation/OpenAPI integration still need the first implementation stage. No package was installed to verify them during this review.
- Draft 3 section 23 sequences the implementation into verifiable stages. No implementation tickets, application code, runtime setup, migrations, or deployments have been created.

## Review status

Both attached documents were examined, including a full provider-contract review and a full proposal consistency review. No application code, packages, runtime, database, or migrations have been created. The owner confirmed shared understanding of the consolidated plan and invoked to-spec to publish it locally. Documentation checks validated its section numbering, JSON examples, local links, and propagation of the accepted changes. These checks do not establish runtime behavior. Application implementation is not authorized by an answer to an earlier individual design question.

## Comments

- The owner stated "Plan agreed upon" and invoked to-spec. The published specification is labelled ready-for-agent; the approved detailed contract is retained alongside it. The current action is document publication, not application implementation.
