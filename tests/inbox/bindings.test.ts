import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, journey, lookup, rows } from "../provider/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  post,
} from "../merchant/support.ts";
import { deliver, events, startInbox } from "./support.ts";

test("an early receipt retries with a retained diagnostic and pays its order after interrupted binding recovery", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  let merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
    fault: "received",
  });
  let worker: Awaited<ReturnType<typeof startInbox>> | undefined;
  try {
    const order = orderIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: orderBody,
        })
      ).json(),
    );
    const path = `/merchant-a/orders/${order.id}`;
    const lost = post({ url: merchant.url, path: `${path}/payment` }).then(
      () => "response",
      () => "lost",
    );
    expect(await merchant.message()).toMatchObject({ kind: "received" });
    const { id } = type({ id: "string" }).assert(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_intents" })[0],
    );
    expect((await confirm({ url: services.url, id })).status).toBe(202);
    await services.startWorker();
    await expect
      .poll(async () => (await lookup({ url: services.url, id })).status)
      .toBe("SUCCEEDED");
    const [event] = events(files.paybridge);
    if (!event) throw new Error("Expected success event");
    expect(
      (await deliver({ url: merchant.url, body: event.payload })).status,
    ).toBe(204);
    worker = await startInbox(files.merchant);
    await expect
      .poll(
        () =>
          rows({
            path: files.merchant,
            sql: "SELECT status,last_error FROM webhook_inbox",
          }),
        { timeout: 1000 },
      )
      .toEqual([{ status: "PENDING", last_error: "inbox_binding_unmatched" }]);
    expect(
      rows({ path: files.merchant, sql: "SELECT state,paid_at FROM orders" }),
    ).toEqual([{ state: "UNPAID", paid_at: null }]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT payment_intent_id FROM merchant_payments",
      }),
    ).toEqual([]);
    await merchant.stop();
    expect(await lost).toBe("lost");
    merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    expect(
      (await post({ url: merchant.url, path: `${path}/payment` })).status,
    ).toBe(201);
    await expect
      .poll(() =>
        rows({
          path: files.merchant,
          sql: "SELECT status,last_error,claim_token,processed_at FROM webhook_inbox",
        }),
      )
      .toEqual([
        {
          status: "PROCESSED",
          last_error: "inbox_binding_unmatched",
          claim_token: null,
          processed_at: expect.any(String),
        },
      ]);
    expect(await (await fetch(`${merchant.url}${path}`)).json()).toMatchObject({
      state: "PAID",
      paymentIntentId: id,
    });
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT event_id,payload,receiving_merchant_id FROM webhook_inbox",
      }),
    ).toEqual([
      {
        event_id: event.payment_event_id,
        payload: event.payload,
        receiving_merchant_id: "merchant-a",
      },
    ]);
    expect(worker.output()).toContain("inbox_binding_unmatched");
    expect(worker.output()).not.toMatch(
      /mock-webhook-secret|mock-paybridge-key|token=|<.*Envelope/,
    );
  } finally {
    await worker?.stop();
    await merchant.stop();
  }
});
