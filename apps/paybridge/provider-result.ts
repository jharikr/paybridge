import {
  formatFourcsAmount,
  parseFourcsResponse,
} from "../../contracts/fourcs.ts";
import type { FourcsRequestInput } from "../../contracts/fourcs.ts";

const operationCodes = [
  "OK",
  "NotAcceptingRequests",
  "UnableToProcessInternalProblem",
  "Timeout",
];
const serviceCodes = [
  "OK",
  "ParameterError",
  "Unavailable",
  "DuplicateTransaction",
  "TooBusy",
  "GeneralError",
  "SecurityError",
  "MerchantError",
  "NotFound",
  "ExceedsAvailableAmount",
  "WrongState",
  "Expired",
];
const financialCodes = ["Approved", "Declined", "Incomplete"];
type Evidence = Omit<
  ReturnType<typeof parseFourcsResponse>,
  "operation" | "service" | "financial"
> & {
  operation: string | null;
  service: string | null;
  financial: string | null;
};
export type ProviderResult =
  | { kind: "succeeded"; evidence: Evidence }
  | { kind: "failed"; code: "Declined" | "Incomplete"; evidence: Evidence }
  | {
      kind: "unknown";
      code:
        | "MalformedResponse"
        | "MismatchedEcho"
        | "InvalidOperationResult"
        | "InvalidServiceResult"
        | "InvalidFinancialResult"
        | "DuplicateTransaction"
        | "Timeout"
        | "TransportFailure"
        | "InvalidHttpResponse"
        | "ResponseTooLarge";
      evidence: Evidence | null;
    };

export function interpretProviderResponse({
  xml,
  expected,
}: {
  xml: string;
  expected: Pick<
    FourcsRequestInput,
    "invoice" | "tranId" | "amountMinor" | "currency"
  >;
}): ProviderResult {
  let parsed: ReturnType<typeof parseFourcsResponse>;
  try {
    parsed = parseFourcsResponse(xml);
  } catch {
    return { kind: "unknown", code: "MalformedResponse", evidence: null };
  }
  const evidence = {
    ...parsed,
    operation: operationCodes.includes(parsed.operation)
      ? parsed.operation
      : null,
    service: serviceCodes.includes(parsed.service) ? parsed.service : null,
    financial: financialCodes.includes(parsed.financial)
      ? parsed.financial
      : null,
  };
  if (parsed.operation !== "OK")
    return { kind: "unknown", code: "InvalidOperationResult", evidence };
  if (parsed.service !== "OK")
    return {
      kind: "unknown",
      code:
        parsed.service === "DuplicateTransaction"
          ? "DuplicateTransaction"
          : "InvalidServiceResult",
      evidence,
    };
  if (
    parsed.invoice !== expected.invoice ||
    parsed.tranId !== expected.tranId ||
    parsed.amount !== formatFourcsAmount(expected.amountMinor) ||
    parsed.currency !== expected.currency
  )
    return { kind: "unknown", code: "MismatchedEcho", evidence };
  switch (parsed.financial) {
    case "Approved":
      return { kind: "succeeded", evidence };
    case "Declined":
    case "Incomplete":
      return { kind: "failed", code: parsed.financial, evidence };
    default:
      return { kind: "unknown", code: "InvalidFinancialResult", evidence };
  }
}
