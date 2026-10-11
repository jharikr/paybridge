import { type } from "arktype";
import { errorResponse } from "../../contracts/http.ts";
import { paymentSnapshot } from "../../contracts/payments.ts";
import { orderId } from "../../contracts/merchant.ts";
import type { MerchantContext } from "./config.ts";
import type { MerchantDatabase } from "./database.ts";
import { MerchantError, readOrder } from "./orders.ts";

export const storedAcknowledgment = type({
  status: "100 <= number.integer <= 599",
  body: "string",
  headers: { "[string]": "string" },
});
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new MerchantError({
      status: 502,
      code: "invalid_paybridge_response",
    });
  }
}

export async function paybridgeRequest({
  origin,
  merchant,
  target,
  command,
}: {
  origin: string;
  merchant: MerchantContext;
  target: string;
  command?: { key: string; body: string };
}) {
  let response: Response;
  let body: string;
  try {
    response = await fetch(`${origin}${target}`, {
      method: command ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${merchant.credential}`,
        ...(command
          ? {
              "content-type": "application/json",
              "idempotency-key": command.key,
            }
          : {}),
      },
      ...(command ? { body: command.body } : {}),
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.body)
      throw new MerchantError({
        status: 502,
        code: "invalid_paybridge_response",
      });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16_384)
        throw new MerchantError({
          status: 502,
          code: "invalid_paybridge_response",
        });
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof MerchantError) throw error;
    throw new MerchantError({ status: 503, code: "paybridge_unavailable" });
  }
  if (
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 429
  )
    throw new MerchantError({ status: 503, code: "paybridge_unavailable" });
  const value = parseJson(body);
  if (response.status >= 400) {
    const failure = errorResponse(value);
    if (failure instanceof type.errors)
      throw new MerchantError({
        status: 502,
        code: "invalid_paybridge_response",
      });
    if (failure.error.code === "command_in_progress")
      throw new MerchantError({ status: 503, code: "paybridge_unavailable" });
  }
  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "x-content-type-options",
    "location",
  ]) {
    const header = response.headers.get(name);
    if (header !== null) headers[name] = header;
  }
  return { acknowledgment: { status: response.status, body, headers }, value };
}

export async function lookupOrderPayment({
  db,
  merchant,
  id,
  paybridgeOrigin,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
  paybridgeOrigin: string;
}) {
  const order = await readOrder({ db, merchant, id });
  if (order.paymentIntentId === null)
    throw new MerchantError({ status: 409, code: "payment_not_created" });
  const response = await paybridgeRequest({
    origin: paybridgeOrigin,
    merchant,
    target: `/v1/payment-intents/${order.paymentIntentId}`,
  });
  const snapshot = paymentSnapshot(response.value);
  if (
    response.acknowledgment.status !== 200 ||
    snapshot instanceof type.errors ||
    snapshot.id !== order.paymentIntentId ||
    snapshot.merchantReference !== order.businessReference ||
    snapshot.amount !== order.amount ||
    snapshot.currency !== order.currency
  )
    throw new MerchantError({
      status: 502,
      code: "invalid_paybridge_response",
    });
  return snapshot;
}
