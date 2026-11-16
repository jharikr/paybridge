import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { webhookEvent } from "../../contracts/webhooks.ts";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import { launchMerchant, post } from "../merchant/support.ts";
import { boundOrder, deliver, events, startInbox } from "./support.ts";

test("authenticated receiving context and conflicting business facts stay pending without paying another merchant's order", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  let worker: Awaited<ReturnType<typeof startInbox>> | undefined;
  try {
    const a = await boundOrder({ url: merchant.url });
    const b = await boundOrder({ url: merchant.url, merchant: "b" });
    for (const order of [a, b])
      expect(
        (
          await post({
            url: merchant.url,
            path: `${order.path}/confirm`,
            body: {
              commandNumber: 1,
              expectedRevision: 1,
              mockPaymentMethodRef: "pm_mock_approved",
            },
          })
        ).status,
      ).toBe(202);
    await services.startWorker();
    for (const [order, owner] of [
      [a, "a"],
      [b, "b"],
    ] satisfies [typeof a, string][])
      await expect
        .poll(
          async () =>
            (
              await lookup({
                url: services.url,
                id: order.payment.id,
                merchant: owner,
              })
            ).status,
        )
        .toBe("SUCCEEDED");
    const notifications = events(files.paybridge);
    const eventA = notifications.find(
      (event) => event.merchant_id === "merchant-a",
    );
    const eventB = notifications.find(
      (event) => event.merchant_id === "merchant-b",
    );
    if (!eventA || !eventB) throw new Error("Expected both financial events");
    expect(
      (
        await deliver({
          url: merchant.url,
          body: eventA.payload,
          merchant: "b",
        })
      ).status,
    ).toBe(204);
    const parsed = webhookEvent.assert(JSON.parse(eventA.payload));
    for (const change of [{ amount: 7501 }, { merchantReference: "OTHER" }]) {
      const payload = JSON.stringify({
        ...parsed,
        id: `evt_${randomBytes(16).toString("hex")}`,
        data: { ...parsed.data, ...change },
      });
      expect((await deliver({ url: merchant.url, body: payload })).status).toBe(
        204,
      );
    }
    expect(
      (
        await deliver({
          url: merchant.url,
          body: eventB.payload,
          merchant: "b",
        })
      ).status,
    ).toBe(204);
    worker = await startInbox(files.merchant);
    await expect
      .poll(() =>
        rows({
          path: files.merchant,
          sql: "SELECT status,last_error FROM webhook_inbox ORDER BY last_error",
        }),
      )
      .toEqual([
        { status: "PROCESSED", last_error: null },
        { status: "PENDING", last_error: "inbox_binding_conflict" },
        { status: "PENDING", last_error: "inbox_binding_conflict" },
        { status: "PENDING", last_error: "inbox_binding_unmatched" },
      ]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT merchant_id,state FROM orders ORDER BY merchant_id",
      }),
    ).toEqual([
      { merchant_id: "merchant-a", state: "UNPAID" },
      { merchant_id: "merchant-b", state: "PAID" },
    ]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT merchant_id,status,last_applied_revision FROM merchant_payments ORDER BY merchant_id",
      }),
    ).toEqual([
      { merchant_id: "merchant-a", status: null, last_applied_revision: 0 },
      {
        merchant_id: "merchant-b",
        status: "SUCCEEDED",
        last_applied_revision: 3,
      },
    ]);
    expect(
      rows({
        path: files.merchant,
        sql: `SELECT receiving_merchant_id,payload FROM webhook_inbox WHERE event_id='${eventA.payment_event_id}'`,
      }),
    ).toEqual([
      { receiving_merchant_id: "merchant-b", payload: eventA.payload },
    ]);
    expect(worker.output()).toContain("inbox_binding_conflict");
    expect(worker.output()).not.toContain("OTHER");
  } finally {
    await worker?.stop();
    await merchant.stop();
  }
});
