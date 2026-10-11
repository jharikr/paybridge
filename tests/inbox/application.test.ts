import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import { launchMerchant, post } from "../merchant/support.ts";
import {
  boundOrder,
  deliver,
  events,
  merchantRecords,
  startInbox,
} from "./support.ts";

test("a durably received success pays only its bound order once, survives restart, and accepts duplicate delivery", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  let worker: Awaited<ReturnType<typeof startInbox>> | undefined;
  try {
    const { payment, path } = await boundOrder(merchant.url);
    await boundOrder(merchant.url, "b");
    expect(
      (
        await post(merchant.url, `${path}/confirm`, {
          commandNumber: 1,
          expectedRevision: 1,
          mockPaymentMethodRef: "pm_mock_approved",
        })
      ).status,
    ).toBe(202);
    await services.startWorker();
    await expect
      .poll(async () => (await lookup(services.url, payment.id)).status)
      .toBe("SUCCEEDED");
    const [event] = events(files.paybridge);
    if (!event) throw new Error("Expected committed success event");
    expect((await deliver(merchant.url, event.payload)).status).toBe(204);
    expect(rows(files.merchant, "SELECT state FROM orders")).toEqual([
      { state: "UNPAID" },
      { state: "UNPAID" },
    ]);
    worker = await startInbox(files.merchant);
    await expect
      .poll(() => rows(files.merchant, "SELECT status FROM webhook_inbox"))
      .toEqual([{ status: "PROCESSED" }]);
    expect(await (await fetch(`${merchant.url}${path}`)).json()).toMatchObject({
      state: "PAID",
      paidAt: expect.any(String),
    });
    expect(
      rows(
        files.merchant,
        "SELECT merchant_id,state FROM orders ORDER BY merchant_id",
      ),
    ).toEqual([
      { merchant_id: "merchant-a", state: "PAID" },
      { merchant_id: "merchant-b", state: "UNPAID" },
    ]);
    expect(
      rows(
        files.merchant,
        "SELECT last_applied_revision,status FROM merchant_payments WHERE merchant_id='merchant-a'",
      ),
    ).toEqual([{ last_applied_revision: 3, status: "SUCCEEDED" }]);
    const completed = merchantRecords(files.merchant);
    await worker.stop();
    expect((await deliver(merchant.url, event.payload)).status).toBe(204);
    worker = await startInbox(files.merchant);
    expect(
      await (
        await fetch(
          `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`,
        )
      ).json(),
    ).toMatchObject({ state: "PAID", payment: { revision: 3 } });
    expect(merchantRecords(files.merchant)).toEqual(completed);
    expect(
      rows(files.mockFourcs, "SELECT effect_count FROM mock_transactions"),
    ).toEqual([{ effect_count: 1 }]);
  } finally {
    await worker?.stop();
    await merchant.stop();
  }
});

test("a first receipt at the revision already applied by lookup is processed without another local effect", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  let worker: Awaited<ReturnType<typeof startInbox>> | undefined;
  try {
    const { payment, path } = await boundOrder(merchant.url);
    expect(
      (
        await post(merchant.url, `${path}/confirm`, {
          commandNumber: 1,
          expectedRevision: 1,
          mockPaymentMethodRef: "pm_mock_approved",
        })
      ).status,
    ).toBe(202);
    await services.startWorker();
    await expect
      .poll(async () => (await lookup(services.url, payment.id)).status)
      .toBe("SUCCEEDED");
    expect(
      await (await fetch(`${merchant.url}${path}/payment`)).json(),
    ).toMatchObject({ status: "SUCCEEDED", revision: 3 });
    const accepted = merchantRecords(files.merchant);
    expect(accepted.orders).toMatchObject([
      { state: "PAID", paid_at: expect.any(String) },
    ]);
    const [event] = events(files.paybridge);
    if (!event) throw new Error("Expected success event");
    expect((await deliver(merchant.url, event.payload)).status).toBe(204);
    worker = await startInbox(files.merchant);
    await expect
      .poll(() =>
        rows(files.merchant, "SELECT status,attempt_count FROM webhook_inbox"),
      )
      .toEqual([{ status: "PROCESSED", attempt_count: 1 }]);
    expect(merchantRecords(files.merchant).orders).toEqual(accepted.orders);
    expect(merchantRecords(files.merchant).payments).toEqual(accepted.payments);
    expect(
      rows(files.mockFourcs, "SELECT effect_count FROM mock_transactions"),
    ).toEqual([{ effect_count: 1 }]);
  } finally {
    await worker?.stop();
    await merchant.stop();
  }
});
