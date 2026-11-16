import { type } from "arktype";
import { createHttpApp, errorResponse } from "../../contracts/http.ts";
import { registerOpenApi } from "../../contracts/openapi.ts";
import {
  commandKey,
  createPaymentInput,
  creationAcknowledgment,
  paymentId,
  paymentSnapshot,
  confirmPaymentInput,
  confirmationAcknowledgment,
} from "../../contracts/payments.ts";
import { registerCheckout } from "./checkout.ts";
import {
  sendConfirmationResult,
  sendCommandResult,
} from "./confirmation-response.ts";
import type { PaybridgeDatabase } from "./database.ts";
import { authenticateMerchant } from "./merchants.ts";
import { confirmPayment, cancelPayment } from "./payment-commands.ts";
import { createPayment, lookupPayment, validReturnUrl } from "./payments.ts";

export async function createPaybridgeApp({
  db,
  paybridgeOrigin,
  beforeCreationCommit,
  beforeConfirmationCommit,
  beforeCancellationCommit,
}: {
  db: PaybridgeDatabase;
  paybridgeOrigin: string;
  beforeCreationCommit?: () => Promise<void>;
  beforeConfirmationCommit?: () => Promise<void>;
  beforeCancellationCommit?: () => Promise<void>;
}) {
  const { app, requestSchema } = await createHttpApp({
    title: "Paybridge simulated payments",
    openapi: {
      components: {
        securitySchemes: {
          checkoutCapability: {
            type: "apiKey",
            in: "query",
            name: "token",
            description:
              "Random payment-bound checkout capability. Missing, invalid, or differently bound tokens return generic not-found; they are not merchant API credentials.",
          },
          merchantCredential: {
            type: "http",
            scheme: "bearer",
            description:
              "Server-side Paybridge merchant API credential. Provider merchant keys are not accepted.",
          },
        },
      },
    },
  });
  const snapshotHeaders = {
    "cache-control": { type: "string", const: "no-store" },
    "x-content-type-options": { type: "string", const: "nosniff" },
  };
  const errors = {
    ...Object.fromEntries(
      [400, 401, 404, 413, 414, 415, 500].map((status) => [
        status,
        { ...errorResponse.toJsonSchema(), headers: snapshotHeaders },
      ]),
    ),
    409: {
      ...errorResponse.toJsonSchema(),
      headers: {
        ...snapshotHeaders,
        "retry-after": {
          type: "string",
          const: "1",
          description:
            "Present only for command_in_progress. Omitted for other conflicts.",
        },
      },
    },
    503: {
      ...errorResponse.toJsonSchema(),
      headers: {
        ...snapshotHeaders,
        "retry-after": {
          type: "string",
          const: "1",
          description: "Retry the original command and key after one second.",
        },
      },
    },
  };
  const noQuery = requestSchema({ validator: type({ "+": "reject" }) });
  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff");
  });
  const error = ({
    code,
    message,
    requestId,
  }: {
    code: string;
    message: string;
    requestId: string;
  }) => ({
    error: { code, message, requestId },
  });
  const fallbackErrorHandler = app.errorHandler;
  app.setErrorHandler(function (cause, request, reply) {
    if (
      cause instanceof Error &&
      "transient" in cause &&
      cause.transient === true
    )
      return reply
        .code(503)
        .header("retry-after", "1")
        .send(
          error({
            code: "temporarily_unavailable",
            message:
              "Database access is temporarily unavailable. Retry commands with the same key.",
            requestId: request.id,
          }),
        );
    return fallbackErrorHandler.call(this, cause, request, reply);
  });
  const params = type({ paymentId, "+": "reject" });

  const creationHeaders = type({ "idempotency-key": commandKey });
  const security = [{ merchantCredential: [] }];

  app.post<{
    Body: typeof createPaymentInput.infer;
    Headers: typeof creationHeaders.infer;
  }>(
    "/v1/payment-intents",
    {
      schema: {
        security,
        querystring: noQuery,
        headers: requestSchema({ validator: creationHeaders }),
        body: requestSchema({ validator: createPaymentInput }),
        response: {
          201: {
            ...creationAcknowledgment.toJsonSchema(),
            headers: { location: { type: "string" }, ...snapshotHeaders },
          },
          ...errors,
        },
      },
      preValidation: async (request, reply) => {
        if (
          commandKey(request.headers["idempotency-key"]) instanceof type.errors
        )
          return reply
            .code(400)
            .send(
              error({
                code: "invalid_idempotency_key",
                message: "A command key of 1 to 128 characters is required.",
                requestId: request.id,
              }),
            );
      },
    },
    async (request, reply) => {
      const merchant = await authenticateMerchant({
        db,
        authorization: request.headers.authorization,
      });
      if (!merchant)
        return reply
          .code(401)
          .send(
            error({
              code: "unauthorized",
              message: "Valid merchant credentials are required.",
              requestId: request.id,
            }),
          );
      if (!validReturnUrl({ input: request.body, merchant }))
        return reply
          .code(400)
          .send(
            error({
              code: "invalid_request",
              message: "The return URL is not permitted.",
              requestId: request.id,
            }),
          );
      const key = request.headers["idempotency-key"];
      const result = await createPayment({
        db,
        merchant,
        input: request.body,
        paybridgeOrigin,
        key,
        ...(beforeCreationCommit ? { beforeCommit: beforeCreationCommit } : {}),
      });
      return sendCommandResult({ reply, result, requestId: request.id });
    },
  );
  app.get<{ Params: typeof params.infer }>(
    "/v1/payment-intents/:paymentId",
    {
      schema: {
        security,
        querystring: noQuery,
        params: requestSchema({ validator: params }),
        response: {
          200: { ...paymentSnapshot.toJsonSchema(), headers: snapshotHeaders },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const merchant = await authenticateMerchant({
        db,
        authorization: request.headers.authorization,
      });
      if (!merchant)
        return reply
          .code(401)
          .send(
            error({
              code: "unauthorized",
              message: "Valid merchant credentials are required.",
              requestId: request.id,
            }),
          );
      const payment = await lookupPayment({
        db,
        merchant,
        id: request.params.paymentId,
      });
      if (!payment)
        return reply
          .code(404)
          .send(
            error({
              code: "payment_not_found",
              message: "The payment was not found.",
              requestId: request.id,
            }),
          );
      return payment;
    },
  );
  app.post<{
    Body: typeof confirmPaymentInput.infer;
    Params: typeof params.infer;
    Headers: typeof creationHeaders.infer;
  }>(
    "/v1/payment-intents/:paymentId/confirm",
    {
      schema: {
        security,
        querystring: noQuery,
        params: requestSchema({ validator: params }),
        headers: requestSchema({ validator: creationHeaders }),
        body: requestSchema({ validator: confirmPaymentInput }),
        response: {
          202: {
            ...confirmationAcknowledgment.toJsonSchema(),
            headers: { location: { type: "string" }, ...snapshotHeaders },
          },
          ...errors,
        },
      },
      preValidation: async (request, reply) => {
        if (
          commandKey(request.headers["idempotency-key"]) instanceof type.errors
        )
          return reply
            .code(400)
            .send(
              error({
                code: "invalid_idempotency_key",
                message: "A command key of 1 to 128 characters is required.",
                requestId: request.id,
              }),
            );
      },
    },
    async (request, reply) => {
      const merchant = await authenticateMerchant({
        db,
        authorization: request.headers.authorization,
      });
      if (!merchant)
        return reply
          .code(401)
          .send(
            error({
              code: "unauthorized",
              message: "Valid merchant credentials are required.",
              requestId: request.id,
            }),
          );
      const result = await confirmPayment({
        db,
        merchant,
        id: request.params.paymentId,
        input: request.body,
        key: request.headers["idempotency-key"],
        acknowledgment: { kind: "merchant", paybridgeOrigin },
        ...(beforeConfirmationCommit
          ? { beforeCommit: beforeConfirmationCommit }
          : {}),
      });
      return sendConfirmationResult({ reply, result, requestId: request.id });
    },
  );
  app.post<{ Params: typeof params.infer }>(
    "/v1/payment-intents/:paymentId/cancel",
    {
      schema: {
        security,
        querystring: noQuery,
        params: requestSchema({ validator: params }),
        description:
          "Permanently cancel a PENDING payment. No request body or idempotency key is required. Repeats return the unchanged cancelled snapshot.",
        response: {
          200: { ...paymentSnapshot.toJsonSchema(), headers: snapshotHeaders },
          ...errors,
        },
      },
      preValidation: async (request, reply) => {
        if (request.body !== undefined)
          return reply
            .code(400)
            .send(
              error({
                code: "invalid_request",
                message: "Cancellation has no request body.",
                requestId: request.id,
              }),
            );
      },
    },
    async (request, reply) => {
      const merchant = await authenticateMerchant({
        db,
        authorization: request.headers.authorization,
      });
      if (!merchant)
        return reply
          .code(401)
          .send(
            error({
              code: "unauthorized",
              message: "Valid merchant credentials are required.",
              requestId: request.id,
            }),
          );
      const result = await cancelPayment({
        db,
        merchant,
        id: request.params.paymentId,
        ...(beforeCancellationCommit
          ? { beforeCommit: beforeCancellationCommit }
          : {}),
      });
      switch (result.kind) {
        case "cancelled":
          return result.payment;
        case "not_found":
          return reply
            .code(404)
            .send(
              error({
                code: "payment_not_found",
                message: "The payment was not found.",
                requestId: request.id,
              }),
            );
        case "not_cancellable":
          return reply
            .code(409)
            .send(
              error({
                code: "payment_not_cancellable",
                message:
                  "The payment cannot be cancelled in its current state.",
                requestId: request.id,
              }),
            );
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    },
  );
  registerCheckout({
    app,
    requestSchema,
    db,
    errors,
    snapshotHeaders,
    ...(beforeConfirmationCommit
      ? { beforeCommit: beforeConfirmationCommit }
      : {}),
  });
  registerOpenApi(app);
  app.addHook("onClose", () => db.close());
  return app;
}
