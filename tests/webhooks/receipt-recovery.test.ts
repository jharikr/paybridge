import { expect, test } from "vitest";
import { type } from "arktype";
import Ajv from "ajv/dist/2020.js";
import { verifyResponseHeaders } from "../merchant/support.ts";
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { payload, receiver, signed } from "./support.ts";

async function verifyFailure(url: string, response: Response) {
  const document = type({
    paths: {
      "/api/webhooks/paybridge/{merchantFixture}": {
        post: { responses: { "[string]": "unknown" } },
      },
    },
  }).assert(await (await fetch(`${url}/openapi.json`)).json());
  const documented =
    document.paths["/api/webhooks/paybridge/{merchantFixture}"].post.responses[
      String(response.status)
    ];
  const media = type({
    content: { "application/json": { schema: "object" } },
  }).assert(documented);
  expect(
    new Ajv.default({ strict: false }).compile(
      media.content["application/json"].schema,
    )(await response.json()),
  ).toBe(true);
  verifyResponseHeaders({
    documented,
    response,
    names: [
      "cache-control",
      "x-content-type-options",
      ...(response.status === 503 ? ["retry-after"] : []),
    ],
  });
}

test.each([
  "before-receipt-commit",
  "after-receipt-commit",
  "after-acknowledgment",
])(
  "a real receiver kill %s retains the correct receipt and restart accepts exact redelivery",
  async (fault) => {
    await using files = await isolatedDatabases();
    const first = await receiver(files.merchant, fault);
    try {
      const pending = fetch(`${first.url}/api/webhooks/paybridge/merchant-a`, {
        method: "POST",
        headers: signed(payload),
        body: payload,
      }).catch(() => null);
      if (fault === "after-acknowledgment")
        expect((await pending)?.status).toBe(204);
      else
        expect(
          type({ kind: "string" }).assert(await first.message()).kind,
        ).toBe(fault);
      expect(
        rows(files.merchant, "SELECT event_id FROM webhook_inbox"),
      ).toHaveLength(fault === "before-receipt-commit" ? 0 : 1);
      await first.stop();
      if (fault !== "after-acknowledgment") expect(await pending).toBeNull();
      const second = await receiver(files.merchant);
      try {
        expect(
          (
            await fetch(`${second.url}/api/webhooks/paybridge/merchant-a`, {
              method: "POST",
              headers: signed(payload),
              body: payload,
            })
          ).status,
        ).toBe(204);
        expect(
          rows(
            files.merchant,
            "SELECT payload,status,attempt_count FROM webhook_inbox",
          ),
        ).toEqual([{ payload, status: "PENDING", attempt_count: 0 }]);
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
    }
  },
);

test("receipt rollback sends no successful acknowledgment and leaves redelivery possible", async () => {
  await using files = await isolatedDatabases();
  const first = await receiver(files.merchant, "rollback");
  try {
    const response = await fetch(
      `${first.url}/api/webhooks/paybridge/merchant-a`,
      {
        method: "POST",
        headers: signed(payload),
        body: payload,
      },
    );
    expect(response.status).toBe(500);
    await verifyFailure(first.url, response);
    expect(rows(files.merchant, "SELECT event_id FROM webhook_inbox")).toEqual(
      [],
    );
  } finally {
    await first.stop();
  }
  const second = await receiver(files.merchant);
  try {
    expect(
      (
        await fetch(`${second.url}/api/webhooks/paybridge/merchant-a`, {
          method: "POST",
          headers: signed(payload),
          body: payload,
        })
      ).status,
    ).toBe(204);
  } finally {
    await second.stop();
  }
});

test("receipt write contention returns a bounded retry response and no false acknowledgment", async () => {
  await using files = await isolatedDatabases();
  const first = await receiver(files.merchant, "before-receipt-commit");
  const second = await receiver(files.merchant);
  try {
    const pending = fetch(`${first.url}/api/webhooks/paybridge/merchant-a`, {
      method: "POST",
      headers: signed(payload),
      body: payload,
    }).catch(() => null);
    expect(type({ kind: "string" }).assert(await first.message()).kind).toBe(
      "before-receipt-commit",
    );
    const start = Date.now();
    const response = await fetch(
      `${second.url}/api/webhooks/paybridge/merchant-a`,
      { method: "POST", headers: signed(payload), body: payload },
    );
    expect(response.status).toBe(503);
    expect(Date.now() - start).toBeLessThan(6500);
    await verifyFailure(second.url, response);
    expect(rows(files.merchant, "SELECT event_id FROM webhook_inbox")).toEqual(
      [],
    );
    await first.stop();
    expect(await pending).toBeNull();
    expect(
      (
        await fetch(`${second.url}/api/webhooks/paybridge/merchant-a`, {
          method: "POST",
          headers: signed(payload),
          body: payload,
        })
      ).status,
    ).toBe(204);
    expect(
      rows(files.merchant, "SELECT payload,status FROM webhook_inbox"),
    ).toEqual([{ payload, status: "PENDING" }]);
  } finally {
    await first.stop();
    await second.stop();
  }
}, 15000);

test("competing receivers retain one receipt across identical and conflicting deliveries", async () => {
  await using files = await isolatedDatabases();
  const first = await receiver(files.merchant);
  const second = await receiver(files.merchant);
  try {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fetch(
          `${index % 2 ? first.url : second.url}/api/webhooks/paybridge/merchant-a`,
          { method: "POST", headers: signed(payload), body: payload },
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(12).fill(204),
    );
    const different = payload + " ";
    const conflicts = await Promise.all([
      fetch(`${first.url}/api/webhooks/paybridge/merchant-a`, {
        method: "POST",
        headers: signed(different),
        body: different,
      }),
      fetch(`${second.url}/api/webhooks/paybridge/merchant-b`, {
        method: "POST",
        headers: signed(payload, { secret: "mock-webhook-secret-b" }),
        body: payload,
      }),
    ]);
    expect(conflicts.map((response) => response.status)).toEqual([409, 409]);
    expect(
      rows(
        files.merchant,
        "SELECT payload,receiving_merchant_id FROM webhook_inbox",
      ),
    ).toEqual([{ payload, receiving_merchant_id: "merchant-a" }]);
  } finally {
    await first.stop();
    await second.stop();
  }
});
