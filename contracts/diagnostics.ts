import { type } from "arktype";

const operation = type.enumerated(
  "http_request",
  "provider_claim",
  "provider_submit",
  "provider_completion",
  "webhook_claim",
  "webhook_deliver",
  "webhook_completion",
  "inbox_claim",
  "inbox_application",
  "inbox_retry",
  "paybridge_migration",
  "merchant_migration",
  "mock_migration",
  "mock_start",
);
const safeCode = type.enumerated(
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CONSTRAINT",
  "SQLITE_CANTOPEN",
  "ERR_SQLITE_ERROR",
  "ENOENT",
  "EACCES",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "RUNNER_FAILED",
  "MIGRATION_PATH_NOT_FOUND",
  "CLI.UNEXPECTED",
);
export const failureDetails = type({
  operation,
  causes: safeCode
    .or(
      "'storage_unavailable'|'type_error'|'range_error'|'reference_error'|'syntax_error'|'error'|'unclassified_failure'",
    )
    .array()
    .atMostLength(8),
  "+": "reject",
});
function classification(cause: unknown) {
  if (typeof cause === "object" && cause !== null) {
    if ("code" in cause && safeCode.allows(cause.code)) return cause.code;
    if ("transient" in cause && cause.transient === true)
      return "storage_unavailable";
  }
  if (cause instanceof TypeError) return "type_error";
  if (cause instanceof RangeError) return "range_error";
  if (cause instanceof ReferenceError) return "reference_error";
  if (cause instanceof SyntaxError) return "syntax_error";
  if (cause instanceof Error) return "error";
  return "unclassified_failure";
}
export function safeFailure({
  operation: action,
  cause,
}: {
  operation: typeof operation.infer;
  cause: unknown;
}) {
  const causes: ReturnType<typeof classification>[] = [];
  const seen = new Set<unknown>();
  let current = cause;
  while (current !== undefined && causes.length < 8 && !seen.has(current)) {
    seen.add(current);
    causes.push(classification(current));
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  return { operation: action, causes };
}
export type SafeFailure = ReturnType<typeof safeFailure>;
