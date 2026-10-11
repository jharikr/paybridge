import { Ajv2020 } from "ajv/dist/2020.js";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { create, journey } from "../provider/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  post,
  verifyResponseHeaders,
} from "../merchant/support.ts";
import { checkout, checkoutConfirm, creation } from "./support.ts";

const document = type({
  "components?": "unknown",
  paths: { "[string]": { "[string]": "unknown" } },
});
const operation = type({
  parameters: "object[]",
  responses: { "[string]": "unknown" },
});
const media = type({ content: { "[string]": { schema: "object" } } });
function responseSchema(value: unknown) {
  const content = media.assert(value).content;
  return type("object").assert(
    (content["text/plain"] ?? content["application/json"])?.schema,
  );
}

test("OpenAPI describes actual checkout JSON, strict confirmation, redirect headers and errors without merchant credentials", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const api = document.assert(
    await (await fetch(`${services.url}/openapi.json`)).json(),
  );
  const display = operation.assert(api.paths["/checkout/{paymentId}"]?.["get"]);
  const confirm = operation.assert(
    api.paths["/checkout/{paymentId}/confirm"]?.["post"],
  );
  const leave = operation.assert(
    api.paths["/checkout/{paymentId}/leave"]?.["post"],
  );
  expect(confirm.parameters).toContainEqual(
    expect.objectContaining({
      in: "header",
      name: "idempotency-key",
      required: true,
    }),
  );
  expect(api.paths["/checkout/{paymentId}/cancel"]).toBeUndefined();
  expect(api.components).toMatchObject({
    securitySchemes: {
      checkoutCapability: { type: "apiKey", in: "query", name: "token" },
    },
  });
  for (const route of [
    api.paths["/checkout/{paymentId}"]?.["get"],
    api.paths["/checkout/{paymentId}/confirm"]?.["post"],
    api.paths["/checkout/{paymentId}/leave"]?.["post"],
  ])
    expect(route).toMatchObject({ security: [{ checkoutCapability: [] }] });
  expect(media.assert(confirm.responses["303"]).content).toHaveProperty(
    "text/plain",
  );
  expect(media.assert(leave.responses["303"]).content).toHaveProperty(
    "text/plain",
  );
  const ajv = new Ajv2020({ strict: false });
  const body = type({
    requestBody: { content: { "application/json": { schema: "object" } } },
  }).assert(api.paths["/checkout/{paymentId}/confirm"]?.["post"]);
  const acceptsConfirmation = ajv.compile(
    body.requestBody.content["application/json"].schema,
  );
  expect(
    acceptsConfirmation({
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 1,
    }),
  ).toBe(true);
  expect(
    acceptsConfirmation({
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 0,
    }),
  ).toBe(false);
  expect(
    acceptsConfirmation({
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 1,
      cardNumber: "9900000000000001",
    }),
  ).toBe(false);
  const payment = creation.assert(
    await (await create({ url: services.url })).json(),
  );
  const shown = await fetch(checkout({ url: services.url, payment }));
  expect(
    ajv.compile(responseSchema(display.responses["200"]))(await shown.json()),
  ).toBe(true);
  verifyResponseHeaders({
    documented: display.responses["200"],
    response: shown,
    names: ["cache-control", "x-content-type-options"],
  });
  for (const response of [
    await fetch(checkout({ url: services.url, payment, action: "leave" }), {
      method: "POST",
      redirect: "manual",
    }),
    await checkoutConfirm({ url: services.url, payment }),
    await checkoutConfirm({ url: services.url, payment }),
  ]) {
    expect(response.status).toBe(303);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(
      ajv.compile(responseSchema(confirm.responses["303"]))(
        await response.text(),
      ),
    ).toBe(true);
    verifyResponseHeaders({
      documented: confirm.responses["303"],
      response,
      names: ["cache-control", "x-content-type-options", "location"],
    });
  }
  const missing = await fetch(`${services.url}/checkout/${payment.id}`);
  expect(missing.status).toBe(404);
  expect(
    ajv.compile(responseSchema(display.responses["404"]))(await missing.json()),
  ).toBe(true);
  verifyResponseHeaders({
    documented: display.responses["404"],
    response: missing,
    names: ["cache-control", "x-content-type-options"],
  });
  const conflict = await checkoutConfirm({
    url: services.url,
    payment,
    key: "stale",
  });
  expect(conflict.status).toBe(409);
  expect(
    ajv.compile(responseSchema(confirm.responses["409"]))(
      await conflict.json(),
    ),
  ).toBe(true);
});

test("merchant return documents its applied result and rejects substituted bindings and navigation inputs", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const api = document.assert(
      await (await fetch(`${merchant.url}/openapi.json`)).json(),
    );
    const returning = operation.assert(
      api.paths["/{merchantFixture}/payment-return"]?.["get"],
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
    const payment = creation.assert(
      await (
        await post({
          url: merchant.url,
          path: `/merchant-a/orders/${order.id}/payment`,
        })
      ).json(),
    );
    const response = await fetch(
      `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`,
    );
    expect(response.status).toBe(200);
    expect(
      new Ajv2020({ strict: false }).compile(
        responseSchema(returning.responses["200"]),
      )(await response.json()),
    ).toBe(true);
    verifyResponseHeaders({
      documented: returning.responses["200"],
      response,
      names: ["cache-control", "x-content-type-options"],
    });
    const unbound = creation.assert(
      await (await create({ url: services.url })).json(),
    );
    for (const path of [
      `merchant-b/payment-return?paymentId=${payment.id}`,
      `merchant-c/payment-return?paymentId=${payment.id}`,
      `merchant-a/payment-return?paymentId=${unbound.id}`,
    ]) {
      const absent = await fetch(`${merchant.url}/${path}`);
      expect(absent.status).toBe(404);
      expect(await absent.json()).toMatchObject({
        error: { code: "payment_not_found" },
      });
      verifyResponseHeaders({
        documented: returning.responses["404"],
        response: absent,
        names: ["cache-control", "x-content-type-options"],
      });
    }
    for (const query of [
      "",
      "?paymentId=bad",
      `?paymentId=${payment.id}&status=SUCCEEDED`,
      `?paymentId=${payment.id}&paymentId=${payment.id}`,
    ])
      expect(
        (await fetch(`${merchant.url}/merchant-a/payment-return${query}`))
          .status,
      ).toBe(400);
    expect(
      await (
        await fetch(`${merchant.url}/merchant-a/orders/${order.id}`)
      ).json(),
    ).toMatchObject({ state: "UNPAID", paidAt: null });
  } finally {
    await merchant.stop();
  }
});
