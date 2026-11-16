import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { create, headers, journey, rows } from "../provider/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
} from "../merchant/support.ts";
import { contractAt, compareResponse, rawRequest } from "./support.ts";
import { boundOrder, deliver } from "../inbox/support.ts";
import { payload } from "../webhooks/support.ts";

test("early router errors honor each API's generated JSON and security-header contract", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const payment = paymentIdentity.assert(
      await (await create({ url: services.url })).json(),
    );
    const order = orderIdentity.assert(
      await (
        await post({
          url: merchant.url,
          path: "/merchant-a/orders",
          body: orderBody,
        })
      ).json(),
    );
    const paybridgeContract = await contractAt(services.url);
    const merchantContract = await contractAt(merchant.url);
    await compareResponse({
      contract: paybridgeContract,
      path: "/v1/payment-intents/{paymentId}",
      method: "get",
      status: 200,
      response: await fetch(
        `${services.url}/v1/payment-intents/${payment.id}`,
        { headers: headers() },
      ),
    });
    await compareResponse({
      contract: merchantContract,
      path: "/{merchantFixture}/orders/{orderId}",
      method: "get",
      status: 200,
      response: await fetch(`${merchant.url}/merchant-a/orders/${order.id}`),
    });
    for (const endpoint of [
      {
        origin: services.url,
        prefix: "/v1/payment-intents/",
        path: "/v1/payment-intents/{paymentId}",
        method: "get",
        contract: paybridgeContract,
      },
      {
        origin: merchant.url,
        prefix: "/merchant-a/orders/",
        path: "/{merchantFixture}/orders/{orderId}",
        method: "get",
        contract: merchantContract,
      },
      {
        origin: merchant.url,
        prefix: "/api/webhooks/paybridge/",
        path: "/api/webhooks/paybridge/{merchantFixture}",
        method: "post",
        contract: merchantContract,
      },
    ]) {
      for (const [segment, status] of [
        ["%ZZ", 400],
        ["x".repeat(101), 414],
      ] satisfies [string, number][]) {
        const response = await rawRequest({
          origin: endpoint.origin,
          path: endpoint.prefix + segment,
          method: endpoint.method.toUpperCase(),
        });
        expect(response.headers.get("content-type")).toBe(
          "application/json; charset=utf-8",
        );
        const body = await compareResponse({ ...endpoint, response, status });
        expect(body).toMatchObject({
          error: {
            code: "invalid_request",
            message: "The request is invalid.",
            requestId: expect.stringMatching(/^req_/),
          },
        });
        expect(JSON.stringify(body)).not.toContain(segment);
      }
    }
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT count(*) AS count FROM payment_intents",
      }),
    ).toEqual([{ count: 1 }]);
    expect(
      rows({ path: files.merchant, sql: "SELECT event_id FROM webhook_inbox" }),
    ).toEqual([]);
    await compareResponse({
      contract: merchantContract,
      path: "/api/webhooks/paybridge/{merchantFixture}",
      method: "post",
      response: await deliver({ url: merchant.url, body: payload }),
      status: 204,
    });
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT receiving_merchant_id,status FROM webhook_inbox",
      }),
    ).toEqual([{ receiving_merchant_id: "merchant-a", status: "PENDING" }]);
  } finally {
    await merchant.stop();
  }
});

test("only explicit GET methods are exposed, with authentication and capability checks preserved", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const { order, payment, path } = await boundOrder({ url: merchant.url });
    const checkout = new URL(payment.checkoutUrl);
    const checkoutPath = checkout.pathname + checkout.search;
    const getPaths = [
      {
        origin: services.url,
        path: `/v1/payment-intents/${payment.id}`,
        headers: headers(),
      },
      { origin: services.url, path: checkoutPath },
      { origin: services.url, path: "/openapi.json" },
      { origin: merchant.url, path },
      { origin: merchant.url, path: `${path}/commands` },
      { origin: merchant.url, path: `${path}/payment` },
      {
        origin: merchant.url,
        path: `/merchant-a/payment-return?paymentId=${payment.id}`,
      },
      { origin: merchant.url, path: "/openapi.json" },
    ];
    for (const route of getPaths) {
      const head = await rawRequest({ ...route, method: "HEAD" });
      expect(head.status, route.path).toBe(404);
      expect(await head.text()).toBe("");
      const get = await rawRequest(route);
      expect(get.status, route.path).toBe(200);
      expect(get.headers.get("cache-control")).toBe("no-store");
      expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    }
    for (const [path, authorization, status] of [
      [`/v1/payment-intents/${payment.id}`, "", 401],
      [`/v1/payment-intents/${payment.id}`, "Bearer mock-paybridge-key-b", 404],
      [`/checkout/${payment.id}?token=${"x".repeat(43)}`, "", 404],
    ] satisfies [string, string, number][]) {
      expect(
        (
          await rawRequest({
            origin: services.url,
            path,
            headers: { authorization },
          })
        ).status,
      ).toBe(status);
      expect(
        (
          await rawRequest({
            origin: services.url,
            path,
            method: "HEAD",
            headers: { authorization },
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await fetch(
          `${merchant.url}/merchant-b/payment-return?paymentId=${payment.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT id,state,paid_at FROM orders",
      }),
    ).toEqual([{ id: order.id, state: "UNPAID", paid_at: null }]);
  } finally {
    await merchant.stop();
  }
});

test("unmatched API routes return stable redacted errors without echoing capabilities or credentials", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    for (const origin of [services.url, merchant.url]) {
      const response = await fetch(
        `${origin}/checkout/pi_${"a".repeat(32)}/cancel?token=sensitive-capability&credential=sensitive-credential`,
        { method: "POST" },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await response.json();
      expect(body).toEqual({
        error: {
          code: "route_not_found",
          message: "The route was not found.",
          requestId: expect.stringMatching(/^req_/),
        },
      });
      expect(JSON.stringify(body)).not.toMatch(
        /sensitive|token=|credential=|checkout/,
      );
    }
  } finally {
    await merchant.stop();
  }
});
