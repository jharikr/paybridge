import { providerTranId, providerInvoice } from "./fourcs.ts";
import { type } from "arktype";
import { boundedText } from "./payments.ts";

export const reconciliationId =
  type(/^rec_[a-f0-9]{32}$/).brand("ReconciliationId");
const requiredText = (limit: number) =>
  boundedText(limit).narrow((value) => value.trim().length > 0);
const instant = type(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).narrow(
  (value) => {
    const milliseconds = Date.parse(value);
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    );
  },
);
export const finalEvidence = type({
  providerAccount: "'mock-account-a' | 'mock-account-b'",
  tranId: providerTranId,
  invoice: providerInvoice,
  amountMinor: "1 <= number.integer <= 9999999999",
  currency: "'XCD'",
  hostReference: type(/^[a-f0-9]{16}$/),
  acceptedAt: instant,
  requestFingerprint: type(/^[a-f0-9]{64}$/),
})
  .and(
    type({
      finalOutcome: "'Approved'",
      effectCount: "1",
      approvalCode: /^[A-Za-z0-9]{1,12}$/,
    }).or({
      finalOutcome: "'Declined' | 'Incomplete'",
      effectCount: "0",
      approvalCode: "null",
    }),
  )
  .onUndeclaredKey("reject");
export const resolutionCommand = type({
  kind: "'resolve'",
  reconciliationId,
  operator: requiredText(128),
  resolution: "'SUCCEEDED' | 'FAILED'",
  reason: requiredText(512),
  "notes?": boundedText(1024),
  evidenceReference: requiredText(512),
  evidence: { kind: "'recorded'", evidence: finalEvidence, "+": "reject" },
  "+": "reject",
});
export const reconciliationCommand = type({ kind: "'list'", "+": "reject" })
  .or({
    kind: "'start'",
    reconciliationId,
    operator: requiredText(128),
    "+": "reject",
  })
  .or(resolutionCommand);
export type ReconciliationCommand = typeof reconciliationCommand.infer;
