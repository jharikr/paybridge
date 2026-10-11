import { setTimeout } from "node:timers/promises";
import { type } from "arktype";
import Fastify from "fastify";
import {
  buildFourcsResponse,
  parseFourcsRequest,
  soapAction,
  soapBodyLimit,
  soapPath,
  SoapProtocolError,
} from "../../contracts/fourcs.ts";
import { acceptTransaction, openMockDatabase } from "./database.ts";

export interface MockCheckpoint {
  kind: "before-acceptance" | "after-acceptance";
  providerAccount: string;
  tranId: string;
  held: boolean;
}
export async function createMockFourcs({
  databasePath,
  checkpoint = async ({ held }) => {
    if (held) await setTimeout(2_000);
  },
}: {
  databasePath: string;
  checkpoint?: (event: MockCheckpoint) => Promise<void>;
}) {
  const db = await openMockDatabase({ path: databasePath });
  const app = Fastify({ logger: false, bodyLimit: soapBodyLimit });
  app.addHook("onClose", async () => {
    await db.close();
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "text/xml",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof SoapProtocolError
        ? 400
        : type({ statusCode: "number.integer" }).allows(error)
          ? error.statusCode
          : 500;
    return reply
      .code(statusCode)
      .type("text/xml")
      .send(
        buildFourcsResponse({
          operationResult: "UnableToProcessInternalProblem",
          resultCode: "ParameterError",
        }),
      );
  });
  app.post(soapPath, async (incoming, reply) => {
    reply.type("text/xml; charset=utf-8");
    if (
      incoming.headers.soapaction !== soapAction ||
      typeof incoming.body !== "string"
    )
      throw new SoapProtocolError();
    const request = parseFourcsRequest(incoming.body);
    if (request.kind === "unauthorized")
      return buildFourcsResponse({ resultCode: "SecurityError" });
    if (
      request.paymentMethodRef === "pm_mock_held_before_acceptance" ||
      request.paymentMethodRef === "pm_mock_fail_before_acceptance"
    ) {
      const existing = await db.orm.MockTransaction.where({
        id: `${request.providerAccount}:${request.tranId}`,
      }).first();
      if (existing)
        return buildFourcsResponse({
          resultCode: "DuplicateTransaction",
          request,
        });
      if (request.paymentMethodRef === "pm_mock_fail_before_acceptance")
        return buildFourcsResponse({ resultCode: "Unavailable", request });
      await checkpoint({
        kind: "before-acceptance",
        providerAccount: request.providerAccount,
        tranId: request.tranId,
        held: true,
      });
    }
    const accepted = await acceptTransaction({ db, request });
    if (accepted.kind === "duplicate")
      return buildFourcsResponse({
        resultCode: "DuplicateTransaction",
        request,
      });
    await checkpoint({
      kind: "after-acceptance",
      providerAccount: request.providerAccount,
      tranId: request.tranId,
      held: request.paymentMethodRef === "pm_mock_delayed_response",
    });
    if (
      request.paymentMethodRef === "pm_mock_lost_response" ||
      request.paymentMethodRef === "pm_mock_decline_lost_response"
    ) {
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    if (request.paymentMethodRef === "pm_mock_malformed") return "<invalid";
    const operationResult =
      request.paymentMethodRef === "pm_mock_invalid_operation"
        ? "UnableToProcessInternalProblem"
        : "OK";
    const resultCode =
      request.paymentMethodRef === "pm_mock_invalid_service"
        ? "GeneralError"
        : "OK";
    const echo =
      request.paymentMethodRef === "pm_mock_mismatched_echo"
        ? { ...request, tranId: "WRONGECHO" }
        : request;
    return buildFourcsResponse({
      operationResult,
      resultCode,
      financialResult: accepted.finalOutcome,
      request: echo,
      hostReference: accepted.hostReference,
      approvalCode: accepted.approvalCode,
    });
  });
  return app;
}
