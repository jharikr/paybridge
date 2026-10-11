import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
} from "../merchant/support.ts";
import { merchantPaymentSnapshot } from "../../contracts/merchant.ts";

test("the shared snapshot transaction checks the receiving owner and immutable business binding before any revision or paid effect", async () => {
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
    const payment = paymentIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: `/merchant-a/orders/${a.id}/payment`,
        })
      ).json(),
    );
    await post({
      url: merchant.url,
      path: `/merchant-b/orders/${b.id}/payment`,
    });
    await post({
      url: merchant.url,
      path: `/merchant-a/orders/${a.id}/confirm`,
      body: {
        commandNumber: 1,
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
      },
    });
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await lookup({ url: services.url, id: payment.id })).status,
      )
      .toBe("SUCCEEDED");
    const current = await lookup({ url: services.url, id: payment.id });
    const snapshot = merchantPaymentSnapshot.assert({
      paymentIntentId: current.id,
      merchantReference: current.merchantReference,
      amount: current.amount,
      currency: current.currency,
      status: current.status,
      revision: current.revision,
    });
    const before = {
      orders: rows({
        path: files.merchant,
        sql: "SELECT * FROM orders ORDER BY id",
      }),
      payments: rows({
        path: files.merchant,
        sql: "SELECT * FROM merchant_payments ORDER BY payment_intent_id",
      }),
    };
    const consumer = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL("./fixtures/snapshot-consumer.ts", import.meta.url),
      ),
      args: [files.merchant],
    });
    try {
      expect(await consumer.message()).toEqual({ kind: "ready" });
      for (const scenario of [
        { receivingMerchantId: "merchant-b", snapshot, kind: "unmatched" },
        {
          receivingMerchantId: "merchant-a",
          snapshot: {
            ...snapshot,
            paymentIntentId: "pi_00000000000000000000000000000000",
          },
          kind: "unmatched",
        },
        {
          receivingMerchantId: "merchant-a",
          snapshot: { ...snapshot, amount: 7501 },
          kind: "conflict",
        },
        {
          receivingMerchantId: "merchant-a",
          snapshot: { ...snapshot, merchantReference: "OTHER" },
          kind: "conflict",
        },
        {
          receivingMerchantId: "merchant-a",
          snapshot: { ...snapshot, currency: "USD" },
          kind: "invalid",
        },
        {
          receivingMerchantId: "merchant-a",
          snapshot: { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
          kind: "invalid",
        },
      ]) {
        consumer.child.send({
          receivingMerchantId: scenario.receivingMerchantId,
          snapshot: scenario.snapshot,
        });
        expect(await consumer.message()).toEqual({ kind: scenario.kind });
        expect({
          orders: rows({
            path: files.merchant,
            sql: "SELECT * FROM orders ORDER BY id",
          }),
          payments: rows({
            path: files.merchant,
            sql: "SELECT * FROM merchant_payments ORDER BY payment_intent_id",
          }),
        }).toEqual(before);
      }
      consumer.child.send({ receivingMerchantId: "merchant-a", snapshot });
      expect(await consumer.message()).toMatchObject({
        kind: "applied",
        result: { state: "PAID", payment: { revision: 3 } },
      });
      const after = rows({
        path: files.merchant,
        sql: "SELECT merchant_id, state, paid_at FROM orders ORDER BY merchant_id",
      });
      expect(after).toEqual([
        {
          merchant_id: "merchant-a",
          state: "PAID",
          paid_at: expect.any(String),
        },
        { merchant_id: "merchant-b", state: "UNPAID", paid_at: null },
      ]);
      consumer.child.send({
        receivingMerchantId: "merchant-a",
        snapshot: { ...snapshot, amount: 7501 },
      });
      expect(await consumer.message()).toEqual({ kind: "conflict" });
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT merchant_id, state, paid_at FROM orders ORDER BY merchant_id",
        }),
      ).toEqual(after);
    } finally {
      await consumer.stop();
    }
  } finally {
    await merchant.stop();
  }
});
