import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import { launchMerchant, post } from "../merchant/support.ts";
import { advance } from "../webhooks/system.ts";
import {
  boundOrder,
  controlledInbox,
  deliver,
  events,
  merchantRecords,
} from "./support.ts";

for (const completed of [false, true]) {
  test(`a stale inbox token cannot alter its replacement with processed state = ${completed}`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    let a: Awaited<ReturnType<typeof controlledInbox>> | undefined;
    let b: Awaited<ReturnType<typeof controlledInbox>> | undefined;
    try {
      const { payment, path } = await boundOrder(merchant.url);
      await post(merchant.url, `${path}/confirm`, {
        commandNumber: 1,
        expectedRevision: 1,
        mockPaymentMethodRef: "pm_mock_approved",
      });
      await services.startWorker();
      await expect
        .poll(async () => (await lookup(services.url, payment.id)).status)
        .toBe("SUCCEEDED");
      const [event] = events(files.paybridge);
      if (!event) throw new Error("Expected success event");
      expect((await deliver(merchant.url, event.payload)).status).toBe(204);
      a = await controlledInbox(files.merchant, "after-inbox-claim");
      const beforeExpiry = Date.now();
      await advance(a, beforeExpiry);
      await a.start();
      expect(await a.message()).toEqual({
        kind: "after-inbox-claim",
        eventId: event.payment_event_id,
      });
      const old = type({
        lease_expires_at: "string",
        claim_token: "string",
      }).assert(
        rows(
          files.merchant,
          "SELECT lease_expires_at,claim_token FROM webhook_inbox",
        )[0],
      );
      b = await controlledInbox(files.merchant, "after-inbox-claim");
      await advance(b, Date.parse(old.lease_expires_at) + 1);
      await b.start();
      expect(await b.message()).toEqual({
        kind: "after-inbox-claim",
        eventId: event.payment_event_id,
      });
      expect(
        rows(files.merchant, "SELECT claim_token FROM webhook_inbox")[0]
          ?.claim_token,
      ).not.toBe(old.claim_token);
      if (completed) {
        b.child.send({ kind: "release" });
        await expect
          .poll(() => rows(files.merchant, "SELECT status FROM webhook_inbox"))
          .toEqual([{ status: "PROCESSED" }]);
      }
      const replacement = merchantRecords(files.merchant);
      expect(replacement.inbox[0]?.status).toBe(
        completed ? "PROCESSED" : "PROCESSING",
      );
      expect(replacement.orders[0]?.state).toBe(completed ? "PAID" : "UNPAID");
      a.child.send({ kind: "release" });
      expect(await a.message()).toEqual({
        code: "inbox_claim_lost",
        workerId: a.workerId,
        eventId: event.payment_event_id,
      });
      expect(merchantRecords(files.merchant)).toEqual(replacement);
      if (!completed) b.child.send({ kind: "release" });
      await expect
        .poll(() =>
          rows(
            files.merchant,
            "SELECT status,attempt_count FROM webhook_inbox",
          ),
        )
        .toEqual([{ status: "PROCESSED", attempt_count: 2 }]);
      expect(rows(files.merchant, "SELECT state FROM orders")).toEqual([
        { state: "PAID" },
      ]);
    } finally {
      await a?.stop();
      await b?.stop();
      await merchant.stop();
    }
  });
}

test("competing inbox processes claim one execution and retain one paid effect", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  const workers: Awaited<ReturnType<typeof controlledInbox>>[] = [];
  try {
    const { payment, path } = await boundOrder(merchant.url);
    await post(merchant.url, `${path}/confirm`, {
      commandNumber: 1,
      expectedRevision: 1,
      mockPaymentMethodRef: "pm_mock_approved",
    });
    await services.startWorker();
    await expect
      .poll(async () => (await lookup(services.url, payment.id)).status)
      .toBe("SUCCEEDED");
    const [event] = events(files.paybridge);
    if (!event) throw new Error("Expected success event");
    expect((await deliver(merchant.url, event.payload)).status).toBe(204);
    workers.push(
      await controlledInbox(files.merchant),
      await controlledInbox(files.merchant),
    );
    await Promise.all(workers.map((worker) => worker.start()));
    await expect
      .poll(() =>
        rows(files.merchant, "SELECT status,attempt_count FROM webhook_inbox"),
      )
      .toEqual([{ status: "PROCESSED", attempt_count: 1 }]);
    expect(rows(files.merchant, "SELECT state,paid_at FROM orders")).toEqual([
      { state: "PAID", paid_at: expect.any(String) },
    ]);
    expect(
      rows(files.mockFourcs, "SELECT effect_count FROM mock_transactions"),
    ).toEqual([{ effect_count: 1 }]);
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
    await merchant.stop();
  }
});
