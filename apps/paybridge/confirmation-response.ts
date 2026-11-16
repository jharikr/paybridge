import type { FastifyReply } from "fastify";
import type { Reservation } from "./commands.ts";
import type { ConfirmationResult } from "./payment-commands.ts";

export function sendConfirmationResult({
  reply,
  result,
  requestId,
}: {
  reply: FastifyReply;
  result: ConfirmationResult;
  requestId: string;
}) {
  const error = ({ code, message }: { code: string; message: string }) => ({
    error: { code, message, requestId },
  });
  switch (result.kind) {
    case "completed":
    case "conflict":
    case "in_progress":
      return sendCommandResult({ reply, result, requestId });
    case "not_found":
      return reply.code(404).send(
        error({
          code: "payment_not_found",
          message: "The payment was not found.",
        }),
      );
    case "revision_conflict":
      return reply.code(409).send(
        error({
          code: "payment_revision_conflict",
          message: "The payment revision has changed.",
        }),
      );
    case "not_confirmable":
      return reply.code(409).send(
        error({
          code: "payment_not_confirmable",
          message: "The payment cannot be confirmed in its current state.",
        }),
      );
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export function sendCommandResult({
  reply,
  result,
  requestId,
}: {
  reply: FastifyReply;
  result: Exclude<Reservation, { kind: "new" }>;
  requestId: string;
}) {
  const error = ({ code, message }: { code: string; message: string }) => ({
    error: { code, message, requestId },
  });
  switch (result.kind) {
    case "completed":
      return reply
        .code(result.acknowledgment.status)
        .headers(result.acknowledgment.headers)
        .send(result.acknowledgment.body);
    case "conflict":
      return reply.code(409).send(
        error({
          code: "idempotency_conflict",
          message: "The command key identifies a different request.",
        }),
      );
    case "in_progress":
      return reply
        .code(409)
        .header("retry-after", "1")
        .send(
          error({
            code: "command_in_progress",
            message: "The command is still in progress.",
          }),
        );
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
