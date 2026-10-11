import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { launchMerchant } from "../merchant/support.ts";

const payload =
  '{ "id":"evt_11111111111111111111111111111111", "type":"payment.succeeded", "createdAt":"2026-10-11T12:00:01Z", "data":{"paymentIntentId":"pi_22222222222222222222222222222222","merchantReference":"Café 😀","amount":7500,"currency":"XCD","status":"SUCCEEDED","revision":3}}\n';
function signed({
  body,
  secret = "mock-webhook-secret-a",
}: {
  body: string;
  secret?: string;
}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "paybridge-event-id": "evt_11111111111111111111111111111111",
    "paybridge-timestamp": timestamp,
    "paybridge-signature": `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
  };
}

test("verified early receipts preserve exact bytes and ownership before acknowledging duplicates", async () => {
  await using files = await isolatedDatabases();
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  try {
    const url = `${merchant.url}/api/webhooks/paybridge/merchant-a`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: signed({ body: payload }),
        body: payload,
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT event_id, receiving_merchant_id, payment_intent_id, revision, payload, status, attempt_count FROM webhook_inbox",
      }),
    ).toEqual([
      {
        event_id: "evt_11111111111111111111111111111111",
        receiving_merchant_id: "merchant-a",
        payment_intent_id: "pi_22222222222222222222222222222222",
        revision: 3,
        payload,
        status: "PENDING",
        attempt_count: 0,
      },
    ]);
    expect(
      rows({ path: files.merchant, sql: "SELECT id FROM orders" }),
    ).toEqual([]);
    const changed = `${payload} `;
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: signed({ body: changed }),
          body: changed,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${merchant.url}/api/webhooks/paybridge/merchant-b`, {
          method: "POST",
          headers: signed({ body: payload, secret: "mock-webhook-secret-b" }),
          body: payload,
        })
      ).status,
    ).toBe(409);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT payload, receiving_merchant_id FROM webhook_inbox",
      }),
    ).toEqual([{ payload, receiving_merchant_id: "merchant-a" }]);
  } finally {
    await merchant.stop();
  }
});
