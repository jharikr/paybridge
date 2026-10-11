import { type } from "arktype";
import { registerWebhooks, type ReceiptCheckpoint } from "./webhooks.ts";
import type { FastifyReply } from "fastify";
import { createHttpApp, errorResponse } from "../../contracts/http.ts";
import {
  createOrderInput,
  merchantCommandId,
  merchantCommandList,
  merchantConfirmationInput,
  orderId,
  orderView,
} from "../../contracts/merchant.ts";
import {
  confirmationAcknowledgment,
  creationAcknowledgment,
  paymentSnapshot,
} from "../../contracts/payments.ts";
import { merchantContext } from "./config.ts";
import { createOrder, MerchantError, readOrder } from "./orders.ts";
import {
  executeCommand,
  prepareCreation,
  prepareConfirmation,
  recoverCommand,
  listCommands,
} from "./commands.ts";
import { lookupAndApplyPayment } from "./snapshots.ts";
import { registerMerchantReturn } from "./return.ts";
import type { CommandCheckpoint } from "./commands.ts";
import type { MerchantDatabase } from "./database.ts";

export async function createMerchantApp({
  db,
  paybridgeOrigin,
  checkpoint,
  beforeSnapshotCommit,
  receiptCheckpoint,
  webhookNow,
  webhookToleranceSeconds,
}: {
  db: MerchantDatabase;
  paybridgeOrigin: string;
  checkpoint?: CommandCheckpoint;
  beforeSnapshotCommit?: () => Promise<void>;
  receiptCheckpoint?: ReceiptCheckpoint;
  webhookNow?: () => Date;
  webhookToleranceSeconds?: number;
}) {
  const { app, requestSchema } = await createHttpApp({
    title: "Sample merchant",
  });
  app.addHook("onClose", async () => {
    await db.close();
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff");
  });
  const fallbackErrorHandler = app.errorHandler;
  app.setErrorHandler(function (error, request, reply) {
    if (
      error instanceof Error &&
      "transient" in error &&
      error.transient === true
    )
      return reply
        .code(503)
        .header("retry-after", "1")
        .send({
          error: {
            code: "temporarily_unavailable",
            message: "Retry the original merchant command.",
            requestId: request.id,
          },
        });
    if (error instanceof MerchantError) {
      if (error.status === 503) reply.header("retry-after", "1");
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: "The merchant request could not be completed.",
          requestId: request.id,
        },
      });
    }
    return fallbackErrorHandler.call(this, error, request, reply);
  });
  const securityHeaders = {
    "cache-control": { type: "string", const: "no-store" },
    "x-content-type-options": { type: "string", const: "nosniff" },
  };
  const acknowledgmentHeaders = {
    ...securityHeaders,
    location: {
      type: "string",
      pattern: "^/v1/payment-intents/pi_[a-f0-9]{32}$",
    },
    "x-merchant-command-id": { type: "string", pattern: "^mc_[a-f0-9]{32}$" },
  };
  const orderResponse = {
    ...orderView.toJsonSchema(),
    headers: securityHeaders,
  };
  const creationResponse = {
    ...creationAcknowledgment.toJsonSchema(),
    headers: acknowledgmentHeaders,
  };
  const confirmationResponse = {
    ...confirmationAcknowledgment.toJsonSchema(),
    headers: acknowledgmentHeaders,
  };
  const errors = Object.fromEntries(
    [400, 401, 404, 409, 413, 414, 415, 500, 502, 503].map((status) => [
      status,
      {
        ...errorResponse.toJsonSchema(),
        headers: {
          ...securityHeaders,
          ...(status === 503
            ? {
                "retry-after": {
                  type: "string",
                  const: "1",
                  description:
                    "Retry the original stored command after one second.",
                },
              }
            : {}),
          ...(status < 500
            ? {
                "x-merchant-command-id": {
                  type: "string",
                  pattern: "^mc_[a-f0-9]{32}$",
                  description:
                    "Present for a retained Paybridge command rejection; absent for a local rejection.",
                },
              }
            : {}),
        },
      },
    ]),
  );
  const empty = type({ "+": "reject" });
  const merchantParams = type({ merchantFixture: "string", "+": "reject" });
  const orderParams = merchantParams.merge({ orderId });
  function context(value: unknown) {
    const merchant = merchantContext(value);
    if (!merchant) throw new MerchantError(404, "order_not_found");
    return merchant;
  }
  app.post(
    "/:merchantFixture/orders",
    {
      schema: {
        params: requestSchema(merchantParams),
        querystring: requestSchema(empty),
        body: requestSchema(createOrderInput),
        response: {
          200: orderResponse,
          201: orderResponse,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const params = merchantParams.assert(request.params);
      const result = await createOrder({
        db,
        merchant: context(params.merchantFixture),
        input: createOrderInput.assert(request.body),
      });
      return reply.code(result.created ? 201 : 200).send(result.order);
    },
  );
  app.get(
    "/:merchantFixture/orders/:orderId",
    {
      schema: {
        params: requestSchema(orderParams),
        querystring: requestSchema(empty),
        response: { 200: orderResponse, ...errors },
      },
    },
    async (request) => {
      const params = orderParams.assert(request.params);
      return readOrder({
        db,
        merchant: context(params.merchantFixture),
        id: params.orderId,
      });
    },
  );
  app.post(
    "/:merchantFixture/orders/:orderId/payment",
    {
      schema: {
        params: requestSchema(orderParams),
        querystring: requestSchema(empty),
        response: { 201: creationResponse, ...errors },
      },
    },
    async (request, reply) => {
      if (request.body !== undefined) return sendError(reply, request.id);
      const params = orderParams.assert(request.params);
      const merchant = context(params.merchantFixture);
      const command = await prepareCreation({
        db,
        merchant,
        id: params.orderId,
      });
      const result = await executeCommand({
        db,
        merchant,
        command,
        paybridgeOrigin,
        ...(checkpoint ? { checkpoint } : {}),
      });
      return sendAcknowledgment(reply, result);
    },
  );
  app.get("/openapi.json", async () => app.swagger());
  app.get(
    "/:merchantFixture/orders/:orderId/commands",
    {
      schema: {
        params: requestSchema(orderParams),
        querystring: requestSchema(empty),
        response: {
          200: {
            ...merchantCommandList.toJsonSchema(),
            headers: securityHeaders,
          },
          ...errors,
        },
      },
    },
    async (request) => {
      const params = orderParams.assert(request.params);
      return listCommands({
        db,
        merchant: context(params.merchantFixture),
        id: params.orderId,
      });
    },
  );
  const recoveryParams = orderParams.merge({ commandId: merchantCommandId });
  app.post(
    "/:merchantFixture/orders/:orderId/commands/:commandId/recover",
    {
      schema: {
        params: requestSchema(recoveryParams),
        querystring: requestSchema(empty),
        response: {
          201: creationResponse,
          202: confirmationResponse,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      if (request.body !== undefined) return sendError(reply, request.id);
      const params = recoveryParams.assert(request.params);
      const merchant = context(params.merchantFixture);
      const command = await recoverCommand({
        db,
        merchant,
        id: params.orderId,
        commandId: params.commandId,
      });
      const result = await executeCommand({
        db,
        merchant,
        command,
        paybridgeOrigin,
        ...(checkpoint ? { checkpoint } : {}),
      });
      return sendAcknowledgment(reply, result);
    },
  );
  app.get(
    "/:merchantFixture/orders/:orderId/payment",
    {
      schema: {
        params: requestSchema(orderParams),
        querystring: requestSchema(empty),
        response: {
          200: { ...paymentSnapshot.toJsonSchema(), headers: securityHeaders },
          ...errors,
        },
      },
    },
    async (request) => {
      const params = orderParams.assert(request.params);
      return (
        await lookupAndApplyPayment({
          db,
          merchant: context(params.merchantFixture),
          id: params.orderId,
          paybridgeOrigin,
          ...(beforeSnapshotCommit
            ? { beforeCommit: beforeSnapshotCommit }
            : {}),
        })
      ).snapshot;
    },
  );
  app.post(
    "/:merchantFixture/orders/:orderId/confirm",
    {
      schema: {
        params: requestSchema(orderParams),
        querystring: requestSchema(empty),
        body: requestSchema(merchantConfirmationInput),
        response: { 202: confirmationResponse, ...errors },
      },
    },
    async (request, reply) => {
      const params = orderParams.assert(request.params);
      const merchant = context(params.merchantFixture);
      const command = await prepareConfirmation({
        db,
        merchant,
        id: params.orderId,
        input: merchantConfirmationInput.assert(request.body),
      });
      const result = await executeCommand({
        db,
        merchant,
        command,
        paybridgeOrigin,
        ...(checkpoint ? { checkpoint } : {}),
      });
      return sendAcknowledgment(reply, result);
    },
  );
  registerMerchantReturn({
    app,
    requestSchema,
    db,
    paybridgeOrigin,
    errors,
    securityHeaders,
    ...(beforeSnapshotCommit ? { beforeCommit: beforeSnapshotCommit } : {}),
  });
  await registerWebhooks({
    app,
    requestSchema,
    db,
    ...(receiptCheckpoint ? { checkpoint: receiptCheckpoint } : {}),
    ...(webhookNow ? { now: webhookNow } : {}),
    ...(webhookToleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: webhookToleranceSeconds }),
  });
  return app;
}

function sendError(reply: FastifyReply, requestId: string) {
  return reply.code(400).send({
    error: {
      code: "invalid_request",
      message: "The request has no body.",
      requestId,
    },
  });
}
function sendAcknowledgment(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof executeCommand>>,
) {
  return reply
    .code(result.acknowledgment.status)
    .headers(result.acknowledgment.headers)
    .header("x-merchant-command-id", result.commandId)
    .send(result.acknowledgment.body);
}
