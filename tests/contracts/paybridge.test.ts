import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import {
  create,
  confirm,
  headers,
  journey,
  rows,
} from "../provider/support.ts";
import { paymentIdentity } from "../merchant/support.ts";
import { checkout, checkoutConfirm } from "../checkout/support.ts";
import { contractAt, compareResponse, compareParameters } from "./support.ts";

const collection = "/v1/payment-intents";
const intent = `${collection}/{paymentId}`;
const confirmation = `${intent}/confirm`;
const cancellation = `${intent}/cancel`;
const display = "/checkout/{paymentId}";
const checkoutConfirmation = `${display}/confirm`;
const leave = `${display}/leave`;
const locationHeaders = ["cache-control", "x-content-type-options", "location"];

test("merchant payment methods match their own success, ownership, strict-input and conflict response contracts", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const contract = await contractAt(services.url);
  const payment = paymentIdentity.assert(
    await compareResponse({
      contract,
      path: collection,
      method: "post",
      response: await create({ url: services.url }),
      status: 201,
      headers: locationHeaders,
    }),
  );
  for (const [path, method] of [
    [intent, "get"],
    [confirmation, "post"],
    [cancellation, "post"],
  ] satisfies [string, string][])
    compareParameters({
      contract,
      path,
      method,
      values: {
        paymentId: payment.id,
        ...(path === confirmation ? { "idempotency-key": "confirm-1" } : {}),
      },
    });
  const accepted = await compareResponse({
    contract,
    path: confirmation,
    method: "post",
    response: await confirm({ url: services.url, id: payment.id }),
    status: 202,
    headers: locationHeaders,
  });
  expect(
    await compareResponse({
      contract,
      path: confirmation,
      method: "post",
      response: await confirm({ url: services.url, id: payment.id }),
      status: 202,
      headers: locationHeaders,
    }),
  ).toEqual(accepted);
  expect(
    await compareResponse({
      contract,
      path: intent,
      method: "get",
      response: await fetch(`${services.url}${collection}/${payment.id}`, {
        headers: headers(),
      }),
      status: 200,
    }),
  ).toMatchObject({
    status: "PROCESSING",
    revision: 2,
    latestAttempt: { status: "PROCESSING" },
  });
  const pending = paymentIdentity.assert(
    await (
      await create({ url: services.url, options: { key: "cancel" } })
    ).json(),
  );
  const cancel = () =>
    fetch(`${services.url}${collection}/${pending.id}/cancel`, {
      method: "POST",
      headers: { authorization: headers().authorization },
    });
  const cancelled = await compareResponse({
    contract,
    path: cancellation,
    method: "post",
    response: await cancel(),
    status: 200,
  });
  expect(cancelled).toMatchObject({ status: "CANCELLED", revision: 2 });
  expect(
    await compareResponse({
      contract,
      path: cancellation,
      method: "post",
      response: await cancel(),
      status: 200,
    }),
  ).toEqual(cancelled);
  const commandBody = {
    mockPaymentMethodRef: "pm_mock_approved",
    expectedRevision: 1,
  };
  for (const scenario of [
    {
      path: collection,
      target: collection,
      method: "post",
      body: {},
      status: 400,
    },
    {
      path: collection,
      target: collection,
      method: "post",
      body: {
        merchantReference: "ORDER",
        amount: 100,
        currency: "XCD",
        returnUrl: "http://127.0.0.1:3101/payment-return",
      },
      status: 401,
      credential: "wrong",
    },
    {
      path: collection,
      target: collection,
      method: "post",
      body: {
        merchantReference: "CHANGED",
        amount: 100,
        currency: "XCD",
        returnUrl: "http://127.0.0.1:3101/payment-return",
      },
      status: 409,
      key: "create-1",
    },
    {
      path: collection,
      target: collection,
      method: "post",
      body: { description: "x".repeat(17000) },
      status: 413,
    },
    {
      path: collection,
      target: collection,
      method: "post",
      body: {},
      status: 415,
      media: "text/xml",
    },
    { path: intent, target: `${collection}/bad`, method: "get", status: 400 },
    {
      path: intent,
      target: `${collection}/${payment.id}?extra=1`,
      method: "get",
      status: 400,
    },
    {
      path: intent,
      target: `${collection}/${payment.id}`,
      method: "get",
      status: 401,
      credential: "wrong",
    },
    {
      path: intent,
      target: `${collection}/${payment.id}`,
      method: "get",
      status: 404,
      credential: "mock-paybridge-key-b",
    },
    {
      path: confirmation,
      target: `${collection}/${payment.id}/confirm`,
      method: "post",
      body: {},
      status: 400,
    },
    {
      path: confirmation,
      target: `${collection}/${payment.id}/confirm`,
      method: "post",
      body: commandBody,
      status: 401,
      credential: "wrong",
    },
    {
      path: confirmation,
      target: `${collection}/${payment.id}/confirm`,
      method: "post",
      body: commandBody,
      status: 404,
      credential: "mock-paybridge-key-b",
    },
    {
      path: confirmation,
      target: `${collection}/${payment.id}/confirm`,
      method: "post",
      body: commandBody,
      status: 409,
    },
    {
      path: cancellation,
      target: `${collection}/${pending.id}/cancel`,
      method: "post",
      body: {},
      status: 400,
    },
    {
      path: cancellation,
      target: `${collection}/${pending.id}/cancel?extra=1`,
      method: "post",
      status: 400,
    },
    {
      path: cancellation,
      target: `${collection}/${pending.id}/cancel`,
      method: "post",
      status: 401,
      credential: "wrong",
    },
    {
      path: cancellation,
      target: `${collection}/${pending.id}/cancel`,
      method: "post",
      status: 404,
      credential: "mock-paybridge-key-b",
    },
    {
      path: cancellation,
      target: `${collection}/${payment.id}/cancel`,
      method: "post",
      status: 409,
    },
  ]) {
    const response = await fetch(services.url + scenario.target, {
      method: scenario.method.toUpperCase(),
      headers: {
        authorization: `Bearer ${scenario.credential ?? "mock-paybridge-key-a"}`,
        "idempotency-key": scenario.key ?? "rejected",
        ...(scenario.body === undefined
          ? {}
          : { "content-type": scenario.media ?? "application/json" }),
      },
      ...(scenario.body === undefined
        ? {}
        : { body: JSON.stringify(scenario.body) }),
    });
    expect(
      await compareResponse({ contract, ...scenario, response }),
    ).toMatchObject({ error: { requestId: expect.stringMatching(/^req_/) } });
    expect(response.headers.get("retry-after")).toBeNull();
  }
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT status,revision FROM payment_intents ORDER BY status",
    }),
  ).toEqual([
    { status: "CANCELLED", revision: 2 },
    { status: "PROCESSING", revision: 2 },
  ]);
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT count(*) AS count FROM payment_attempts",
    }),
  ).toEqual([{ count: 1 }]);
});

test("checkout display, confirmation and leave each match their own JSON or empty redirect contract", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const contract = await contractAt(services.url);
  const payment = paymentIdentity.assert(
    await (await create({ url: services.url })).json(),
  );
  for (const [path, method] of [
    [display, "get"],
    [checkoutConfirmation, "post"],
    [leave, "post"],
  ] satisfies [string, string][])
    compareParameters({
      contract,
      path,
      method,
      values: {
        paymentId: payment.id,
        ...(path === checkoutConfirmation
          ? { "idempotency-key": "checkout-1" }
          : {}),
      },
    });
  expect(
    await compareResponse({
      contract,
      path: display,
      method: "get",
      response: await fetch(checkout({ url: services.url, payment })),
      status: 200,
    }),
  ).toMatchObject({ paymentIntentId: payment.id, status: "PENDING" });
  const leaveUrl = checkout({ url: services.url, payment, action: "leave" });
  expect(
    await compareResponse({
      contract,
      path: leave,
      method: "post",
      response: await fetch(leaveUrl, { method: "POST", redirect: "manual" }),
      status: 303,
      headers: locationHeaders,
    }),
  ).toBe("");
  const confirmUrl = checkout({
    url: services.url,
    payment,
    action: "confirm",
  });
  for (const key of [undefined, "x".repeat(129)]) {
    const response = await fetch(confirmUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      body: JSON.stringify({
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
      }),
      redirect: "manual",
    });
    expect(
      await compareResponse({
        contract,
        path: checkoutConfirmation,
        method: "post",
        response,
        status: 400,
      }),
    ).toMatchObject({ error: { code: "invalid_request" } });
  }
  for (const route of [
    { path: display, method: "get", action: undefined },
    { path: checkoutConfirmation, method: "post", action: "confirm" },
    { path: leave, method: "post", action: "leave" },
  ] satisfies {
    path: string;
    method: string;
    action: "confirm" | "leave" | undefined;
  }[]) {
    const valid = checkout({
      url: services.url,
      payment,
      ...(route.action ? { action: route.action } : {}),
    });
    for (const [url, status] of [
      [`${valid}&extra=1`, 400],
      [valid.replace(/token=[^&]+/, "token=wrong"), 404],
    ] satisfies [string, number][]) {
      const response = await fetch(url, {
        method: route.method.toUpperCase(),
        redirect: "manual",
        ...(route.action === "confirm"
          ? {
              headers: {
                "content-type": "application/json",
                "idempotency-key": "invalid-route",
              },
              body: JSON.stringify({
                mockPaymentMethodRef: "pm_mock_approved",
                expectedRevision: 1,
              }),
            }
          : {}),
      });
      await compareResponse({ contract, ...route, response, status });
    }
  }
  await compareResponse({
    contract,
    path: leave,
    method: "post",
    response: await fetch(leaveUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    status: 400,
  });
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT status,revision FROM payment_intents",
    }),
  ).toEqual([{ status: "PENDING", revision: 1 }]);
  expect(
    await compareResponse({
      contract,
      path: checkoutConfirmation,
      method: "post",
      response: await checkoutConfirm({ url: services.url, payment }),
      status: 303,
      headers: locationHeaders,
    }),
  ).toBe("");
  await compareResponse({
    contract,
    path: display,
    method: "get",
    response: await fetch(checkout({ url: services.url, payment })),
    status: 409,
  });
  await compareResponse({
    contract,
    path: checkoutConfirmation,
    method: "post",
    response: await checkoutConfirm({ url: services.url, payment, key: "new" }),
    status: 409,
  });
});
