import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { startNodeProcess } from "../support/process.ts";
import { ready, rows } from "../provider/support.ts";

export const creation = type({ id: "string", checkoutUrl: "string" });
export function checkout({
  url,
  payment,
  action,
}: {
  url: string;
  payment: typeof creation.infer;
  action?: "confirm" | "leave";
}) {
  const original = new URL(payment.checkoutUrl);
  return `${url}${original.pathname}${action ? `/${action}` : ""}${original.search}`;
}
export function checkoutConfirm({
  url,
  payment,
  key = "checkout-1",
  revision = 1,
  fixture = "pm_mock_approved",
}: {
  url: string;
  payment: typeof creation.infer;
  key?: string;
  revision?: number;
  fixture?: string;
}) {
  return fetch(checkout({ url, payment, action: "confirm" }), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      mockPaymentMethodRef: fixture,
      expectedRevision: revision,
    }),
  });
}
export function paymentRecords(path: string) {
  return Object.fromEntries(
    [
      "payment_intents",
      "payment_attempts",
      "provider_outbox",
      "payment_events",
      "webhook_outbox",
      "idempotency_keys",
    ].map((table) => [
      table,
      rows(
        path,
        table === "webhook_outbox"
          ? "SELECT id,payment_event_id,merchant_id,payment_intent_id,event_type,payload,created_at FROM webhook_outbox ORDER BY rowid"
          : `SELECT * FROM ${table} ORDER BY rowid`,
      ),
    ]),
  );
}
export async function controlledPaybridge({
  path,
  fault,
}: {
  path: string;
  fault: "rollback" | "before-commit" | "after-commit" | "lookup";
}) {
  const process = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("./fixtures/paybridge.ts", import.meta.url),
    ),
    args: [path, fault],
  });
  try {
    return { ...process, url: ready.assert(await process.message()).url };
  } catch (error) {
    await process.stop();
    throw error;
  }
}
export async function controlledMerchant({
  path,
  paybridgeUrl,
  fault,
}: {
  path: string;
  paybridgeUrl: string;
  fault: "rollback" | "before-commit";
}) {
  const process = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("./fixtures/merchant.ts", import.meta.url),
    ),
    args: [path, paybridgeUrl, fault],
  });
  try {
    return { ...process, url: ready.assert(await process.message()).url };
  } catch (error) {
    await process.stop();
    throw error;
  }
}
