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
      await (await post(merchant.url, "/merchant-a/orders", orderBody)).json(),
    );
    const b = orderIdentity.assert(
      await (await post(merchant.url, "/merchant-b/orders", orderBody)).json(),
    );
    const aPath = `/merchant-a/orders/${a.id}`;
    const bPath = `/merchant-b/orders/${b.id}`;
    const createdA = await post(merchant.url, `${aPath}/payment`);
    const aId = paymentIdentity.assert(await createdA.json()).id;
    const createdB = await post(merchant.url, `${bPath}/payment`);
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
      (await post(merchant.url, `/merchant-b/orders/${a.id}/confirm`, confirm))
        .status,
    ).toBe(404);
    expect(
      (await post(merchant.url, `${bPath}/commands/${aCommand}/recover`))
        .status,
    ).toBe(404);
    expect(
      (
        await post(
          merchant.url,
          `${aPath}/commands/${createdB.headers.get("x-merchant-command-id")}/recover`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(merchant.url, `${aPath}/confirm`, {
          ...confirm,
          paymentIntentId: bId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(merchant.url, `${aPath}/confirm`, {
          ...confirm,
          merchantId: "merchant-b",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(merchant.url, `${aPath}/confirm`, {
          ...confirm,
          cardNumber: "9900000000000001",
        })
      ).status,
    ).toBe(400);
    expect((await post(merchant.url, `${aPath}/payment`, {})).status).toBe(400);
    expect(
      (await fetch(`${merchant.url}${aPath}/payment?paymentId=${bId}`)).status,
    ).toBe(400);
    expect(
      (
        await post(merchant.url, "/merchant-a/orders", {
          ...orderBody,
          amount: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(merchant.url, "/merchant-a/orders", {
          ...orderBody,
          apiKey: "mock-paybridge-key-b",
        })
      ).status,
    ).toBe(400);
    expect(rows(files.paybridge, "SELECT id FROM payment_attempts")).toEqual(
      [],
    );
    expect((await post(merchant.url, `${bPath}/confirm`, confirm)).status).toBe(
      202,
    );
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${merchant.url}${bPath}/payment`)).json())
            .status,
      )
      .toBe("SUCCEEDED");
    expect(
      rows(
        files.mockFourcs,
        "SELECT provider_account, effect_count FROM mock_transactions",
      ),
    ).toEqual([{ provider_account: "mock-account-b", effect_count: 1 }]);
    expect(
      rows(
        files.merchant,
        "SELECT merchant_id, return_url, webhook_url FROM (SELECT id AS merchant_id, return_url, webhook_url FROM merchant_contexts) ORDER BY merchant_id",
      ),
    ).toEqual([
      {
        merchant_id: "merchant-a",
        return_url: "http://127.0.0.1:3101/merchant-a/payment-return",
        webhook_url: "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a",
      },
      {
        merchant_id: "merchant-b",
        return_url: "http://127.0.0.1:3101/merchant-b/payment-return",
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
      await (await post(merchant.url, "/merchant-a/orders", orderBody)).json(),
    );
    const path = `/merchant-a/orders/${cancelled.id}`;
    const creation = await post(merchant.url, `${path}/payment`);
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
    expect(await (await post(merchant.url, `${path}/payment`)).text()).toBe(
      original,
    );
    expect(
      (
        await post(merchant.url, `${path}/confirm`, {
          commandNumber: 1,
          mockPaymentMethodRef: "pm_mock_approved",
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
    const unknownOrder = orderIdentity.assert(
      await (
        await post(merchant.url, "/merchant-a/orders", {
          ...orderBody,
          businessReference: "UNKNOWN-ORDER",
        })
      ).json(),
    );
    const unknownPath = `/merchant-a/orders/${unknownOrder.id}`;
    const unknownCreation = await (
      await post(merchant.url, `${unknownPath}/payment`)
    ).text();
    expect(
      (
        await post(merchant.url, `${unknownPath}/confirm`, {
          commandNumber: 1,
          mockPaymentMethodRef: "pm_mock_lost_response",
          expectedRevision: 1,
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
        await post(merchant.url, `${unknownPath}/confirm`, {
          commandNumber: 2,
          mockPaymentMethodRef: "pm_mock_approved",
          expectedRevision: 3,
        })
      ).status,
    ).toBe(409);
    expect(
      await (await post(merchant.url, `${unknownPath}/payment`)).text(),
    ).toBe(unknownCreation);
    expect(
      rows(files.merchant, "SELECT payment_intent_id FROM merchant_payments"),
    ).toHaveLength(2);
    expect(
      rows(
        files.paybridge,
        "SELECT status FROM payment_intents ORDER BY created_at",
      ),
    ).toEqual([{ status: "CANCELLED" }, { status: "UNKNOWN" }]);
    expect(
      rows(files.paybridge, "SELECT id FROM payment_attempts"),
    ).toHaveLength(1);
    expect(
      rows(files.mockFourcs, "SELECT effect_count FROM mock_transactions"),
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
      await (await post(merchant.url, "/merchant-a/orders", orderBody)).json(),
    );
    const path = `/merchant-a/orders/${order.id}`;
    expect((await post(merchant.url, `${path}/payment`)).status).toBe(201);
    const first = {
      commandNumber: 1,
      mockPaymentMethodRef: "pm_mock_declined",
      expectedRevision: 1,
    };
    expect((await post(merchant.url, `${path}/confirm`, first)).status).toBe(
      202,
    );
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
    const rejected = await post(merchant.url, `${path}/confirm`, stale);
    expect(rejected.status).toBe(409);
    const rejectedBody = await rejected.text();
    expect(JSON.parse(rejectedBody)).toMatchObject({
      error: { code: "payment_revision_conflict" },
    });
    expect(
      await (await post(merchant.url, `${path}/confirm`, stale)).text(),
    ).toBe(rejectedBody);
    expect(
      (
        await post(merchant.url, `${path}/confirm`, {
          ...stale,
          expectedRevision: 3,
        })
      ).status,
    ).toBe(409);
    const refreshed = await (
      await fetch(`${merchant.url}${path}/payment`)
    ).json();
    expect(refreshed).toMatchObject({ status: "FAILED", revision: 3 });
    expect(
      rows(files.paybridge, "SELECT id FROM payment_attempts"),
    ).toHaveLength(1);
    expect(
      rows(
        files.merchant,
        "SELECT command_number FROM merchant_commands WHERE operation = 'confirm'",
      ),
    ).toHaveLength(2);
    expect(
      (
        await post(merchant.url, `${path}/confirm`, {
          ...stale,
          commandNumber: 3,
          expectedRevision: 3,
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
      rows(
        files.paybridge,
        "SELECT attempt_number FROM payment_attempts ORDER BY attempt_number",
      ),
    ).toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
  } finally {
    await merchant.stop();
  }
});
