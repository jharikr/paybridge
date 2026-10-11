import { controlledMerchant, controlledPaybridge } from "./support.ts";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { contractAt, compareResponse } from "../contracts/support.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
} from "../merchant/support.ts";

test("merchant return applies authoritative revisions and marks its bound order paid once", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
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
    const payment = paymentIdentity.assert(
      await (await post({ url: merchant.url, path: `${path}/payment` })).json(),
    );
    const returnUrl = `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`;
    const pending = await fetch(returnUrl);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      orderId: order.id,
      state: "UNPAID",
      paidAt: null,
      payment: {
        paymentIntentId: payment.id,
        merchantReference: "ORDER-1",
        amount: 7500,
        currency: "XCD",
        status: "PENDING",
        revision: 1,
      },
    });
    expect(
      (
        await post({
          url: merchant.url,
          path: `${path}/confirm`,
          body: {
            commandNumber: 1,
            mockPaymentMethodRef: "pm_mock_approved",
            expectedRevision: 1,
          },
        })
      ).status,
    ).toBe(202);
    expect(await (await fetch(returnUrl)).json()).toMatchObject({
      state: "UNPAID",
      payment: { status: "PROCESSING", revision: 2 },
    });
    await services.startWorker();
    await expect
      .poll(async () => (await (await fetch(returnUrl)).json()).state)
      .toBe("PAID");
    const settled = await (await fetch(returnUrl)).json();
    expect(settled).toMatchObject({
      state: "PAID",
      paidAt: expect.any(String),
      payment: { status: "SUCCEEDED", revision: 3 },
    });
    await services.server.stop();
    const repeats = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(returnUrl).then((response) => response.json()),
      ),
    );
    expect(
      repeats.every(
        (result) => JSON.stringify(result) === JSON.stringify(settled),
      ),
    ).toBe(true);
    expect(
      rows({ path: files.merchant, sql: "SELECT state, paid_at FROM orders" }),
    ).toEqual([{ state: "PAID", paid_at: settled.paidAt }]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT last_applied_revision, status FROM merchant_payments",
      }),
    ).toEqual([{ last_applied_revision: 3, status: "SUCCEEDED" }]);
    await merchant.stop();
    const restarted = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    try {
      expect(
        await (
          await fetch(
            `${restarted.url}/merchant-a/payment-return?paymentId=${payment.id}`,
          )
        ).json(),
      ).toEqual(settled);
      expect(
        (
          await fetch(
            `${restarted.url}/merchant-b/payment-return?paymentId=${payment.id}`,
          )
        ).status,
      ).toBe(404);
    } finally {
      await restarted.stop();
    }
  } finally {
    await merchant.stop();
  }
});

test("FAILED stays refreshable and a delayed older lookup cannot undo PROCESSING or a paid result", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const provider = await controlledPaybridge({
    path: files.paybridge,
    fault: "lookup",
  });
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: provider.url,
  });
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
    const payment = paymentIdentity.assert(
      await (await post({ url: merchant.url, path: `${path}/payment` })).json(),
    );
    await post({
      url: merchant.url,
      path: `${path}/confirm`,
      body: {
        commandNumber: 1,
        mockPaymentMethodRef: "pm_mock_declined",
        expectedRevision: 1,
      },
    });
    const worker = await services.startWorker();
    await expect
      .poll(
        async () =>
          (await lookup({ url: services.url, id: payment.id })).status,
      )
      .toBe("FAILED");
    const returnUrl = `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`;
    expect(await (await fetch(returnUrl)).json()).toMatchObject({
      state: "UNPAID",
      payment: { status: "FAILED", revision: 3 },
    });
    await worker.stop();
    provider.child.send({ kind: "hold-lookup" });
    expect(await provider.message()).toEqual({ kind: "holding" });
    const old = fetch(returnUrl);
    expect(await provider.message()).toEqual({ kind: "lookup-held" });
    expect(
      (
        await post({
          url: merchant.url,
          path: `${path}/confirm`,
          body: {
            commandNumber: 2,
            mockPaymentMethodRef: "pm_mock_approved",
            expectedRevision: 3,
          },
        })
      ).status,
    ).toBe(202);
    expect(await (await fetch(returnUrl)).json()).toMatchObject({
      state: "UNPAID",
      payment: { status: "PROCESSING", revision: 4 },
    });
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await lookup({ url: services.url, id: payment.id })).status,
      )
      .toBe("SUCCEEDED");
    const paid = await (await fetch(returnUrl)).json();
    expect(paid).toMatchObject({
      state: "PAID",
      payment: { status: "SUCCEEDED", revision: 5 },
    });
    provider.child.send({ kind: "release" });
    const delayed = await old;
    expect(delayed.status).toBe(200);
    expect(await delayed.json()).toEqual(paid);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT last_applied_revision, status FROM merchant_payments",
      }),
    ).toEqual([{ last_applied_revision: 5, status: "SUCCEEDED" }]);
  } finally {
    await Promise.all([merchant.stop(), provider.stop()]);
  }
});

const faults: ("rollback" | "before-commit")[] = ["rollback", "before-commit"];
for (const fault of faults) {
  test(`snapshot ${fault} preserves both local view and unpaid order, then parallel processes apply a revision gap once`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const merchant = await controlledMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
      fault,
    });
    let payment: typeof paymentIdentity.infer;
    let order: typeof orderIdentity.infer;
    try {
      order = orderIdentity.assert(
        await (
          await post({
            url: merchant.url,
            path: "/merchant-a/orders",
            body: orderBody,
          })
        ).json(),
      );
      const path = `/merchant-a/orders/${order.id}`;
      payment = paymentIdentity.assert(
        await (
          await post({ url: merchant.url, path: `${path}/payment` })
        ).json(),
      );
      await post({
        url: merchant.url,
        path: `${path}/confirm`,
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
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT state, paid_at FROM orders",
        }),
      ).toEqual([{ state: "UNPAID", paid_at: null }]);
      const result = fetch(
        `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`,
      ).then(
        async (response) => {
          if (fault === "rollback")
            await compareResponse({
              contract: await contractAt(merchant.url),
              path: "/{merchantFixture}/payment-return",
              method: "get",
              response,
              status: 500,
            });
          return response.status;
        },
        () => "lost",
      );
      if (fault === "before-commit") {
        expect(await merchant.message()).toEqual({ kind: "before-commit" });
        await merchant.stop();
        expect(await result).toBe("lost");
      } else expect(await result).toBe(500);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT state, paid_at FROM orders",
        }),
      ).toEqual([{ state: "UNPAID", paid_at: null }]);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT last_applied_revision, status, snapshot FROM merchant_payments",
        }),
      ).toEqual([{ last_applied_revision: 0, status: null, snapshot: null }]);
    } finally {
      await merchant.stop();
    }
    const first = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    const second = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          fetch(
            `${index % 2 ? first.url : second.url}${index % 3 ? `/merchant-a/payment-return?paymentId=${payment.id}` : `/merchant-a/orders/${order.id}/payment`}`,
          ),
        ),
      );
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT last_applied_revision, status FROM merchant_payments",
        }),
      ).toEqual([{ last_applied_revision: 3, status: "SUCCEEDED" }]);
      const paid = rows({
        path: files.merchant,
        sql: "SELECT state, paid_at FROM orders",
      });
      expect(paid).toEqual([{ state: "PAID", paid_at: expect.any(String) }]);
      await first.stop();
      expect(
        (
          await fetch(
            `${second.url}/merchant-a/payment-return?paymentId=${payment.id}`,
          )
        ).status,
      ).toBe(200);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT state, paid_at FROM orders",
        }),
      ).toEqual(paid);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });
}

for (const status of ["CANCELLED", "UNKNOWN"]) {
  test(`return preserves the unpaid binding when lookup reports ${status}`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
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
      const payment = paymentIdentity.assert(
        await (
          await post({ url: merchant.url, path: `${path}/payment` })
        ).json(),
      );
      if (status === "CANCELLED")
        expect(
          (
            await fetch(
              `${services.url}/v1/payment-intents/${payment.id}/cancel`,
              {
                method: "POST",
                headers: { authorization: "Bearer mock-paybridge-key-a" },
              },
            )
          ).status,
        ).toBe(200);
      else {
        await post({
          url: merchant.url,
          path: `${path}/confirm`,
          body: {
            commandNumber: 1,
            mockPaymentMethodRef: "pm_mock_lost_response",
            expectedRevision: 1,
          },
        });
        await services.startWorker();
        await expect
          .poll(
            async () =>
              (await lookup({ url: services.url, id: payment.id })).status,
          )
          .toBe("UNKNOWN");
      }
      const returnUrl = `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`;
      expect(await (await fetch(returnUrl)).json()).toMatchObject({
        state: "UNPAID",
        paidAt: null,
        payment: { status },
      });
      expect(
        paymentIdentity.assert(
          await (
            await post({ url: merchant.url, path: `${path}/payment` })
          ).json(),
        ).id,
      ).toBe(payment.id);
      await services.server.stop();
      expect((await fetch(returnUrl)).status).toBe(
        status === "CANCELLED" ? 200 : 503,
      );
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT state, paid_at FROM orders",
        }),
      ).toEqual([{ state: "UNPAID", paid_at: null }]);
    } finally {
      await merchant.stop();
    }
  });
}
