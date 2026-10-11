import { type } from "arktype";
import { boundedText } from "./payments.ts";

export const reconciliationId =
  type(/^rec_[a-f0-9]{32}$/).brand("ReconciliationId");
const requiredText = (limit: number) =>
  boundedText(limit).narrow((value) => value.trim().length > 0);
const providerReference = type(/^[A-Za-z0-9]{1,16}$/);
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
  tranId: providerReference,
  invoice: providerReference,
  amountMinor: "1 <= number.integer <= 9999999999",
  currency: "'XCD'",
  finalOutcome: "'Approved' | 'Declined' | 'Incomplete'",
  effectCount: "0 | 1",
  hostReference: type(/^[a-f0-9]{16}$/),
  approvalCode: type(/^[A-Za-z0-9]{1,12}$/).or("null"),
  acceptedAt: instant,
  requestFingerprint: type(/^[a-f0-9]{64}$/),
  "+": "reject",
}).narrow((facts) =>
  facts.finalOutcome === "Approved"
    ? facts.effectCount === 1 && facts.approvalCode !== null
    : facts.effectCount === 0 && facts.approvalCode === null,
);
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
