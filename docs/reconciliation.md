# Trusted local reconciliation

An UNKNOWN attempt needs investigation. A timeout, an empty mock ledger, or an expired lease does not establish non-payment. Some cases may stay UNKNOWN indefinitely. These commands operate on the local Paybridge SQLite file and never submit a financial request or open the mock database.

Run commands as the trusted local operator:

```sh
node apps/paybridge/reconcile.ts .data/paybridge.db /tmp/paybridge-command.json
```

The second argument is a UTF-8 JSON command file, bounded to 16,384 bytes. The command prints one JSON result and exits zero on success. An error prints `{"kind":"error","code":"..."}` and exits one. Error codes distinguish invalid commands, missing cases, conflicting decisions, mismatched evidence, temporary storage contention, and other command failures. Errors do not echo evidence, credentials, file contents, or stack traces. A storage error can be retried with the identical command.

This is a trusted process interface, not an administration HTTP route. Keep the database and command files under operator control. The operator identity is an audit attribution, not a new authentication system.

## List and start

Use this command file to list REQUIRED and IN_PROGRESS cases in creation order:

```json
{"kind":"list"}
```

The result contains `kind: "listed"` and `cases`. Each case includes its intent and attempt IDs, provider account, transaction ID, invoice, amount in minor units, currency, original uncertainty reason, and investigation state. It excludes payment credentials and checkout capabilities.

Copy the exact case ID from the list into a start command:

```json
{
  "kind": "start",
  "reconciliationId": "rec_<32 lowercase hex characters from the list>",
  "operator": "local-operator"
}
```

Starting records IN_PROGRESS, the first operator, time, and `RECONCILIATION_STARTED` history. It changes no payment revision and creates no financial webhook. Repeated starts preserve that first attribution without adding another event, including when another local operator submits the repeat. A resolved case cannot be started again. Resolution can proceed from either REQUIRED or IN_PROGRESS once the operator has verified final evidence.

## Export and verify evidence

Inspect the separate mock ledger using the account and transaction ID from the case:

```sh
node apps/mock-fourcs/inspect.ts .data/mock-fourcs.db mock-account-a TRANSACTION_ID > /tmp/paybridge-evidence.json
```

This read-only operator command returns either `kind: "recorded"` with final facts or `kind: "absent"`. Inspect those facts and check the account, transaction ID, invoice, integer amount, and currency against the exact attempt. A stored Approved outcome supports SUCCEEDED. A stored Declined or selected Incomplete outcome supports FAILED only under the mock's immutable same-account/same-ID outcome guarantee. Later duplicate requests must honor that stored outcome, even after restart.

The export is synthetic, operator-verified evidence. It is not signed, independently authenticated, or a live 4Cs lookup. Its fingerprint is a retained mock fact, not an attestation. Do not edit an absent record or invent a final outcome. Paybridge validates the imported structure, identity, amount, classification, and effect-count consistency; the trusted operator remains responsible for the source's authenticity.

## Resolve

Build a command file using the complete recorded export:

```js
import { readFileSync, writeFileSync } from "node:fs";

const evidence = JSON.parse(readFileSync("/tmp/paybridge-evidence.json", "utf8"));
writeFileSync("/tmp/paybridge-command.json", JSON.stringify({
  kind: "resolve",
  reconciliationId: "rec_<32 lowercase hex characters from the list>",
  operator: "local-operator",
  resolution: "SUCCEEDED",
  reason: "Verified the stored synthetic approval against this attempt",
  evidenceReference: "local-ledger-export-2026-10-11",
  evidence
}));
```

Run that JavaScript as a local `.mjs` file, replacing the case ID and selecting the outcome supported by the export. Then run the reconciliation command above. Use `FAILED` for a verified stored Declined or Incomplete result. Optional `notes` retain additional investigation context. Notes, a proposed result, an absent entry, or a pre-acceptance rejection alone cannot resolve a case.

Operator identities are limited to 128 UTF-16 units, reasons and evidence references to 512, and optional notes to 1,024. Required text cannot be blank. NUL and unpaired surrogates are rejected; accepted text is retained unchanged. Evidence accepts only the inspector's bounded final fields, with strict UTC timestamps, known mock accounts, XCD amounts within the mock limit, and consistent outcome/effect/approval facts. Extra fields, raw responses, and non-final classifications are rejected.

Resolution holds one SQLite write transaction. It checks that the case is unresolved and its exact attempt and parent are UNKNOWN, then updates their outcome, increments the intent revision once, resolves the case, records evidence and operator history, and creates one financial webhook with that revision. The earlier unknown event and reason remain in history. The new final provider classification and host reference are retained without inventing operation or service results absent from ledger evidence. Provider submission work remains completed.

The result is `kind: "resolved"` with the saved case and evidence facts. Identical replay returns that decision unchanged before checking the parent's current state. Equality includes case, resolution, operator, reason, optional notes, evidence reference, and every evidence fact. JSON property order does not matter; text and fact changes do. An incompatible decision conflicts, including another operator's different decision with the same proposed outcome. Concurrent commands serialize to one resolution, one revision increment, and one financial webhook.

After FAILED resolution, the merchant must refresh lookup and deliberately confirm with a new key and the current revision. That creates a distinct attempt and transaction ID. Replaying the old resolution remains a no-op even after the new attempt succeeds. SUCCEEDED remains terminal. UNKNOWN continues blocking confirmation until final evidence establishes an outcome.

## Late responses and retained records

A worker may still receive an older response after manual resolution or a later attempt. It appends bounded observation history tied to the old attempt. It does not change financial state, revision, the saved decision, or webhook count. A definite response contradicting that old attempt's resolved outcome emits `provider_observation_conflicts` with its attempt ID. Operator ledger inspection after a hard-aborted request is separate evidence and does not create a fabricated worker observation.

Cases, decisions, evidence, original identities, and history persist across process restart for the lifetime of prototype data. The list index migration is additive and retains existing investigations and constraints. There is no automatic purge, mock closure command, automatic UNKNOWN resolution, or status override endpoint.

`bun run test tests/reconciliation` exercises the real trusted commands, HTTP lookup, workers, mock, rollback and SIGKILL/restart, concurrent decisions, canonical replay, failure retry, delayed acceptance, late observations, and migration retention. A test-only HTTP proxy loses or delays actual mock replies and alters a reply in the contradictory-evidence test. It never edits the immutable mock ledger. The controlled scheduling clock and real transport deadline remain separate, as documented in [provider recovery](provider-worker.md#recovery-across-processes).
