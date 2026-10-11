import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";

const entrypoint = fileURLToPath(
  new URL("../../apps/paybridge/server.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const documentedResponse = type({
  content: { "application/json": { schema: "object" } },
  "headers?": "object",
});
const document = type({
  components: { securitySchemes: "object" },
  paths: {
    "/v1/payment-intents": {
      post: {
        security: "object[]",
        parameters: "object[]",
        requestBody: { content: { "application/json": { schema: "object" } } },
        responses: {
          "201": documentedResponse,
          "400": documentedResponse,
          "401": documentedResponse,
          "409": documentedResponse,
          "503": documentedResponse,
        },
      },
    },
    "/v1/payment-intents/{paymentId}": {
      get: {
        security: "object[]",
        responses: { "200": documentedResponse, "404": documentedResponse },
      },
    },
  },
});

test("OpenAPI matches creation, authentication, lookup, bounds, headers, and stable errors", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const contract = document.assert(
      await (await fetch(`${url}/openapi.json`)).json(),
    );
    expect(contract.components.securitySchemes).toEqual({
      merchantCredential: {
        type: "http",
        scheme: "bearer",
        description:
          "Server-side Paybridge merchant API credential. Provider merchant keys are not accepted.",
      },
    });
    const post = contract.paths["/v1/payment-intents"].post;
    expect(post.security).toEqual([{ merchantCredential: [] }]);
    expect(post.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "idempotency-key",
        required: true,
        schema: expect.objectContaining({ minLength: 1, maxLength: 128 }),
      }),
    );
    expect(post.responses["201"].headers).toMatchObject({
      location: { schema: { type: "string" } },
      "cache-control": { schema: { const: "no-store" } },
    });
    expect(post.responses["409"].headers).toMatchObject({
      "retry-after": {
        schema: { type: "string", const: "1" },
        description: expect.stringContaining("command_in_progress"),
      },
    });
    expect(post.responses["503"].headers).toMatchObject({
      "retry-after": { schema: { type: "string", const: "1" } },
    });
    const ajv = new Ajv2020({ strict: false });
    const acceptsInput = ajv.compile(
      post.requestBody.content["application/json"].schema,
    );
    const input = {
      merchantReference: "SCHEMA-1",
      amount: 7500,
      currency: "XCD",
      returnUrl: "http://127.0.0.1:3101/payment-return",
    };
    expect(acceptsInput(input)).toBe(true);
    expect(acceptsInput({ ...input, amount: 0 })).toBe(false);
    expect(acceptsInput({ ...input, amount: 10_000_000_000 })).toBe(false);
    expect(acceptsInput({ ...input, currency: "USD" })).toBe(false);
    expect(acceptsInput({ ...input, merchantReference: "\ud800" })).toBe(false);
    expect(acceptsInput({ ...input, description: "\u0000" })).toBe(false);
    expect(acceptsInput({ ...input, merchantReference: "Café 😀" })).toBe(true);
    expect(acceptsInput({ ...input, pan: "synthetic-forbidden" })).toBe(false);
    expect(post.requestBody.content["application/json"].schema).toMatchObject({
      properties: {
        amount: { description: expect.stringContaining("two decimal places") },
        returnUrl: {
          description: expect.stringContaining("configured return origin"),
        },
      },
    });
    const headers = {
      authorization: "Bearer mock-paybridge-key-a",
      "idempotency-key": "documented",
      "content-type": "application/json",
    };
    const accepted = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(accepted.status).toBe(201);
    const body: unknown = await accepted.json();
    expect(
      ajv.compile(post.responses["201"].content["application/json"].schema)(
        body,
      ),
    ).toBe(true);
    const { id } = type({ id: "string" }).assert(body);
    const get = contract.paths["/v1/payment-intents/{paymentId}"].get;
    const lookup = await fetch(`${url}/v1/payment-intents/${id}`, { headers });
    expect(lookup.status).toBe(200);
    expect(
      ajv.compile(get.responses["200"].content["application/json"].schema)(
        await lookup.json(),
      ),
    ).toBe(true);
    for (const scenario of [
      { headers, body: { ...input, amount: 0 }, status: "400" },
      {
        headers: { ...headers, authorization: "Bearer wrong" },
        body: input,
        status: "401",
      },
    ] satisfies {
      headers: typeof headers;
      body: typeof input;
      status: "400" | "401";
    }[]) {
      const rejected = await fetch(`${url}/v1/payment-intents`, {
        method: "POST",
        headers: scenario.headers,
        body: JSON.stringify(scenario.body),
      });
      expect(rejected.status).toBe(Number(scenario.status));
      expect(
        ajv.compile(
          post.responses[scenario.status].content["application/json"].schema,
        )(await rejected.json()),
      ).toBe(true);
    }
    const unicode = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "unicode" },
      body: JSON.stringify({ ...input, merchantReference: "😀".repeat(65) }),
    });
    expect(acceptsInput({ ...input, merchantReference: "😀".repeat(65) })).toBe(
      true,
    );
    expect(unicode.status).toBe(400);
  } finally {
    await server.stop();
  }
});

test("OpenAPI matches confirmation acceptance, errors, latest attempt snapshots, and bodyless cancellation", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const commandDocument = type({
      paths: {
        "/v1/payment-intents/{paymentId}/confirm": {
          post: {
            security: "object[]",
            parameters: "object[]",
            requestBody: {
              content: { "application/json": { schema: "object" } },
            },
            responses: {
              "202": documentedResponse,
              "400": documentedResponse,
              "409": documentedResponse,
            },
          },
        },
        "/v1/payment-intents/{paymentId}/cancel": {
          post: {
            security: "object[]",
            responses: { "200": documentedResponse, "409": documentedResponse },
          },
        },
        "/v1/payment-intents/{paymentId}": {
          get: { responses: { "200": documentedResponse } },
        },
      },
    }).assert(await (await fetch(`${url}/openapi.json`)).json());
    const post =
      commandDocument.paths["/v1/payment-intents/{paymentId}/confirm"].post;
    expect(post.security).toEqual([{ merchantCredential: [] }]);
    expect(post.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "idempotency-key",
        required: true,
      }),
    );
    expect(post.responses["202"].headers).toMatchObject({
      location: { schema: { type: "string" } },
      "cache-control": { schema: { const: "no-store" } },
    });
    const ajv = new Ajv2020({ strict: false });
    const validates = ajv.compile(
      post.requestBody.content["application/json"].schema,
    );
    expect(
      validates({
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
      }),
    ).toBe(true);
    for (const invalid of [
      { mockPaymentMethodRef: "pm_mock_approved" },
      { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 0 },
      {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 9007199254740992,
      },
      { mockPaymentMethodRef: "unknown", expectedRevision: 1 },
      {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
        pan: "4111111111111111",
      },
    ])
      expect(validates(invalid)).toBe(false);
    const headers = {
      authorization: "Bearer mock-paybridge-key-a",
      "idempotency-key": "documented-create",
      "content-type": "application/json",
    };
    const creation = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        merchantReference: "DOCUMENTED-COMMAND",
        amount: 100,
        currency: "XCD",
        returnUrl: "http://127.0.0.1:3101/payment-return",
      }),
    });
    expect(creation.status).toBe(201);
    const { id } = type({ id: "string" }).assert(await creation.json());
    const confirmation = await fetch(
      `${url}/v1/payment-intents/${id}/confirm`,
      {
        method: "POST",
        headers: { ...headers, "idempotency-key": "documented-confirm" },
        body: JSON.stringify({
          mockPaymentMethodRef: "pm_mock_approved",
          expectedRevision: 1,
        }),
      },
    );
    expect(confirmation.status).toBe(202);
    expect(
      ajv.compile(post.responses["202"].content["application/json"].schema)(
        await confirmation.json(),
      ),
    ).toBe(true);
    const lookup = await fetch(`${url}/v1/payment-intents/${id}`, { headers });
    const snapshot = await lookup.json();
    expect(snapshot).toMatchObject({
      status: "PROCESSING",
      revision: 2,
      latestAttempt: { attemptNumber: 1, status: "PROCESSING" },
    });
    expect(
      ajv.compile(
        commandDocument.paths["/v1/payment-intents/{paymentId}"].get.responses[
          "200"
        ].content["application/json"].schema,
      )(snapshot),
    ).toBe(true);
    const cancelled =
      commandDocument.paths["/v1/payment-intents/{paymentId}/cancel"].post;
    expect(cancelled).not.toHaveProperty("requestBody");
    const cancellation = await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
      method: "POST",
      headers: { authorization: headers.authorization },
    });
    expect(cancellation.status).toBe(409);
    expect(
      ajv.compile(
        cancelled.responses["409"].content["application/json"].schema,
      )(await cancellation.json()),
    ).toBe(true);
    const second = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "documented-cancel" },
      body: JSON.stringify({
        merchantReference: "DOCUMENTED-CANCEL",
        amount: 100,
        currency: "XCD",
        returnUrl: "http://127.0.0.1:3101/payment-return",
      }),
    });
    const secondId = type({ id: "string" }).assert(await second.json()).id;
    const result = await fetch(`${url}/v1/payment-intents/${secondId}/cancel`, {
      method: "POST",
      headers: { authorization: headers.authorization },
    });
    expect(result.status).toBe(200);
    expect(
      ajv.compile(
        cancelled.responses["200"].content["application/json"].schema,
      )(await result.json()),
    ).toBe(true);
  } finally {
    await server.stop();
  }
});
