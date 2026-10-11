import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { create, headers, journey, lookup, rows } from "../provider/support.ts";
import {
  checkout,
  checkoutConfirm,
  controlledPaybridge,
  creation,
  paymentRecords,
} from "./support.ts";

for (const status of [
  "PENDING",
  "PROCESSING",
  "FAILED",
  "UNKNOWN",
  "SUCCEEDED",
  "CANCELLED",
]) {
  test(`leave is repeatable navigation only in ${status}`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const payment = creation.assert(await (await create(services.url)).json());
    if (status === "CANCELLED")
      expect(
        (
          await fetch(
            `${services.url}/v1/payment-intents/${payment.id}/cancel`,
            {
              method: "POST",
              headers: { authorization: headers().authorization },
            },
          )
        ).status,
      ).toBe(200);
    else if (status !== "PENDING") {
      expect(
        (
          await checkoutConfirm({
            url: services.url,
            payment,
            fixture:
              status === "FAILED"
                ? "pm_mock_declined"
                : status === "UNKNOWN"
                  ? "pm_mock_lost_response"
                  : "pm_mock_approved",
          })
        ).status,
      ).toBe(303);
      if (status !== "PROCESSING") {
        await services.startWorker();
        await expect
          .poll(async () => (await lookup(services.url, payment.id)).status)
          .toBe(status);
      }
    }
    const before = paymentRecords(files.paybridge);
    for (let index = 0; index < 3; index++) {
      const leave = await fetch(
        checkout({ url: services.url, payment, action: "leave" }),
        { method: "POST", redirect: "manual" },
      );
      expect(leave.status).toBe(303);
      expect(await leave.text()).toBe("");
      expect(leave.headers.get("location")).toBe(
        `http://127.0.0.1:3101/payment-return?paymentId=${payment.id}`,
      );
    }
    expect(paymentRecords(files.paybridge)).toEqual(before);
    expect(
      (
        await fetch(
          `${services.url}/checkout/${payment.id}/cancel${new URL(payment.checkoutUrl).search}`,
          { method: "POST" },
        )
      ).status,
    ).toBe(404);
    expect((await fetch(checkout({ url: services.url, payment }))).status).toBe(
      status === "PENDING" || status === "FAILED" ? 200 : 409,
    );
    const retry = await checkoutConfirm({
      url: services.url,
      payment,
      key: "deliberate-after-leaving",
      revision: (await lookup(services.url, payment.id)).revision,
    });
    expect(retry.status).toBe(
      status === "PENDING" || status === "FAILED" ? 303 : 409,
    );
  });
}

test("checkout uses only a stored permitted URL, preserves query values, and omits inert descriptions", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const input = {
    merchantReference: "safe-url",
    description: "<script>alert('x')</script>",
    amount: 100,
    currency: "XCD",
    returnUrl:
      "http://127.0.0.1:3101/merchant-a/payment-return?order=a%26b%20%F0%9F%98%80&paymentId=old",
  };
  const send = (returnUrl: string, key: string) =>
    fetch(`${services.url}/v1/payment-intents`, {
      method: "POST",
      headers: { ...headers(), "idempotency-key": key },
      body: JSON.stringify({ ...input, returnUrl }),
    });
  for (const returnUrl of [
    "http://127.0.0.1:3101/return#fragment",
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://evil.example/return",
    "http://user:password@127.0.0.1:3101/return",
  ])
    expect((await send(returnUrl, `unsafe-${returnUrl}`)).status).toBe(400);
  const response = await send(input.returnUrl, "safe");
  expect(response.status).toBe(201);
  const payment = creation.assert(await response.json());
  const display = await fetch(checkout({ url: services.url, payment }));
  expect(display.headers.get("content-type")).toContain("application/json");
  expect(await display.text()).not.toContain("script");
  const leave = await fetch(
    checkout({ url: services.url, payment, action: "leave" }),
    { method: "POST", redirect: "manual" },
  );
  expect(leave.headers.get("location")).toBe(
    `http://127.0.0.1:3101/merchant-a/payment-return?order=a%26b+%F0%9F%98%80&paymentId=${payment.id}`,
  );
  expect(services.server.output()).not.toContain(
    new URL(payment.checkoutUrl).searchParams.get("token"),
  );
});

test("deactivation removes capability access including cached checkout replays", async () => {
  await using files = await isolatedDatabases();
  const server = await controlledPaybridge({
    path: files.paybridge,
    fault: "lookup",
  });
  try {
    const payment = creation.assert(await (await create(server.url)).json());
    expect((await checkoutConfirm({ url: server.url, payment })).status).toBe(
      303,
    );
    server.child.send({ kind: "deactivate" });
    expect(await server.message()).toEqual({ kind: "deactivated" });
    expect((await fetch(checkout({ url: server.url, payment }))).status).toBe(
      404,
    );
    expect((await checkoutConfirm({ url: server.url, payment })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(checkout({ url: server.url, payment, action: "leave" }), {
          method: "POST",
          redirect: "manual",
        })
      ).status,
    ).toBe(404);
    expect(
      rows(files.paybridge, "SELECT id FROM payment_attempts"),
    ).toHaveLength(1);
  } finally {
    await server.stop();
  }
});
