import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { contractAt, compareResponse } from "../contracts/support.ts";

const entrypoint = fileURLToPath(
  new URL("../../apps/paybridge/server.ts", import.meta.url),
);
const faultEntrypoint = fileURLToPath(
  new URL("./fixtures/server.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const created = type({
  id: "string",
  checkoutUrl: "string",
  status: "'PENDING'",
  revision: "1",
});
const input = {
  merchantReference: "RECOVER-1",
  amount: 1500,
  currency: "XCD",
  returnUrl: "http://127.0.0.1:3101/payment-return",
};
const headers = {
  authorization: "Bearer mock-paybridge-key-a",
  "content-type": "application/json",
  "idempotency-key": "recovered-command",
};
const create = (url: string) =>
  fetch(`${url}/v1/payment-intents`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
function retainedCounts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      payments: db
        .prepare("SELECT COUNT(*) AS count FROM payment_intents")
        .get(),
      events: db.prepare("SELECT COUNT(*) AS count FROM payment_events").get(),
      commands: db
        .prepare(
          "SELECT status, COUNT(*) AS count FROM idempotency_keys GROUP BY status",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

test("two processes accept concurrent identical creations as one durable command", async () => {
  await using files = await isolatedDatabases();
  const first = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  const { url: firstUrl } = ready.assert(await first.message());
  const second = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url: secondUrl } = ready.assert(await second.message());
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        create(index % 2 === 0 ? firstUrl : secondUrl),
      ),
    );
    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(201);
        return response.text();
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(retainedCounts(files.paybridge)).toEqual({
      payments: { count: 1 },
      events: { count: 1 },
      commands: [{ status: "COMPLETED", count: 1 }],
    });
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("a failure after creation writes rolls back payment, history, and key together", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({
    entrypoint: faultEntrypoint,
    args: [files.paybridge, "rollback"],
  });
  try {
    const { url } = ready.assert(await server.message());
    const failed = await create(url);
    expect(failed.status).toBe(500);
    await compareResponse({
      contract: await contractAt(url),
      path: "/v1/payment-intents",
      method: "post",
      response: failed.clone(),
      status: 500,
    });
    expect(await failed.json()).toMatchObject({
      error: { code: "internal_error" },
    });
    expect(retainedCounts(files.paybridge)).toEqual({
      payments: { count: 0 },
      events: { count: 0 },
      commands: [],
    });
    const recovered = await create(url);
    expect(recovered.status).toBe(201);
    expect(created.assert(await recovered.json()).revision).toBe(1);
    expect(retainedCounts(files.paybridge)).toEqual({
      payments: { count: 1 },
      events: { count: 1 },
      commands: [{ status: "COMPLETED", count: 1 }],
    });
    expect(server.output()).not.toContain("mock-paybridge-key");
    expect(server.output()).not.toContain("checkout");
    expect(server.output()).not.toContain(input.returnUrl);
  } finally {
    await server.stop();
  }
});

test("writer timeout is bounded and a killed precommit command leaves its key reusable", async () => {
  await using files = await isolatedDatabases();
  const held = startNodeProcess({
    entrypoint: faultEntrypoint,
    args: [files.paybridge, "before-commit"],
  });
  const { url: heldUrl } = ready.assert(await held.message());
  const other = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url: otherUrl } = ready.assert(await other.message());
    const lost = create(heldUrl).then(
      () => "unexpected-response",
      () => "connection-lost",
    );
    expect(await held.message()).toEqual({ kind: "before-commit" });
    const started = Date.now();
    const busy = await create(otherUrl);
    const busyResponse = busy.clone();
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toMatchObject({
      error: { code: "temporarily_unavailable" },
    });
    expect(Date.now() - started).toBeLessThan(8000);
    await compareResponse({
      contract: await contractAt(otherUrl),
      path: "/v1/payment-intents",
      method: "post",
      response: busyResponse,
      status: 503,
      headers: ["cache-control", "x-content-type-options", "retry-after"],
    });
    await held.stop();
    expect(await lost).toBe("connection-lost");
    expect(retainedCounts(files.paybridge)).toEqual({
      payments: { count: 0 },
      events: { count: 0 },
      commands: [],
    });
    const recovered = await create(otherUrl);
    expect(recovered.status).toBe(201);
    expect(retainedCounts(files.paybridge)).toEqual({
      payments: { count: 1 },
      events: { count: 1 },
      commands: [{ status: "COMPLETED", count: 1 }],
    });
  } finally {
    await Promise.all([held.stop(), other.stop()]);
  }
}, 15_000);

test("a lost acknowledgment is replayed byte-for-byte after the accepting process is killed", async () => {
  await using files = await isolatedDatabases();
  const original = startNodeProcess({
    entrypoint: faultEntrypoint,
    args: [files.paybridge, "after-commit"],
  });
  let responseBody = "";
  try {
    const { url } = ready.assert(await original.message());
    const lost = create(url).then(
      () => "unexpected-response",
      () => "connection-lost",
    );
    expect(await original.message()).toEqual({ kind: "after-commit" });
    await original.stop();
    expect(await lost).toBe("connection-lost");
    const db = new DatabaseSync(files.paybridge, { readOnly: true });
    try {
      responseBody = type({ response_body: "string" }).assert(
        db.prepare("SELECT response_body FROM idempotency_keys").get(),
      ).response_body;
    } finally {
      db.close();
    }
  } finally {
    await original.stop();
  }
  const restarted = startNodeProcess({
    entrypoint,
    args: [files.paybridge, "0"],
  });
  try {
    const { url } = ready.assert(await restarted.message());
    const replay = await create(url);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(responseBody);
    const payment = created.assert(JSON.parse(responseBody));
    const lookup = await fetch(`${url}/v1/payment-intents/${payment.id}`, {
      headers,
    });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      id: payment.id,
      status: "PENDING",
      revision: 1,
      latestAttempt: null,
    });
    expect(retainedCounts(files.paybridge)).toEqual({
      payments: { count: 1 },
      events: { count: 1 },
      commands: [{ status: "COMPLETED", count: 1 }],
    });
  } finally {
    await restarted.stop();
  }
});
