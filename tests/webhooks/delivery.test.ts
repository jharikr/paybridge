import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { launchMerchant } from "../merchant/support.ts";
import { rows } from "../provider/support.ts";
import { ready } from "./support.ts";

test("the real worker delivers each merchant's committed cancellation bytes without a financial attempt", async () => {
  await using files = await isolatedDatabases();
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  const api = startNodeProcess({
    entrypoint: fileURLToPath(new URL("./fixtures/api.ts", import.meta.url)),
    args: [files.paybridge, merchant.url],
  });
  let worker: ReturnType<typeof startNodeProcess> | undefined;
  try {
    const { url } = ready.assert(await api.message());
    for (const letter of ["a", "b"]) {
      const response = await fetch(`${url}/v1/payment-intents`, {
        method: "POST",
        headers: {
          authorization: `Bearer mock-paybridge-key-${letter}`,
          "content-type": "application/json",
          "idempotency-key": "create",
        },
        body: JSON.stringify({
          merchantReference: "Webhook café 😀",
          amount: 7500,
          currency: "XCD",
          returnUrl: `${letter === "b" ? merchant.url.replace("127.0.0.1", "localhost") : merchant.url}/merchant-${letter}/payment-return`,
        }),
      });
      expect(response.status).toBe(201);
      const { id } = type({ id: "string" }).assert(await response.json());
      expect(
        (
          await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
            method: "POST",
            headers: { authorization: `Bearer mock-paybridge-key-${letter}` },
          })
        ).status,
      ).toBe(200);
    }
    const before = rows({
      path: files.paybridge,
      sql: "SELECT id,status,revision FROM payment_intents ORDER BY id",
    });
    const events = rows({
      path: files.paybridge,
      sql: "SELECT id,payment_intent_id,intent_revision,metadata FROM payment_events ORDER BY id",
    });
    worker = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL("../../apps/paybridge/worker.ts", import.meta.url),
      ),
      args: [
        files.paybridge,
        "http://127.0.0.1:3102",
        "500",
        "2000",
        "10",
        "50",
        "200",
      ],
    });
    await worker.message();
    await expect
      .poll(
        () =>
          rows({
            path: files.paybridge,
            sql: "SELECT status FROM webhook_outbox ORDER BY id",
          }),
        { timeout: 3000 },
      )
      .toEqual([{ status: "DELIVERED" }, { status: "DELIVERED" }]);
    const outbox = rows({
      path: files.paybridge,
      sql: "SELECT payment_event_id,merchant_id,payload FROM webhook_outbox ORDER BY merchant_id",
    });
    for (const record of outbox) {
      const event = type({
        payment_event_id: "string",
        merchant_id: "string",
        payload: "string",
      }).assert(record);
      expect(
        rows({
          path: files.merchant,
          sql: `SELECT event_id,receiving_merchant_id,payload,payload_hash,status FROM webhook_inbox WHERE receiving_merchant_id='${event.merchant_id}'`,
        }),
      ).toEqual([
        {
          event_id: event.payment_event_id,
          receiving_merchant_id: event.merchant_id,
          payload: event.payload,
          payload_hash: createHash("sha256")
            .update(event.payload)
            .digest("hex"),
          status: "PENDING",
        },
      ]);
    }
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT id,status,revision FROM payment_intents ORDER BY id",
      }),
    ).toEqual(before);
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT id,payment_intent_id,intent_revision,metadata FROM payment_events ORDER BY id",
      }),
    ).toEqual(events);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
    ).toEqual([]);
    expect(
      rows({ path: files.merchant, sql: "SELECT id FROM orders" }),
    ).toEqual([]);
  } finally {
    await worker?.stop();
    await api.stop();
    await merchant.stop();
  }
});
