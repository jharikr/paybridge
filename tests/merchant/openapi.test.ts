import Ajv from "ajv/dist/2020.js";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey } from "../provider/support.ts";
import { compareResponse } from "../contracts/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  post,
  verifyResponseHeaders,
} from "./support.ts";

const media = type({ content: { "application/json": { schema: "object" } } });
const documentedOperation = type({
  requestBody: media,
  responses: { "[string]": media },
});
const openapi = type({
  openapi: "'3.1.0'",
  paths: { "[string]": { "[string]": "unknown" } },
});

test("sensitive acknowledgments, replays, snapshots, and errors are uncached and disable MIME sniffing", async () => {
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
    const creation = await post(merchant.url, `${path}/payment`);
    expect(creation.status).toBe(201);
    const creationBody = await creation.text();
    const replay = await post(merchant.url, `${path}/payment`);
    expect(await replay.text()).toBe(creationBody);
    const lookup = await fetch(`${merchant.url}${path}/payment`);
    expect(lookup.status).toBe(200);
    const invalid = await post(merchant.url, `${path}/confirm`, {});
    expect(invalid.status).toBe(400);
    for (const response of [creation, replay, lookup, invalid]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  } finally {
    await merchant.stop();
  }
});

test("merchant OpenAPI matches real order and confirmation requests and acknowledgments", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const document = openapi.assert(
      await (await fetch(`${merchant.url}/openapi.json`)).json(),
    );
    const operations = type({ responses: { "[string]": "unknown" } });
    const creationOperation = operations.assert(
      document.paths["/{merchantFixture}/orders/{orderId}/payment"]?.["post"],
    );
    const lookupOperation = operations.assert(
      document.paths["/{merchantFixture}/orders/{orderId}/payment"]?.["get"],
    );
    const recoveryOperation = operations.assert(
      document.paths[
        "/{merchantFixture}/orders/{orderId}/commands/{commandId}/recover"
      ]?.["post"],
    );
    const securityHeaders = ["cache-control", "x-content-type-options"];
    const acknowledgmentHeaders = [
      ...securityHeaders,
      "location",
      "x-merchant-command-id",
    ];
    const orderOperation = documentedOperation.assert(
      document.paths["/{merchantFixture}/orders"]?.["post"],
    );
    const confirmOperation = documentedOperation.assert(
      document.paths["/{merchantFixture}/orders/{orderId}/confirm"]?.["post"],
    );
    const ajv = new Ajv.default({ strict: false });
    const validOrder = ajv.compile(
      orderOperation.requestBody.content["application/json"].schema,
    );
    expect(validOrder(orderBody)).toBe(true);
    expect(validOrder({ ...orderBody, apiKey: "not-accepted" })).toBe(false);
    const validConfirmation = ajv.compile(
      confirmOperation.requestBody.content["application/json"].schema,
    );
    const input = {
      commandNumber: 1,
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 1,
    };
    expect(validConfirmation(input)).toBe(true);
    for (const invalid of [
      { ...input, commandNumber: 0 },
      { ...input, expectedRevision: 0 },
      { ...input, paymentIntentId: "pi_other" },
      { ...input, mockPaymentMethodRef: "pm_real_card" },
    ])
      expect(validConfirmation(invalid)).toBe(false);
    const orderResponse = await post(
      merchant.url,
      "/merchant-a/orders",
      orderBody,
    );
    expect(orderResponse.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await orderResponse.json();
    const orderSchema = media.assert(orderOperation.responses["201"]);
    expect(
      ajv.compile(orderSchema.content["application/json"].schema)(body),
    ).toBe(true);
    const order = orderIdentity.assert(body);
    verifyResponseHeaders({
      documented: orderOperation.responses["201"],
      response: orderResponse,
      names: securityHeaders,
    });
    const creation = await post(
      merchant.url,
      `/merchant-a/orders/${order.id}/payment`,
    );
    expect(creation.status).toBe(201);
    verifyResponseHeaders({
      documented: creationOperation.responses["201"],
      response: creation,
      names: acknowledgmentHeaders,
    });
    const replay = await post(
      merchant.url,
      `/merchant-a/orders/${order.id}/commands/${creation.headers.get("x-merchant-command-id")}/recover`,
    );
    verifyResponseHeaders({
      documented: recoveryOperation.responses["201"],
      response: replay,
      names: acknowledgmentHeaders,
    });
    const lookup = await fetch(
      `${merchant.url}/merchant-a/orders/${order.id}/payment`,
    );
    verifyResponseHeaders({
      documented: lookupOperation.responses["200"],
      response: lookup,
      names: securityHeaders,
    });
    const confirmed = await post(
      merchant.url,
      `/merchant-a/orders/${order.id}/confirm`,
      input,
    );
    expect(confirmed.status).toBe(202);
    expect(confirmed.headers.get("location")).toContain(
      "/v1/payment-intents/pi_",
    );
    expect(confirmed.headers.get("x-merchant-command-id")).toMatch(/^mc_/);
    verifyResponseHeaders({
      documented: confirmOperation.responses["202"],
      response: confirmed,
      names: acknowledgmentHeaders,
    });
    const confirmSchema = media.assert(confirmOperation.responses["202"]);
    expect(
      ajv.compile(confirmSchema.content["application/json"].schema)(
        await confirmed.json(),
      ),
    ).toBe(true);
    const large = await post(merchant.url, "/merchant-a/orders", {
      ...orderBody,
      description: "x".repeat(20_000),
    });
    expect(large.status).toBe(413);
    await compareResponse({
      contract: document,
      path: "/{merchantFixture}/orders",
      method: "post",
      response: large.clone(),
      status: 413,
    });
    expect(orderOperation.responses["413"]).toBeDefined();
    verifyResponseHeaders({
      documented: orderOperation.responses["413"],
      response: large,
      names: securityHeaders,
    });
  } finally {
    await merchant.stop();
  }
});
