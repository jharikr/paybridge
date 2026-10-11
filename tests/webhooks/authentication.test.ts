import { expect, test } from "vitest";
import { type } from "arktype";
import Ajv from "ajv/dist/2020.js";
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { verifyResponseHeaders } from "../merchant/support.ts";
import { webhookEvent } from "../../contracts/webhooks.ts";
import { epoch, payload, receiver, signed } from "./support.ts";

test("raw bytes, exact identity, schema, signatures, and both timestamp bounds protect receipts", async () => {
  await using files = await isolatedDatabases();
  const app = await receiver(files.merchant);
  const url = `${app.url}/api/webhooks/paybridge/merchant-a`;
  try {
    const base = signed(payload);
    const event = webhookEvent.assert(JSON.parse(payload));
    const altered = JSON.stringify({
      ...event,
      data: { ...event.data, amount: 7501 },
    });
    const invalidBodies = [
      "{",
      "\uFEFF" + payload,
      payload.replace(
        '{ "id":',
        '{ "id":"evt_33333333333333333333333333333333", "id":',
      ),
      JSON.stringify({
        ...event,
        createdAt: "2026-02-30T12:00:01Z",
      }),
      JSON.stringify({ ...event, id: "evt_wrong" }),
      JSON.stringify({ ...event, type: "payment.failed" }),
      JSON.stringify({ ...event, secret: "not-allowed" }),
      JSON.stringify({
        ...event,
        data: { ...event.data, revision: 0 },
      }),
      JSON.stringify({
        ...event,
        data: { ...event.data, cardNumber: "4111111111111111" },
      }),
    ];
    for (const body of invalidBodies)
      expect(
        (await fetch(url, { method: "POST", body, headers: signed(body) }))
          .status,
      ).toBe(400);
    const invalidUtf8 = Buffer.concat([
      Buffer.from(payload),
      Buffer.from([0xff]),
    ]);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: invalidUtf8,
          headers: signed(invalidUtf8),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(url, { method: "POST", body: altered, headers: base }))
        .status,
    ).toBe(401);
    for (const signature of [
      "v1=",
      base["paybridge-signature"].toUpperCase(),
      base["paybridge-signature"].slice(0, -2),
      `${base["paybridge-signature"]}00`,
      `v2=${"a".repeat(64)}`,
    ])
      expect(
        (
          await fetch(url, {
            method: "POST",
            body: payload,
            headers: { ...base, "paybridge-signature": signature },
          })
        ).status,
      ).toBe(401);
    for (const timestamp of [
      "0",
      String(epoch / 1000 - 301),
      String(epoch / 1000 + 301),
      "1e9",
      "-1",
      "0123",
      "9007199254740992",
    ])
      expect(
        (
          await fetch(url, {
            method: "POST",
            body: payload,
            headers: signed(payload, { timestamp }),
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: payload,
          headers: signed(payload, { secret: "mock-webhook-secret-b" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: payload,
          headers: {
            ...base,
            "paybridge-event-id": "evt_33333333333333333333333333333333",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: payload,
          headers: { ...base, "content-type": "text/plain" },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: payload,
          headers: {
            ...base,
            "content-type": "application/json; charset=utf-16",
          },
        })
      ).status,
    ).toBe(415);
    const large = `${payload}${" ".repeat(16384)}`;
    expect(
      (
        await fetch(url, {
          method: "POST",
          body: large,
          headers: signed(large),
        })
      ).status,
    ).toBe(413);
    expect(rows(files.merchant, "SELECT event_id FROM webhook_inbox")).toEqual(
      [],
    );
    for (const seconds of [-300, 300])
      expect(
        (
          await fetch(url, {
            method: "POST",
            body: payload,
            headers: signed(payload, {
              timestamp: String(epoch / 1000 + seconds),
            }),
          })
        ).status,
      ).toBe(204);
    expect(
      rows(files.merchant, "SELECT event_id FROM webhook_inbox"),
    ).toHaveLength(1);
    expect(app.output()).not.toMatch(
      /mock-webhook-secret|v1=[a-f0-9]{64}|Café/,
    );
  } finally {
    await app.stop();
  }
});

const receiverDocument = type({
  paths: {
    "/api/webhooks/paybridge/{merchantFixture}": {
      post: {
        parameters: type({
          in: "string",
          name: "string",
          "required?": "boolean",
          schema: "unknown",
        }).array(),
        requestBody: {
          description: "string",
          content: { "application/json": { schema: "object" } },
        },
        responses: { "[string]": "unknown" },
      },
    },
  },
});
const jsonResponse = type({
  content: { "application/json": { schema: "object" } },
});
test("the receiver OpenAPI describes signed JSON bytes and matches real responses", async () => {
  await using files = await isolatedDatabases();
  const app = await receiver(files.merchant);
  try {
    const document = receiverDocument.assert(
      await (await fetch(`${app.url}/openapi.json`)).json(),
    );
    const operation =
      document.paths["/api/webhooks/paybridge/{merchantFixture}"]?.post;
    if (!operation) throw new Error("Receiver operation is missing");
    expect(
      operation.parameters
        .filter((item) => item.in === "header")
        .map((item) => item.name)
        .sort(),
    ).toEqual([
      "paybridge-event-id",
      "paybridge-signature",
      "paybridge-timestamp",
    ]);
    expect(operation.requestBody.description).toContain("exact");
    expect(
      type({ "content?": "unknown" }).assert(operation.responses["204"])
        .content,
    ).toBeUndefined();
    const ajv = new Ajv.default({ strict: false });
    const validBody = ajv.compile(
      operation.requestBody.content["application/json"].schema,
    );
    expect(validBody(JSON.parse(payload))).toBe(true);
    expect(
      validBody({
        ...webhookEvent.assert(JSON.parse(payload)),
        type: "payment.failed",
      }),
    ).toBe(false);
    for (const parameter of operation.parameters.filter(
      (item) => item.in === "header",
    )) {
      expect(parameter.required).toBe(true);
      expect(
        ajv.compile(type("object").assert(parameter.schema))(
          new Headers(signed(payload)).get(parameter.name),
        ),
      ).toBe(true);
      expect(
        ajv.compile(type("object").assert(parameter.schema))("invalid"),
      ).toBe(false);
    }
    for (const status of ["400", "401", "409", "413", "415", "500", "503"])
      jsonResponse.assert(operation.responses[status]);
    const url = `${app.url}/api/webhooks/paybridge/merchant-a`;
    for (const [body, headers, status] of [
      [payload, signed(payload), 204],
      [
        payload,
        {
          ...signed(payload),
          "content-type": 'application/json; charset = "UTF-8"',
        },
        204,
      ],
      [payload, signed(payload), 204],
      [payload + " ", signed(payload + " "), 409],
      ["{", signed("{"), 400],
      [payload, signed(payload, { secret: "wrong" }), 401],
      [payload, { ...signed(payload), "content-type": "text/plain" }, 415],
      [payload + " ".repeat(16384), signed(payload + " ".repeat(16384)), 413],
    ] satisfies [string, Record<string, string>, number][]) {
      const response = await fetch(url, { method: "POST", headers, body });
      expect(response.status).toBe(status);
      verifyResponseHeaders({
        documented: operation.responses[String(status)],
        response,
        names: ["cache-control", "x-content-type-options"],
      });
      if (status === 204) expect(await response.text()).toBe("");
      else {
        expect(response.headers.get("content-type")).toBe(
          "application/json; charset=utf-8",
        );
        expect(
          ajv.compile(
            jsonResponse.assert(operation.responses[String(status)]).content[
              "application/json"
            ].schema,
          )(await response.json()),
        ).toBe(true);
      }
    }
  } finally {
    await app.stop();
  }
});

test("configured timestamp tolerance applies to both directions", async () => {
  await using files = await isolatedDatabases();
  const app = await receiver(files.merchant, "none", 1);
  try {
    for (const seconds of [-2, 2, -1, 1]) {
      const response = await fetch(
        `${app.url}/api/webhooks/paybridge/merchant-a`,
        {
          method: "POST",
          body: payload,
          headers: signed(payload, {
            timestamp: String(epoch / 1000 + seconds),
          }),
        },
      );
      expect(response.status).toBe(Math.abs(seconds) <= 1 ? 204 : 401);
    }
  } finally {
    await app.stop();
  }
});
