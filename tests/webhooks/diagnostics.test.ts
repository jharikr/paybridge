import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { launchMerchant } from "../merchant/support.ts";
import { startApi, cancelled, startDelivery } from "./system.ts";

test("webhook completion failures retain safe causes while receipt and financial facts survive the rollback", async () => {
  await using files = await isolatedDatabases();
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  const api = await startApi({
    path: files.paybridge,
    merchantOrigin: merchant.url,
  });
  let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
  try {
    await cancelled({ url: api.url, merchantOrigin: merchant.url });
    const financial = rows({
      path: files.paybridge,
      sql: "SELECT * FROM payment_events",
    });
    worker = await startDelivery({
      path: files.paybridge,
      options: { held: "rollback" },
    });
    await worker.start();
    const diagnostic = await worker.message();
    expect(diagnostic).toMatchObject({
      failure: {
        operation: "webhook_completion",
        causes: ["type_error", "SQLITE_BUSY", "reference_error"],
      },
    });
    expect(JSON.stringify(diagnostic) + worker.output()).not.toMatch(
      /sensitive|<SOAP>|credential=|token=/,
    );
    expect(
      rows({ path: files.paybridge, sql: "SELECT status FROM webhook_outbox" }),
    ).toEqual([{ status: "PROCESSING" }]);
    expect(
      rows({ path: files.merchant, sql: "SELECT status FROM webhook_inbox" }),
    ).toEqual([{ status: "PENDING" }]);
    expect(
      rows({ path: files.paybridge, sql: "SELECT * FROM payment_events" }),
    ).toEqual(financial);
  } finally {
    await worker?.stop();
    await api.stop();
    await merchant.stop();
  }
});
