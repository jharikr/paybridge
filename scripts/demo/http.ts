import {
  creationAcknowledgment,
  paymentSnapshot,
} from "../../contracts/payments.ts";
import { orderView, type MerchantFixture } from "../../contracts/merchant.ts";
import { requireDemo } from "./process.ts";

export function get(url: string | URL) {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
}

export async function post({
  origin,
  path,
  body,
  key,
  credential,
}: {
  origin: string;
  path: string;
  body?: unknown;
  key?: string;
  credential?: string;
}) {
  return fetch(new URL(path, origin), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
      ...(credential === undefined
        ? {}
        : { authorization: `Bearer ${credential}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function credential(merchant: MerchantFixture) {
  return merchant === "merchant-a"
    ? "mock-paybridge-key-a"
    : "mock-paybridge-key-b";
}

export async function readPayment({
  origin,
  id,
  merchant,
}: {
  origin: string;
  id: string;
  merchant: MerchantFixture;
}) {
  const response = await fetch(`${origin}/v1/payment-intents/${id}`, {
    headers: { authorization: `Bearer ${credential(merchant)}` },
    signal: AbortSignal.timeout(5000),
  });
  requireDemo({
    condition: response.status === 200,
    code: "payment_lookup_failed",
  });
  return paymentSnapshot.assert(await response.json());
}

export async function createBoundOrder({
  origin,
  merchant,
  reference,
}: {
  origin: string;
  merchant: MerchantFixture;
  reference: string;
}) {
  const created = await post({
    origin,
    path: `/${merchant}/orders`,
    body: { businessReference: reference, amount: 7500, currency: "XCD" },
  });
  requireDemo({
    condition: created.status === 201,
    code: "order_creation_failed",
  });
  const order = orderView.assert(await created.json());
  const path = `/${merchant}/orders/${order.id}`;
  const response = await post({ origin, path: `${path}/payment` });
  requireDemo({
    condition: response.status === 201,
    code: "payment_creation_failed",
  });
  const bytes = await response.text();
  const payment = creationAcknowledgment.assert(JSON.parse(bytes));
  const replay = await post({ origin, path: `${path}/payment` });
  requireDemo({
    condition:
      replay.status === 201 &&
      (await replay.text()) === bytes &&
      replay.headers.get("x-merchant-command-id") ===
        response.headers.get("x-merchant-command-id"),
    code: "creation_replay_changed",
  });
  return { merchant, path, payment, order, creationBytes: bytes };
}
export type BoundOrder = Awaited<ReturnType<typeof createBoundOrder>>;

export async function readOrder({
  origin,
  order,
}: {
  origin: string;
  order: BoundOrder;
}) {
  const response = await fetch(`${origin}${order.path}`, {
    signal: AbortSignal.timeout(5000),
  });
  requireDemo({
    condition: response.status === 200,
    code: "order_lookup_failed",
  });
  return orderView.assert(await response.json());
}

export function checkoutPath({
  order,
  operation,
}: {
  order: BoundOrder;
  operation: "confirm" | "leave";
}) {
  const url = new URL(order.payment.checkoutUrl);
  url.pathname += `/${operation}`;
  return url.href;
}
