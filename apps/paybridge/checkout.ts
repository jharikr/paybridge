import { timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import type { FastifyReply } from "fastify";
import type { createHttpApp } from "../../contracts/http.ts";
import {
  checkoutParams,
  checkoutQuery,
  checkoutCapability,
  checkoutDisplay,
} from "../../contracts/checkout.ts";
import { commandKey, confirmPaymentInput } from "../../contracts/payments.ts";
import type { PaybridgeDatabase } from "./database.ts";
import { authenticatedMerchant, hashSecret } from "./merchants.ts";
import { paymentReturnLocation } from "./payments.ts";
import { confirmPayment } from "./payment-commands.ts";
import { sendConfirmationResult } from "./confirmation-response.ts";

async function authorizeCheckout({
  db,
  id,
  token,
}: {
  db: PaybridgeDatabase;
  id: typeof checkoutParams.infer.paymentId;
  token: unknown;
}) {
  if (!checkoutCapability.allows(token)) return null;
  const payment = await db.orm.PaymentIntent.where({ id }).first();
  if (
    !payment ||
    !timingSafeEqual(
      Buffer.from(hashSecret(token)),
      Buffer.from(payment.checkoutTokenHash),
    )
  )
    return null;
  const owner = await db.orm.Merchant.where({
    id: payment.merchantId,
    isActive: 1,
  }).first();
  if (!owner) return null;
  const merchant = authenticatedMerchant.assert({
    id: owner.id,
    returnOrigin: owner.returnOrigin,
    providerAccountRef: owner.providerAccountRef,
  });
  const location = paymentReturnLocation({
    returnUrl: payment.returnUrl,
    id,
    merchant,
  });
  if (location === null) return null;
  return { payment, merchant, location };
}

export function registerCheckout({
  app,
  requestSchema,
  db,
  errors,
  snapshotHeaders,
  beforeCommit,
}: Awaited<ReturnType<typeof createHttpApp>> & {
  db: PaybridgeDatabase;
  errors: Record<string, unknown>;
  snapshotHeaders: object;
  beforeCommit?: () => Promise<void>;
}) {
  const security = [{ checkoutCapability: [] }];
  const params = requestSchema(checkoutParams);
  const querystring = requestSchema(checkoutQuery);
  const redirect = {
    content: { "text/plain": { schema: { type: "string", const: "" } } },
    headers: {
      ...snapshotHeaders,
      location: {
        type: "string",
        description:
          "Registered merchant return URL with the paymentId query parameter.",
      },
    },
  };
  const error = ({
    reply,
    requestId,
    status,
    code,
    message,
  }: {
    reply: FastifyReply;
    requestId: string;
    status: 400 | 404 | 409;
    code: string;
    message: string;
  }) => reply.code(status).send({ error: { code, message, requestId } });
  const notFound = ({
    reply,
    requestId,
  }: {
    reply: FastifyReply;
    requestId: string;
  }) =>
    error({
      reply,
      requestId,
      status: 404,
      code: "payment_not_found",
      message: "The payment was not found.",
    });
  app.get(
    "/checkout/:paymentId",
    {
      schema: {
        security,
        params,
        querystring,
        response: {
          200: { ...checkoutDisplay.toJsonSchema(), headers: snapshotHeaders },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const { paymentId: id } = checkoutParams.assert(request.params);
      const context = await authorizeCheckout({
        db,
        id,
        token: checkoutQuery.assert(request.query).token,
      });
      if (!context) return notFound({ reply, requestId: request.id });
      const payment = context.payment;
      if (payment.status !== "PENDING" && payment.status !== "FAILED")
        return error({
          reply,
          requestId: request.id,
          status: 409,
          code: "payment_not_confirmable",
          message: "The payment cannot currently be paid.",
        });
      return checkoutDisplay.assert({
        paymentIntentId: id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        revision: payment.revision,
        confirmPath: `/checkout/${id}/confirm`,
        leavePath: `/checkout/${id}/leave`,
      });
    },
  );
  app.post(
    "/checkout/:paymentId/leave",
    {
      schema: {
        security,
        params,
        querystring,
        response: { 303: redirect, ...errors },
      },
    },
    async (request, reply) => {
      if (request.body !== undefined)
        return error({
          reply,
          requestId: request.id,
          status: 400,
          code: "invalid_request",
          message: "Leave has no request body.",
        });
      const { paymentId: id } = checkoutParams.assert(request.params);
      const context = await authorizeCheckout({
        db,
        id,
        token: checkoutQuery.assert(request.query).token,
      });
      if (!context) return notFound({ reply, requestId: request.id });
      return reply.code(303).header("location", context.location).send("");
    },
  );
  app.post(
    "/checkout/:paymentId/confirm",
    {
      schema: {
        security,
        params,
        querystring,
        body: requestSchema(confirmPaymentInput),
        headers: requestSchema(type({ "idempotency-key": commandKey })),
        response: { 303: redirect, ...errors },
      },
    },
    async (request, reply) => {
      const { paymentId: id } = checkoutParams.assert(request.params);
      const context = await authorizeCheckout({
        db,
        id,
        token: checkoutQuery.assert(request.query).token,
      });
      if (!context) return notFound({ reply, requestId: request.id });
      const result = await confirmPayment({
        db,
        merchant: context.merchant,
        id,
        input: confirmPaymentInput.assert(request.body),
        key: commandKey.assert(request.headers["idempotency-key"]),
        acknowledgment: { kind: "checkout" },
        ...(beforeCommit ? { beforeCommit } : {}),
      });
      return sendConfirmationResult({ reply, result, requestId: request.id });
    },
  );
}
