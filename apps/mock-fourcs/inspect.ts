import { finalEvidence } from "../../contracts/reconciliation.ts";
import { providerTranId } from "../../contracts/fourcs.ts";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";

const input = type({
  path: "string > 0",
  providerAccount: "'mock-account-a' | 'mock-account-b'",
  tranId: providerTranId,
});

try {
  const args = input.assert({
    path: process.argv[2],
    providerAccount: process.argv[3],
    tranId: process.argv[4],
  });
  const db = new DatabaseSync(args.path, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT provider_account AS providerAccount, tran_id AS tranId,
      invoice, amount_minor AS amountMinor, currency, final_outcome AS finalOutcome,
      effect_count AS effectCount, host_reference AS hostReference, approval_code AS approvalCode,
      accepted_at AS acceptedAt, request_fingerprint AS requestFingerprint
      FROM mock_transactions WHERE provider_account = ? AND tran_id = ?`,
      )
      .get(args.providerAccount, args.tranId);
    const result = row
      ? { kind: "recorded", evidence: finalEvidence.assert(row) }
      : {
          kind: "absent",
          providerAccount: args.providerAccount,
          tranId: args.tranId,
        };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "mock-ledger-inspection-failed" })}\n`,
  );
  process.exitCode = 1;
}
