import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, create, journey, lookup, rows } from "../provider/support.ts";

import { creation, checkout, checkoutConfirm } from "./support.ts";

test("a capability authorizes headless display, navigation, and one cached checkout confirmation", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const payment = creation.assert(
    await (await create({ url: services.url })).json(),
  );
  const display = await fetch(checkout({ url: services.url, payment }));
  expect(display.status).toBe(200);
  expect(display.headers.get("cache-control")).toBe("no-store");
  expect(display.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await display.json()).toEqual({
    paymentIntentId: payment.id,
    amount: 7500,
    currency: "XCD",
    status: "PENDING",
    revision: 1,
    confirmPath: `/checkout/${payment.id}/confirm`,
    leavePath: `/checkout/${payment.id}/leave`,
  });
  const before = rows({
    path: files.paybridge,
    sql: "SELECT status, revision FROM payment_intents",
  });
  const left = await fetch(
    checkout({ url: services.url, payment, action: "leave" }),
    {
      method: "POST",
      redirect: "manual",
    },
  );
  expect(left.status).toBe(303);
  expect(left.headers.get("location")).toBe(
    `http://127.0.0.1:3101/payment-return?paymentId=${payment.id}`,
  );
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT status, revision FROM payment_intents",
    }),
  ).toEqual(before);
  const input = {
    mockPaymentMethodRef: "pm_mock_approved",
    expectedRevision: 1,
  };
  const request = () =>
    fetch(checkout({ url: services.url, payment, action: "confirm" }), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "checkout-1",
      },
      body: JSON.stringify(input),
    });
  const accepted = await request();
  expect(accepted.status).toBe(303);
  expect(await accepted.text()).toBe("");
  expect(accepted.headers.get("location")).toBe(left.headers.get("location"));
  const replay = await request();
  expect(replay.status).toBe(303);
  expect(replay.headers.get("location")).toBe(accepted.headers.get("location"));
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT status, revision FROM payment_intents",
    }),
  ).toEqual([{ status: "PROCESSING", revision: 2 }]);
  expect(
    rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
  ).toHaveLength(1);
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT operation, response_status, response_body FROM idempotency_keys WHERE key = 'checkout-1'",
    }),
  ).toEqual([
    { operation: "confirm_checkout", response_status: 303, response_body: "" },
  ]);
});

test("missing, mismatched, and invalid capabilities never expose or mutate a payment", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const a = creation.assert(await (await create({ url: services.url })).json());
  const b = creation.assert(
    await (
      await create({ url: services.url, options: { key: "b", merchant: "b" } })
    ).json(),
  );
  const otherToken = new URL(b.checkoutUrl).search;
  for (const query of [
    "",
    "?token=bad",
    otherToken,
    "?token=bad&token=other",
  ]) {
    for (const action of ["display", "leave", "confirm"]) {
      const path = `/checkout/${a.id}${action === "display" ? "" : `/${action}`}${query}`;
      const response = await fetch(`${services.url}${path}`, {
        redirect: "manual",
        ...(action === "display" ? {} : { method: "POST" }),
        ...(action === "confirm"
          ? {
              headers: {
                "content-type": "application/json",
                "idempotency-key": "invalid",
              },
              body: JSON.stringify({
                mockPaymentMethodRef: "pm_mock_approved",
                expectedRevision: 1,
              }),
            }
          : {}),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "payment_not_found" },
      });
    }
  }
  expect(
    rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
  ).toEqual([]);
  const token = new URL(a.checkoutUrl).searchParams.get("token");
  expect(
    (
      await fetch(`${services.url}/v1/payment-intents/${a.id}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(401);
  const input = {
    mockPaymentMethodRef: "pm_mock_approved",
    expectedRevision: 1,
  };
  for (const body of [
    { ...input, cardNumber: "9900000000000001" },
    { ...input, providerAccountRef: "mock-account-b" },
    { ...input, expectedRevision: 0 },
    { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, expectedRevision: 1.5 },
  ]) {
    expect(
      (
        await fetch(
          checkout({ url: services.url, payment: a, action: "confirm" }),
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              "idempotency-key": "strict",
            },
            body: JSON.stringify(body),
          },
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await fetch(
        checkout({ url: services.url, payment: a, action: "leave" }),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          redirect: "manual",
        },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(
        `${checkout({ url: services.url, payment: a })}&returnUrl=https://evil.example`,
      )
    ).status,
  ).toBe(400);
  expect(
    (await fetch(checkout({ url: services.url, payment: a }))).status,
  ).toBe(200);
});

test("checkout replay precedes state guards, stale instructions conflict, and a deliberate new revision can retry", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const payment = creation.assert(
    await (await create({ url: services.url })).json(),
  );
  const send = ({
    key,
    revision,
    fixture = "pm_mock_declined",
  }: {
    key: string;
    revision: number;
    fixture?: string;
  }) =>
    fetch(checkout({ url: services.url, payment, action: "confirm" }), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        expectedRevision: revision,
        mockPaymentMethodRef: fixture,
      }),
    });
  const accepted = await send({ key: "checkout-first", revision: 1 });
  expect(accepted.status).toBe(303);
  await services.startWorker();
  await expect
    .poll(
      async () => (await lookup({ url: services.url, id: payment.id })).status,
    )
    .toBe("FAILED");
  const replay = await send({ key: "checkout-first", revision: 1 });
  expect(replay.status).toBe(303);
  expect(replay.headers.get("location")).toBe(accepted.headers.get("location"));
  expect((await send({ key: "checkout-first", revision: 3 })).status).toBe(409);
  const stale = await send({ key: "checkout-stale", revision: 1 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: { code: "payment_revision_conflict" },
  });
  expect(
    (
      await confirm({
        url: services.url,
        id: payment.id,
        options: {
          key: "checkout-first",
          revision: 1,
          fixture: "pm_mock_declined",
        },
      })
    ).status,
  ).toBe(409);
  expect((await fetch(checkout({ url: services.url, payment }))).status).toBe(
    200,
  );
  expect(
    rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
  ).toHaveLength(1);
  expect(
    (
      await send({
        key: "checkout-second",
        revision: 3,
        fixture: "pm_mock_approved",
      })
    ).status,
  ).toBe(303);
  await expect
    .poll(
      async () => (await lookup({ url: services.url, id: payment.id })).status,
    )
    .toBe("SUCCEEDED");
  expect((await fetch(checkout({ url: services.url, payment }))).status).toBe(
    409,
  );
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT attempt_number FROM payment_attempts ORDER BY attempt_number",
    }),
  ).toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
  expect(
    rows({
      path: files.mockFourcs,
      sql: "SELECT effect_count FROM mock_transactions ORDER BY accepted_at",
    }),
  ).toEqual([{ effect_count: 0 }, { effect_count: 1 }]);
});

test("checkout command keys stay merchant-scoped and use each bound provider account", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const a = creation.assert(await (await create({ url: services.url })).json());
  const b = creation.assert(
    await (
      await create({ url: services.url, options: { merchant: "b" } })
    ).json(),
  );
  for (const payment of [a, b]) {
    expect((await fetch(checkout({ url: services.url, payment }))).status).toBe(
      200,
    );
    expect(
      (
        await checkoutConfirm({
          url: services.url,
          payment,
          key: "same-payer-key",
        })
      ).status,
    ).toBe(303);
  }
  await services.startWorker();
  await expect
    .poll(async () => (await lookup({ url: services.url, id: a.id })).status)
    .toBe("SUCCEEDED");
  await expect
    .poll(
      async () =>
        (await lookup({ url: services.url, id: b.id, merchant: "b" })).status,
    )
    .toBe("SUCCEEDED");
  expect(
    rows({
      path: files.mockFourcs,
      sql: "SELECT provider_account, effect_count FROM mock_transactions ORDER BY provider_account",
    }),
  ).toEqual([
    { provider_account: "mock-account-a", effect_count: 1 },
    { provider_account: "mock-account-b", effect_count: 1 },
  ]);
});
