# 07: Resolve investigations from matching final evidence

**What to build:** A trusted local operator can investigate an UNKNOWN attempt and establish either success or definite non-payment from matching final evidence. An investigation stays open when the outcome remains uncertain, and every resolution preserves its reasoning and history.

**Blocked by:** 06: Recover interrupted provider work safely.

**Status:** ready-for-agent

**Group:** 4 of 6. Manual reconciliation and evidence history.

**Source:** [Approved specification](../spec.md) and [reconciliation contract](../reference-contract.md#7-recovery-and-reconciliation).

**User stories:** 20, 37, 38, 39, 40, 41, 42, 43, 44, 45, 56, 63.

**Testing decisions:** 11, 12, 13.

- [ ] Provide trusted local commands to list, start, and resolve investigations through the same payment application services used elsewhere. Preserve REQUIRED, IN_PROGRESS, and RESOLVED states, with one case per unknown attempt. Do not add an administration UI or public arbitrary-status endpoint.
- [ ] An operator can inspect or export the mock ledger as synthetic evidence. Runtime Paybridge workers do not read another application's database. Make the evidence's synthetic and operator-verified nature explicit without inventing a cryptographic attestation or live provider lookup service.
- [ ] Match provider account, transaction ID, invoice, amount, and currency to the exact attempt. Retain the evidence reference, bounded sanitized facts, operator identity, timestamps, reason, and proposed outcome. Notes or a requested outcome alone are insufficient evidence.
- [ ] A final stored mock approval supports SUCCEEDED. A final stored decline or the selected definitive incomplete result supports FAILED only because every delayed same-ID submission must honor that immutable outcome. Preserve the actual provider classification and history.
- [ ] Reject absent, mismatched, inconclusive, or non-final evidence without recording a final resolution, changing financial state, advancing revision, creating a financial webhook, or enabling another attempt. A timeout, lease expiry, one pre-acceptance rejection, or missing ledger row cannot establish final non-payment.
- [ ] Resolve in one guarded transaction that updates attempt and intent, increments revision, marks the case resolved, records operator evidence and append-only history, and creates the matching durable financial webhook. Failure rolls back all resolution effects. Resolved cases require outcome, evidence, and resolution time; unresolved cases cannot contain a final resolution.
- [ ] Repeating an identical completed resolution is a no-op. Reject an incompatible second resolution with a conflict. Race concurrent resolution commands and prove only one decision, revision change, and webhook commits.
- [ ] Demonstrate success and failure resolution through the trusted commands, with resulting state observable through the merchant API. A fresh attempt remains blocked until a resolution establishes FAILED. SUCCEEDED remains terminal.
- [ ] Hold a request before acceptance, time it out, and attempt failed reconciliation using an absent ledger record. Prove the case stays open and another attempt stays blocked. Release the old request, inspect its actual stored outcome, and reconcile only when matching final evidence exists.
- [ ] Store a final decline, lose the response, reconcile failure, and deliberately start a fresh attempt. Release or replay an old same-ID submission and prove it still honors the earlier decline rather than producing another charge. Keep the old and new attempt identities and histories distinct.
- [ ] Deliver a late observation after UNKNOWN and after manual resolution. Retain sanitized evidence without automatically resolving UNKNOWN or rewriting a resolved financial decision. Contradictory resolved evidence produces an actionable diagnostic while state, revision, and financial webhook count remain unchanged.
- [ ] Retain cases, evidence, identities, and historical payment facts across restart for the lifetime of prototype data. Document that some cases may remain UNKNOWN indefinitely. Do not add a mock closure operation or force a final status merely to finish a demonstration.

