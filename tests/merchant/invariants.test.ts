import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, rows } from "../provider/support.ts";
import { launchMerchant, orderBody, orderIdentity, post } from "./support.ts";

test("storage preserves ownership, one binding, immutable commands, and lifetime payment records", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const a = orderIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: orderBody,
        })
      ).json(),
    );
    const b = orderIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: "/merchant-b/orders",
          body: orderBody,
        })
      ).json(),
    );
    expect(
      (
        await post({
          url: merchant.url,
          path: `/merchant-a/orders/${a.id}/payment`,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post({
          url: merchant.url,
          path: `/merchant-b/orders/${b.id}/payment`,
        })
      ).status,
    ).toBe(201);
    const db = new DatabaseSync(files.merchant);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        db.prepare("UPDATE orders SET amount = 1 WHERE id = ?").run(a.id),
      ).toThrow();
      expect(() =>
        db
          .prepare("UPDATE orders SET merchant_id = 'merchant-b' WHERE id = ?")
          .run(a.id),
      ).toThrow();
      expect(() =>
        db.exec(
          "UPDATE merchant_commands SET request_body = '{}' WHERE operation = 'create'",
        ),
      ).toThrow();
      expect(() =>
        db.exec(
          "UPDATE merchant_commands SET response_body = '{}' WHERE status = 'COMPLETED'",
        ),
      ).toThrow();
      expect(() =>
        db.exec(
          "UPDATE merchant_payments SET merchant_id = 'merchant-b' WHERE merchant_id = 'merchant-a'",
        ),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO merchant_commands (id, merchant_id, order_id, operation, command_number, idempotency_key, target, request_body, status, created_at) VALUES ('wrong', 'merchant-b', ?, 'confirm', 1, 'wrong', '/v1/payment-intents/pi_wrong/confirm', '{}', 'PREPARED', 'now')",
          )
          .run(a.id),
      ).toThrow();
      expect(() =>
        db.exec("UPDATE orders SET state = 'PAID' WHERE state = 'UNPAID'"),
      ).toThrow();
      expect(() =>
        db.exec(
          "UPDATE merchant_payments SET last_applied_revision = 1, snapshot = '{}', status = NULL",
        ),
      ).toThrow();
      for (const table of [
        "merchant_payments",
        "merchant_commands",
        "orders",
        "merchant_contexts",
      ])
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow();
    } finally {
      db.close();
    }
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT business_reference, merchant_id FROM orders ORDER BY merchant_id",
      }),
    ).toEqual([
      { business_reference: "ORDER-1", merchant_id: "merchant-a" },
      { business_reference: "ORDER-1", merchant_id: "merchant-b" },
    ]);
  } finally {
    await merchant.stop();
  }
});
