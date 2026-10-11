import { setTimeout } from "node:timers/promises";
import { type } from "arktype";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { registerOpenApi } from "../../contracts/openapi.ts";
import {
  buildFourcsResponse,
  providerTranId,
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
  const app = Fastify({
    logger: false,
    bodyLimit: soapBodyLimit,
    exposeHeadRoutes: false,
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Synthetic 4Cs SOAP mock", version: "0.1.0" },
    },
  });
  registerOpenApi(app);
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
  app.post(
    soapPath,
    {
      schema: {
        description:
          "Local synthetic SSISProcessTransaction only, not a live-provider compatibility claim. Requires the SOAP 1.1 Envelope/Body and SSIS operation/request namespaces and exact field hierarchy, with one of each required child. DTDs, custom/external entities, unexpected attributes/elements and real card values are rejected; predefined XML escapes are supported. Only AuthAndPost, XCD, fixture credentials and synthetic payment references are supported. Amount is a positive decimal with two fractional digits, at most 99999999.99. Invoice and TranId are 1–16 alphanumeric characters. Identity is immutable within a provider account. HTTP 200 still requires separate outer operation, service and financial result interpretation. Some accepted fixtures deliberately return malformed XML, mismatched echoes, or disconnect without an HTTP response; delayed acceptance and delayed response are distinct scenarios.",
        consumes: ["text/xml"],
        headers: {
          type: "object",
          required: ["soapaction"],
          properties: { soapaction: { type: "string", const: soapAction } },
        },
        body: {
          type: "string",
          description:
            "SOAP XML 1.0 request, at most 16,384 UTF-8 bytes. JSON Schema cannot validate the XML grammar or account-bound fixture rules.",
        },
        response: Object.fromEntries(
          [200, 400, 413, 415, 500].map((status) => [
            status,
            {
              description:
                status === 200
                  ? "SOAP result or intentionally malformed synthetic response. SecurityError and DuplicateTransaction are service results with HTTP 200. A disconnected fixture supplies no HTTP acknowledgment."
                  : "SOAP error response with UnableToProcessInternalProblem and ParameterError. No JSON error envelope.",
              content: { "text/xml": { schema: { type: "string" } } },
            },
          ]),
        ),
      },
    },
    async (incoming, reply) => {
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
          ? { ...request, tranId: providerTranId.assert("WRONGECHO") }
          : request;
      return buildFourcsResponse({
        operationResult,
        resultCode,
        financialResult: accepted.finalOutcome,
        request: echo,
        hostReference: accepted.hostReference,
        approvalCode: accepted.approvalCode,
      });
    },
  );
  return app;
}
