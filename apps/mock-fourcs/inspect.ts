import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";

const input = type({
  path: "string > 0",
  providerAccount: "'mock-account-a' | 'mock-account-b'",
  tranId: /^[A-Za-z0-9]{1,16}$/,
});
const evidence = type({
  providerAccount: "'mock-account-a' | 'mock-account-b'",
  tranId: /^[A-Za-z0-9]{1,16}$/,
  invoice: /^[A-Za-z0-9]{1,16}$/,
  amountMinor: "number.integer >= 1",
  currency: "'XCD'",
  finalOutcome: "'Approved' | 'Declined' | 'Incomplete'",
  effectCount: "0 | 1",
  hostReference: "string",
  approvalCode: "string | null",
  acceptedAt: "string",
  requestFingerprint: "string",
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
      ? { kind: "recorded", evidence: evidence.assert(row) }
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
