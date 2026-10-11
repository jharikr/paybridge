import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, rows } from "../provider/support.ts";
import {
  commandList,
  launchMerchant,
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
} from "./support.ts";

test("fixture ownership and strict requests prevent substituted order, payment, and command identities", async () => {
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
    const aPath = `/merchant-a/orders/${a.id}`;
    const bPath = `/merchant-b/orders/${b.id}`;
    const createdA = await post({
      url: merchant.url,
      path: `${aPath}/payment`,
    });
    const aId = paymentIdentity.assert(await createdA.json()).id;
    const createdB = await post({
      url: merchant.url,
      path: `${bPath}/payment`,
    });
    const bId = paymentIdentity.assert(await createdB.json()).id;
    expect(aId).not.toBe(bId);
    const commands = commandList.assert(
      await (await fetch(`${merchant.url}${aPath}/commands`)).json(),
    );
    const aCommand = commands.commands[0]?.id;
    expect(aCommand).toEqual(expect.any(String));
    const confirm = {
      commandNumber: 1,
      expectedRevision: 1,
      mockPaymentMethodRef: "pm_mock_approved",
    };
    for (const suffix of ["", "/payment", "/commands"])
      expect(
        (await fetch(`${merchant.url}/merchant-b/orders/${a.id}${suffix}`))
          .status,
      ).toBe(404);
    expect(
      (
        await post({
          url: merchant.url,
          path: `/merchant-b/orders/${a.id}/confirm`,
          body: confirm,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${bPath}/commands/${aCommand}/recover`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${aPath}/commands/${createdB.headers.get("x-merchant-command-id")}/recover`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${aPath}/confirm`,
          body: {
            ...confirm,
            paymentIntentId: bId,
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${aPath}/confirm`,
          body: {
            ...confirm,
            merchantId: "merchant-b",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${aPath}/confirm`,
          body: {
            ...confirm,
            cardNumber: "9900000000000001",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ url: merchant.url, path: `${aPath}/payment`, body: {} }))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${merchant.url}${aPath}/payment?paymentId=${bId}`)).status,
    ).toBe(400);
    expect(
      (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: {
            ...orderBody,
            amount: 1,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: {
            ...orderBody,
            apiKey: "mock-paybridge-key-b",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
    ).toEqual([]);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${bPath}/confirm`,
          body: confirm,
        })
      ).status,
    ).toBe(202);
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${merchant.url}${bPath}/payment`)).json())
            .status,
      )
      .toBe("SUCCEEDED");
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT provider_account, effect_count FROM mock_transactions",
      }),
    ).toEqual([{ provider_account: "mock-account-b", effect_count: 1 }]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT merchant_id, return_url, webhook_url FROM (SELECT id AS merchant_id, return_url, webhook_url FROM merchant_contexts) ORDER BY merchant_id",
      }),
    ).toEqual([
      {
        merchant_id: "merchant-a",
        return_url: "http://127.0.0.1:3101/merchant-a/payment-return",
        webhook_url: "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a",
      },
      {
        merchant_id: "merchant-b",
        return_url: "http://localhost:3101/merchant-b/payment-return",
        webhook_url: "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-b",
      },
    ]);
  } finally {
    await merchant.stop();
  }
});

test("cancelled and unknown payments keep their order binding and cannot be replaced", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const cancelled = orderIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: orderBody,
        })
      ).json(),
    );
    const path = `/merchant-a/orders/${cancelled.id}`;
    const creation = await post({ url: merchant.url, path: `${path}/payment` });
    const original = await creation.text();
    const payment = paymentIdentity.assert(JSON.parse(original));
    expect(
      (
        await fetch(`${services.url}/v1/payment-intents/${payment.id}/cancel`, {
          method: "POST",
          headers: { authorization: "Bearer mock-paybridge-key-a" },
        })
      ).status,
    ).toBe(200);
    expect(
      await (await post({ url: merchant.url, path: `${path}/payment` })).text(),
    ).toBe(original);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${path}/confirm`,
          body: {
            commandNumber: 1,
            mockPaymentMethodRef: "pm_mock_approved",
            expectedRevision: 2,
          },
        })
      ).status,
    ).toBe(409);
    const unknownOrder = orderIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: {
            ...orderBody,
            businessReference: "UNKNOWN-ORDER",
          },
        })
      ).json(),
    );
    const unknownPath = `/merchant-a/orders/${unknownOrder.id}`;
    const unknownCreation = await (
      await post({ url: merchant.url, path: `${unknownPath}/payment` })
    ).text();
    expect(
      (
        await post({
          url: merchant.url,
          path: `${unknownPath}/confirm`,
          body: {
            commandNumber: 1,
            mockPaymentMethodRef: "pm_mock_lost_response",
            expectedRevision: 1,
          },
        })
      ).status,
    ).toBe(202);
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${merchant.url}${unknownPath}/payment`)).json())
            .status,
      )
      .toBe("UNKNOWN");
    expect(
      (
        await post({
          url: merchant.url,
          path: `${unknownPath}/confirm`,
          body: {
            commandNumber: 2,
            mockPaymentMethodRef: "pm_mock_approved",
            expectedRevision: 3,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await post({ url: merchant.url, path: `${unknownPath}/payment` })
      ).text(),
    ).toBe(unknownCreation);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT payment_intent_id FROM merchant_payments",
      }),
    ).toHaveLength(2);
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT status FROM payment_intents ORDER BY created_at",
      }),
    ).toEqual([{ status: "CANCELLED" }, { status: "UNKNOWN" }]);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
    ).toHaveLength(1);
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT effect_count FROM mock_transactions",
      }),
    ).toEqual([{ effect_count: 1 }]);
  } finally {
    await merchant.stop();
  }
});

test("a stale confirmation stays rejected until a refreshed revision is deliberately submitted as a new command", async () => {
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
    expect(
      (await post({ url: merchant.url, path: `${path}/payment` })).status,
    ).toBe(201);
    const first = {
      commandNumber: 1,
      mockPaymentMethodRef: "pm_mock_declined",
      expectedRevision: 1,
    };
    expect(
      (await post({ url: merchant.url, path: `${path}/confirm`, body: first }))
        .status,
    ).toBe(202);
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${merchant.url}${path}/payment`)).json()).status,
      )
      .toBe("FAILED");
    const stale = {
      commandNumber: 2,
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 1,
    };
    const rejected = await post({
      url: merchant.url,
      path: `${path}/confirm`,
      body: stale,
    });
    expect(rejected.status).toBe(409);
    const rejectedBody = await rejected.text();
    expect(JSON.parse(rejectedBody)).toMatchObject({
      error: { code: "payment_revision_conflict" },
    });
    expect(
      await (
        await post({ url: merchant.url, path: `${path}/confirm`, body: stale })
      ).text(),
    ).toBe(rejectedBody);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${path}/confirm`,
          body: {
            ...stale,
            expectedRevision: 3,
          },
        })
      ).status,
    ).toBe(409);
    const refreshed = await (
      await fetch(`${merchant.url}${path}/payment`)
    ).json();
    expect(refreshed).toMatchObject({ status: "FAILED", revision: 3 });
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
    ).toHaveLength(1);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT command_number FROM merchant_commands WHERE operation = 'confirm'",
      }),
    ).toHaveLength(2);
    expect(
      (
        await post({
          url: merchant.url,
          path: `${path}/confirm`,
          body: {
            ...stale,
            commandNumber: 3,
            expectedRevision: 3,
          },
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(
        async () =>
          (await (await fetch(`${merchant.url}${path}/payment`)).json()).status,
      )
      .toBe("SUCCEEDED");
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT attempt_number FROM payment_attempts ORDER BY attempt_number",
      }),
    ).toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
  } finally {
    await merchant.stop();
  }
});
