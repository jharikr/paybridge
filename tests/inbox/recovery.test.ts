import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import { launchMerchant, post } from "../merchant/support.ts";
import {
  boundOrder,
  controlledInbox,
  deliver,
  events,
  merchantRecords,
  startInbox,
} from "./support.ts";

test("inbox transaction failure rolls back the snapshot and paid effect, then reschedules the same receipt", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  let worker: Awaited<ReturnType<typeof controlledInbox>> | undefined;
  let recovered: Awaited<ReturnType<typeof startInbox>> | undefined;
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
    if (!event) throw new Error("Expected financial event");
    expect(
      (await deliver({ url: merchant.url, body: event.payload })).status,
    ).toBe(204);
    const before = merchantRecords(files.merchant);
    worker = await controlledInbox({ path: files.merchant, held: "rollback" });
    await worker.start();
    await expect
      .poll(() =>
        rows({
          path: files.merchant,
          sql: "SELECT status,last_error FROM webhook_inbox",
        }),
      )
      .toEqual([{ status: "PENDING", last_error: "inbox_application_failed" }]);
    const diagnostic = await worker.message();
    expect(diagnostic).toMatchObject({
      failure: {
        operation: "inbox_application",
        causes: ["type_error", "SQLITE_BUSY", "reference_error"],
      },
    });
    expect(JSON.stringify(diagnostic) + worker.output()).not.toMatch(
      /sensitive|<SOAP>|credential=|token=/,
    );
    const failed = merchantRecords(files.merchant);
    expect(failed.orders).toEqual(before.orders);
    expect(failed.payments).toEqual(before.payments);
    expect(failed.inbox).toHaveLength(1);
    await worker.stop();
    recovered = await startInbox(files.merchant);
    await expect
      .poll(() =>
        rows({ path: files.merchant, sql: "SELECT status FROM webhook_inbox" }),
      )
      .toEqual([{ status: "PROCESSED" }]);
    expect(
      rows({ path: files.merchant, sql: "SELECT state FROM orders" }),
    ).toEqual([{ state: "PAID" }]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT payload,last_error FROM webhook_inbox",
      }),
    ).toEqual([
      { payload: event.payload, last_error: "inbox_application_failed" },
    ]);
  } finally {
    await worker?.stop();
    await recovered?.stop();
    await merchant.stop();
  }
});

for (const held of [
  "after-inbox-claim",
  "before-inbox-completion-commit",
  "after-inbox-completion",
]) {
  test(`SIGKILL at ${held} preserves receipt identity and recovers one complete merchant effect`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    let worker: Awaited<ReturnType<typeof controlledInbox>> | undefined;
    let restarted: Awaited<ReturnType<typeof startInbox>> | undefined;
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
      if (!event) throw new Error("Expected financial event");
      expect(
        (await deliver({ url: merchant.url, body: event.payload })).status,
      ).toBe(204);
      const before = merchantRecords(files.merchant);
      worker = await controlledInbox({ path: files.merchant, held });
      await worker.start();
      expect(await worker.message()).toEqual({
        kind: held,
        eventId: event.payment_event_id,
      });
      await worker.stop();
      const killed = merchantRecords(files.merchant);
      if (held === "after-inbox-completion") {
        expect(killed.inbox[0]?.status).toBe("PROCESSED");
        expect(killed.orders[0]?.state).toBe("PAID");
      } else {
        expect(killed.orders).toEqual(before.orders);
        expect(killed.payments).toEqual(before.payments);
        expect(killed.inbox[0]?.status).toBe("PROCESSING");
      }
      restarted = await startInbox(files.merchant);
      await expect
        .poll(
          () =>
            rows({
              path: files.merchant,
              sql: "SELECT status FROM webhook_inbox",
            }),
          {
            timeout: 3000,
          },
        )
        .toEqual([{ status: "PROCESSED" }]);
      const recovered = merchantRecords(files.merchant);
      expect(recovered.inbox).toMatchObject([
        {
          event_id: event.payment_event_id,
          payload: event.payload,
          attempt_count: held === "after-inbox-completion" ? 1 : 2,
          claim_token: null,
          locked_by: null,
          lease_expires_at: null,
        },
      ]);
      expect(recovered.orders).toMatchObject([
        { state: "PAID", paid_at: expect.any(String) },
      ]);
      expect(recovered.payments).toMatchObject([
        { status: "SUCCEEDED", last_applied_revision: 3 },
      ]);
      if (held === "after-inbox-completion") expect(recovered).toEqual(killed);
      expect(
        (await deliver({ url: merchant.url, body: event.payload })).status,
      ).toBe(204);
      expect(
        await (
          await fetch(
            `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`,
          )
        ).json(),
      ).toMatchObject({ state: "PAID" });
      expect(merchantRecords(files.merchant)).toEqual(recovered);
      expect(
        rows({
          path: files.mockFourcs,
          sql: "SELECT effect_count FROM mock_transactions",
        }),
      ).toEqual([{ effect_count: 1 }]);
    } finally {
      await worker?.stop();
      await restarted?.stop();
      await merchant.stop();
    }
  });
}
