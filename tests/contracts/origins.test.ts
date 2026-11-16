import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { reservePort } from "../../scripts/demo/process.ts";
import { startApi } from "../webhooks/system.ts";
import { merchantEntry, ready, post } from "../merchant/support.ts";
import {
  mockEntry,
  workerEntry,
  workerReady,
  rows,
  lookup,
} from "../provider/support.ts";
import { boundOrder } from "../inbox/support.ts";

test("both fresh fixture return origins are reachable and reject the other merchant's origin", async () => {
  await using files = await isolatedDatabases();
  const reservation = await reservePort();
  await reservation.close();
  const origins = {
    a: reservation.origin,
    b: `http://localhost:${reservation.port}`,
  };
  let api = await startApi({
    path: files.paybridge,
    merchantOrigin: origins.a,
  });
  const merchant = startNodeProcess({
    entrypoint: merchantEntry,
    args: [files.merchant, String(reservation.port), api.url, origins.a],
  });
  const mock = startNodeProcess({
    entrypoint: mockEntry,
    args: [files.mockFourcs, "0"],
  });
  let worker: ReturnType<typeof startNodeProcess> | undefined;
  try {
    expect(ready.assert(await merchant.message()).url).toBe(origins.a);
    const mockUrl = ready.assert(await mock.message()).url;
    for (const [owner, other] of [
      ["a", "b"],
      ["b", "a"],
    ] satisfies [keyof typeof origins, keyof typeof origins][]) {
      const rejected = await fetch(`${api.url}/v1/payment-intents`, {
        method: "POST",
        headers: {
          authorization: `Bearer mock-paybridge-key-${owner}`,
          "idempotency-key": `cross-${owner}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          merchantReference: "CROSS",
          amount: 7500,
          currency: "XCD",
          returnUrl: `${origins[other]}/merchant-${other}/payment-return`,
        }),
      });
      expect(rejected.status).toBe(400);
    }
    const bindings = [];
    for (const owner of ["a", "b"] satisfies (keyof typeof origins)[]) {
      const binding = await boundOrder({
        url: origins[owner],
        merchant: owner,
      });
      const checkout = new URL(binding.payment.checkoutUrl);
      const leave = await fetch(
        `${api.url}${checkout.pathname}/leave${checkout.search}`,
        { method: "POST", redirect: "manual" },
      );
      expect(leave.status).toBe(303);
      expect(new URL(leave.headers.get("location") ?? "").origin).toBe(
        origins[owner],
      );
      expect(
        (
          await post({
            url: origins[owner],
            path: `${binding.path}/confirm`,
            body: {
              commandNumber: 1,
              expectedRevision: 1,
              mockPaymentMethodRef: "pm_mock_approved",
            },
          })
        ).status,
      ).toBe(202);
      bindings.push({
        ...binding,
        owner,
        location: leave.headers.get("location") ?? "",
      });
    }
    worker = startNodeProcess({
      entrypoint: workerEntry,
      args: [files.paybridge, mockUrl, "500", "3000", "10"],
    });
    workerReady.assert(await worker.message());
    for (const binding of bindings) {
      await expect
        .poll(
          async () =>
            (
              await lookup({
                url: api.url,
                id: binding.payment.id,
                merchant: binding.owner,
              })
            ).status,
        )
        .toBe("SUCCEEDED");
      expect(await (await fetch(binding.location)).json()).toMatchObject({
        state: "PAID",
        payment: { paymentIntentId: binding.payment.id, status: "SUCCEEDED" },
      });
    }
    const merchants = rows({
      path: files.paybridge,
      sql: "SELECT * FROM merchants ORDER BY id",
    });
    expect(merchants.map((item) => item.return_origin)).toEqual([
      origins.a,
      origins.b,
    ]);
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT effect_count FROM mock_transactions",
      }),
    ).toEqual([{ effect_count: 1 }, { effect_count: 1 }]);
    await api.stop();
    api = await startApi({
      path: files.paybridge,
      merchantOrigin: "http://127.0.0.1:3999",
    });
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT * FROM merchants ORDER BY id",
      }),
    ).toEqual(merchants);
  } finally {
    await worker?.stop();
    await merchant.stop();
    await mock.stop();
    await api.stop();
  }
});
