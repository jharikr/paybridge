import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import { launchMerchant, post } from "../merchant/support.ts";
import { boundOrder, controlledInbox, deliver, events } from "./support.ts";

for (const lock of [
  "claim writer",
  "claim commit reader",
  "completion writer",
]) {
  test(`${lock} waits use fresh lease checks before applying a receipt`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    let worker: Awaited<ReturnType<typeof controlledInbox>> | undefined;
    try {
      const { payment, path } = await boundOrder({ url: merchant.url });
      await post({
        url: merchant.url,
        path: `${path}/confirm`,
        body: {
          commandNumber: 1,
          expectedRevision: 1,
          mockPaymentMethodRef: "pm_mock_approved",
        },
      });
      await services.startWorker();
      await expect
        .poll(
          async () =>
            (await lookup({ url: services.url, id: payment.id })).status,
        )
        .toBe("SUCCEEDED");
      const [event] = events(files.paybridge);
      if (!event) throw new Error("Expected success event");
      expect(
        (await deliver({ url: merchant.url, body: event.payload })).status,
      ).toBe(204);
      worker = await controlledInbox({
        path: files.merchant,
        held: lock === "completion writer" ? "after-inbox-claim" : "none",
        options: { lease: 500 },
      });
      if (lock === "completion writer") {
        await worker.start();
        expect(await worker.message()).toMatchObject({
          kind: "after-inbox-claim",
        });
      }
      const blocker = new DatabaseSync(files.merchant);
      try {
        blocker.exec(
          lock === "claim commit reader" ? "BEGIN" : "BEGIN IMMEDIATE",
        );
        blocker.prepare("SELECT event_id FROM webhook_inbox").all();
        if (lock === "completion writer")
          worker.child.send({ kind: "release" });
        else await worker.start();
        await delay(800);
        blocker.exec("COMMIT");
      } finally {
        blocker.close();
      }
      await expect
        .poll(
          () =>
            rows({
              path: files.merchant,
              sql: "SELECT status,attempt_count FROM webhook_inbox",
            }),
          { timeout: 3000 },
        )
        .toEqual([
          {
            status: "PROCESSED",
            attempt_count: lock === "claim writer" ? 1 : 2,
          },
        ]);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT status,last_applied_revision FROM merchant_payments",
        }),
      ).toEqual([{ status: "SUCCEEDED", last_applied_revision: 3 }]);
      expect(
        rows({ path: files.merchant, sql: "SELECT state,paid_at FROM orders" }),
      ).toEqual([{ state: "PAID", paid_at: expect.any(String) }]);
      expect(
        rows({
          path: files.mockFourcs,
          sql: "SELECT effect_count FROM mock_transactions",
        }),
      ).toEqual([{ effect_count: 1 }]);
    } finally {
      await worker?.stop();
      await merchant.stop();
    }
  });
}
