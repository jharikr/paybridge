import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";

const ready = type({ kind: "'ready'", url: "string" });
const entrypoint = fileURLToPath(new URL("./proof/server.ts", import.meta.url));

test("router rejections use the documented JSON error envelope without echoing the path", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    const { url } = ready.assert(await server.message());
    for (const scenario of [
      { path: `/proof/${"p".repeat(101)}`, status: 414 },
      { path: "/proof/%ZZ", status: 400 },
    ]) {
      const response = await fetch(`${url}${scenario.path}`);
      expect(response.status).toBe(scenario.status);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "The request is invalid.",
          requestId: expect.stringMatching(/^req_/),
        },
      });
    }
    expect(await (await fetch(`${url}/openapi.json`)).json()).toMatchObject({
      paths: {
        "/proof/{id}": {
          get: {
            responses: {
              "414": {
                content: { "application/json": { schema: expect.any(Object) } },
              },
            },
          },
        },
      },
    });
  } finally {
    await server.stop();
  }
});

test("a valid HTTP request commits the documented response and survives process restart", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    const { url } = ready.assert(await server.message());
    const response = await fetch(`${url}/proof/retained`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-proof-key": "synthetic",
      },
      body: JSON.stringify({ label: "Synthetic HTTP record", amount: 1250 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "retained",
      label: "Synthetic HTTP record",
      amount: 1250,
    });
  } finally {
    await server.stop();
  }
  const restarted = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    const { url } = ready.assert(await restarted.message());
    const response = await fetch(`${url}/proof/retained`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "retained",
      label: "Synthetic HTTP record",
      amount: 1250,
    });
  } finally {
    await restarted.stop();
  }
});

test("generated OpenAPI describes the real request validation and response serialization", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    const { url } = ready.assert(await server.message());
    const contract = type({
      openapi: "'3.1.0'",
      paths: {
        "/proof/{id}": {
          post: {
            parameters: "object[]",
            requestBody: {
              content: { "application/json": { schema: "object" } },
            },
            responses: {
              "201": { content: { "application/json": { schema: "object" } } },
              "400": { content: { "application/json": { schema: "object" } } },
              "415": { content: { "application/json": { schema: "object" } } },
            },
          },
          get: "object",
        },
      },
    }).assert(await (await fetch(`${url}/openapi.json`)).json());
    const post = contract.paths["/proof/{id}"].post;
    expect(post.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: "path",
          name: "id",
          required: true,
          description:
            "Runtime length is 1 to 32 UTF-16 code units. JSON Schema length counts Unicode code points.",
          schema: expect.objectContaining({ maxLength: 32 }),
        }),
        expect.objectContaining({
          in: "header",
          name: "x-proof-key",
          required: true,
          schema: expect.objectContaining({ enum: ["synthetic"] }),
        }),
      ]),
    );
    const jsonSchema = post.requestBody.content["application/json"].schema;
    expect(jsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        amount: { minimum: 1, maximum: 9007199254740991, type: "integer" },
        label: {
          minLength: 1,
          maxLength: 80,
          description:
            "Runtime rules: the label must contain at most 80 UTF-16 code units and have no leading or trailing whitespace. JSON Schema length counts Unicode code points.",
        },
      },
    });
    const ajv = new Ajv2020({ strict: false });
    const acceptsBody = ajv.compile(jsonSchema);
    const input = { label: "Documented record", amount: 1250 };
    expect(acceptsBody(input)).toBe(true);
    expect(acceptsBody({ ...input, amount: 0 })).toBe(false);
    expect(acceptsBody({ ...input, extra: true })).toBe(false);
    expect(acceptsBody({ label: "😀".repeat(41), amount: 1250 })).toBe(true);
    for (const scenario of [
      { id: "unicode-label-valid", label: "😀".repeat(40), status: 201 },
      { id: "unicode-label-invalid", label: "😀".repeat(41), status: 400 },
      { id: "😀".repeat(16), label: "Valid Unicode identifier", status: 201 },
      { id: "😀".repeat(17), label: "Invalid Unicode identifier", status: 400 },
    ]) {
      const response = await fetch(
        `${url}/proof/${encodeURIComponent(scenario.id)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-proof-key": "synthetic",
          },
          body: JSON.stringify({ label: scenario.label, amount: 1250 }),
        },
      );
      expect(response.status, scenario.id).toBe(scenario.status);
    }
    expect((await fetch(`${url}/proof/unicode-label-invalid`)).status).toBe(
      404,
    );
    const response = await fetch(`${url}/proof/documented`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-proof-key": "synthetic",
      },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const result: unknown = await response.json();
    expect(result).toEqual({
      id: "documented",
      label: "Documented record",
      amount: 1250,
    });
    expect(
      ajv.compile(post.responses["201"].content["application/json"].schema)(
        result,
      ),
    ).toBe(true);
    const invalid = await fetch(`${url}/proof/invalid`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-proof-key": "synthetic",
      },
      body: JSON.stringify({ label: "Invalid", amount: 0 }),
    });
    expect(invalid.status).toBe(400);
    expect(
      ajv.compile(post.responses["400"].content["application/json"].schema)(
        await invalid.json(),
      ),
    ).toBe(true);
    const unsupported = await fetch(`${url}/proof/unsupported`, {
      method: "POST",
      headers: {
        "content-type": "application/xml",
        "x-proof-key": "synthetic",
      },
      body: "<synthetic/>",
    });
    expect(unsupported.status).toBe(415);
    const unsupportedResult: unknown = await unsupported.json();
    expect(unsupportedResult).toEqual({
      error: {
        code: "invalid_request",
        message: "The request is invalid.",
        requestId: expect.stringMatching(/^req_/),
      },
    });
    expect(
      ajv.compile(post.responses["415"].content["application/json"].schema)(
        unsupportedResult,
      ),
    ).toBe(true);
    expect((await fetch(`${url}/proof/unsupported`)).status).toBe(404);
  } finally {
    await server.stop();
  }
});

test("invalid bodies, route parameters, headers, and runtime predicates return normalized errors without writes", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    const { url } = ready.assert(await server.message());
    const cases = [
      {
        id: "extra",
        body: { label: "Synthetic", amount: 10, pan: "synthetic-forbidden" },
        key: "synthetic",
        status: 400,
      },
      {
        id: "fraction",
        body: { label: "Synthetic", amount: 1.5 },
        key: "synthetic",
        status: 400,
      },
      {
        id: "unbounded",
        body: { label: "x".repeat(81), amount: 10 },
        key: "synthetic",
        status: 400,
      },
      {
        id: "negative",
        body: { label: "Synthetic", amount: -1 },
        key: "synthetic",
        status: 400,
      },
      {
        id: "unsafe",
        body: { label: "Synthetic", amount: 9007199254740992 },
        key: "synthetic",
        status: 400,
      },
      {
        id: "predicate",
        body: { label: " leading space", amount: 10 },
        key: "synthetic",
        status: 400,
      },
      {
        id: "header",
        body: { label: "Synthetic", amount: 10 },
        key: "wrong",
        status: 400,
      },
      {
        id: "missing-header",
        body: { label: "Synthetic", amount: 10 },
        key: "",
        status: 400,
      },
      {
        id: "body-limit",
        body: { label: "x".repeat(17000), amount: 10 },
        key: "synthetic",
        status: 413,
      },
      {
        id: "p".repeat(33),
        body: { label: "Synthetic", amount: 10 },
        key: "synthetic",
        status: 400,
      },
    ];
    for (const scenario of cases) {
      const response = await fetch(`${url}/proof/${scenario.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(scenario.key ? { "x-proof-key": scenario.key } : {}),
        },
        body: JSON.stringify(scenario.body),
      });
      expect(response.status, scenario.id).toBe(scenario.status);
      expect(await response.json(), scenario.id).toEqual({
        error: {
          code: "invalid_request",
          message: "The request is invalid.",
          requestId: expect.stringMatching(/^req_/),
        },
      });
      if (scenario.id.length <= 32)
        expect(
          (await fetch(`${url}/proof/${scenario.id}`)).status,
          scenario.id,
        ).toBe(404);
    }
  } finally {
    await server.stop();
  }
});
