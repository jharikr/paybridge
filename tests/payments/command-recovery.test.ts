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
const fixture = fileURLToPath(
  new URL("./fixtures/command-server.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const created = type({ id: "string" });
const headers = {
  authorization: "Bearer mock-paybridge-key-a",
  "content-type": "application/json",
};
async function launch({
  path,
  fault,
}: {
  path: string;
  fault?: {
    operation: "confirm" | "cancel";
    kind: "rollback" | "before-commit" | "after-commit";
  };
}) {
  const server = startNodeProcess({
    entrypoint: fault ? fixture : entrypoint,
    args: fault ? [path, fault.operation, fault.kind] : [path, "0"],
  });
  try {
    return { ...server, url: ready.assert(await server.message()).url };
  } catch (error) {
    await server.stop();
    throw error;
  }
}
async function create({
  url,
  key = "create-1",
}: {
  url: string;
  key?: string;
}) {
  const response = await fetch(`${url}/v1/payment-intents`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify({
      merchantReference: key,
      amount: 1500,
      currency: "XCD",
      returnUrl: "http://127.0.0.1:3101/payment-return",
    }),
  });
  expect(response.status).toBe(201);
  return created.assert(await response.json()).id;
}
function confirm({
  url,
  id,
  key = "confirm-1",
}: {
  url: string;
  id: string;
  key?: string;
}) {
  return fetch(`${url}/v1/payment-intents/${id}/confirm`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify({
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 1,
    }),
  });
}
function cancel({ url, id }: { url: string; id: string }) {
  return fetch(`${url}/v1/payment-intents/${id}/cancel`, {
    method: "POST",
    headers: { authorization: headers.authorization },
  });
}
function state(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      payments: db
        .prepare("SELECT status, revision FROM payment_intents ORDER BY id")
        .all(),
      attempts: db
        .prepare(
          "SELECT id, attempt_number, provider_transaction_id, status FROM payment_attempts",
        )
        .all(),
      work: db
        .prepare("SELECT payment_attempt_id, status FROM provider_outbox")
        .all(),
      commands: db
        .prepare(
          "SELECT key, status, payment_attempt_id FROM idempotency_keys ORDER BY key",
        )
        .all(),
      events: db
        .prepare(
          "SELECT type, intent_revision FROM payment_events ORDER BY intent_revision, type",
        )
        .all(),
      webhooks: db.prepare("SELECT payload, status FROM webhook_outbox").all(),
    };
  } finally {
    db.close();
  }
}

test("concurrent identical confirmations replay one durable acceptance across processes", async () => {
  await using files = await isolatedDatabases();
  const first = await launch({ path: files.paybridge });
  const second = await launch({ path: files.paybridge });
  try {
    const id = await create({ url: first.url });
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        confirm({ url: index % 2 ? first.url : second.url, id }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(12).fill(202),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.text()),
    );
    expect(new Set(bodies).size).toBe(1);
    const retained = state(files.paybridge);
    expect(retained.payments).toEqual([{ status: "PROCESSING", revision: 2 }]);
    expect(retained.attempts).toHaveLength(1);
    expect(retained.work).toHaveLength(1);
    expect(retained.commands.map((row) => [row.key, row.status])).toEqual([
      ["confirm-1", "COMPLETED"],
      ["create-1", "COMPLETED"],
    ]);
    expect(retained.events).toEqual([
      { type: "PAYMENT_CREATED", intent_revision: 1 },
      { type: "ATTEMPT_CREATED", intent_revision: 2 },
    ]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("different-key confirmations based on one revision accept one attempt and roll back losing reservations", async () => {
  await using files = await isolatedDatabases();
  const first = await launch({ path: files.paybridge });
  const second = await launch({ path: files.paybridge });
  try {
    const id = await create({ url: first.url });
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        confirm({
          url: index % 2 ? first.url : second.url,
          id,
          key: `confirmation-${index}`,
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 202),
    ).toHaveLength(1);
    const conflicts = responses.filter((response) => response.status !== 202);
    expect(conflicts).toHaveLength(11);
    for (const response of conflicts) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "payment_revision_conflict" },
      });
    }
    const retained = state(files.paybridge);
    expect(retained.attempts).toHaveLength(1);
    expect(retained.work).toHaveLength(1);
    expect(retained.commands).toHaveLength(2);
    expect(retained.commands.every((row) => row.status === "COMPLETED")).toBe(
      true,
    );
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("racing merchant cancellation and confirmation commits only the winning transition", async () => {
  await using files = await isolatedDatabases();
  const first = await launch({ path: files.paybridge });
  const second = await launch({ path: files.paybridge });
  try {
    const id = await create({ url: first.url });
    const [confirmation, cancellation] = await Promise.all([
      confirm({ url: first.url, id }),
      cancel({ url: second.url, id }),
    ]);
    const retained = state(files.paybridge);
    if (confirmation.status === 202) {
      expect(cancellation.status).toBe(409);
      expect(await cancellation.json()).toMatchObject({
        error: { code: "payment_not_cancellable" },
      });
      expect(retained.payments).toEqual([
        { status: "PROCESSING", revision: 2 },
      ]);
      expect(retained.attempts).toHaveLength(1);
      expect(retained.work).toHaveLength(1);
      expect(retained.commands).toHaveLength(2);
      expect(retained.webhooks).toEqual([]);
      expect(retained.events).toEqual([
        { type: "PAYMENT_CREATED", intent_revision: 1 },
        { type: "ATTEMPT_CREATED", intent_revision: 2 },
      ]);
    } else {
      expect(confirmation.status).toBe(409);
      expect(await confirmation.json()).toMatchObject({
        error: { code: "payment_revision_conflict" },
      });
      expect(cancellation.status).toBe(200);
      expect(retained.payments).toEqual([{ status: "CANCELLED", revision: 2 }]);
      expect(retained.attempts).toEqual([]);
      expect(retained.work).toEqual([]);
      expect(retained.commands.map((row) => row.key)).toEqual(["create-1"]);
      expect(retained.webhooks).toHaveLength(1);
      expect(retained.events).toEqual([
        { type: "PAYMENT_CREATED", intent_revision: 1 },
        { type: "PAYMENT_CANCELLED", intent_revision: 2 },
      ]);
    }
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

for (const operation of ["confirm", "cancel"] as const) {
  test(`${operation} rollback retains the original payment and leaves no partial work`, async () => {
    await using files = await isolatedDatabases();
    const server = await launch({
      path: files.paybridge,
      fault: {
        operation,
        kind: "rollback",
      },
    });
    try {
      const id = await create({ url: server.url });
      const command = operation === "confirm" ? confirm : cancel;
      const failed = await command({ url: server.url, id });
      expect(failed.status).toBe(500);
      await compareResponse({
        contract: await contractAt(server.url),
        path: `/v1/payment-intents/{paymentId}/${operation}`,
        method: "post",
        response: failed.clone(),
        status: 500,
      });
      expect(await failed.json()).toMatchObject({
        error: { code: "internal_error" },
      });
      expect(state(files.paybridge)).toEqual({
        payments: [{ status: "PENDING", revision: 1 }],
        attempts: [],
        work: [],
        commands: [
          { key: "create-1", status: "COMPLETED", payment_attempt_id: null },
        ],
        events: [{ type: "PAYMENT_CREATED", intent_revision: 1 }],
        webhooks: [],
      });
      const retried = await command({ url: server.url, id });
      expect(retried.status).toBe(operation === "confirm" ? 202 : 200);
      expect(state(files.paybridge).payments).toEqual([
        {
          status: operation === "confirm" ? "PROCESSING" : "CANCELLED",
          revision: 2,
        },
      ]);
      expect(server.output()).not.toMatch(
        /mock-paybridge-key|mock-provider-key|checkout|pm_mock_approved/,
      );
    } finally {
      await server.stop();
    }
  });
}

test("a killed precommit confirmation releases bounded contention without retaining an attempt or command key", async () => {
  await using files = await isolatedDatabases();
  const held = await launch({
    path: files.paybridge,
    fault: {
      operation: "confirm",
      kind: "before-commit",
    },
  });
  const other = await launch({ path: files.paybridge });
  try {
    const id = await create({ url: held.url });
    const interrupted = confirm({ url: held.url, id }).then(
      () => "unexpected-response",
      () => "connection-lost",
    );
    expect(await held.message()).toEqual({ kind: "before-commit" });
    const started = performance.now();
    const blocked = await confirm({ url: other.url, id });
    const blockedResponse = blocked.clone();
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(await blocked.json()).toMatchObject({
      error: { code: "temporarily_unavailable" },
    });
    expect(performance.now() - started).toBeLessThan(8000);
    await compareResponse({
      contract: await contractAt(other.url),
      path: "/v1/payment-intents/{paymentId}/confirm",
      method: "post",
      response: blockedResponse,
      status: 503,
      headers: ["cache-control", "x-content-type-options", "retry-after"],
    });
    await held.stop();
    expect(await interrupted).toBe("connection-lost");
    expect(state(files.paybridge)).toEqual({
      payments: [{ status: "PENDING", revision: 1 }],
      attempts: [],
      work: [],
      commands: [
        { key: "create-1", status: "COMPLETED", payment_attempt_id: null },
      ],
      events: [{ type: "PAYMENT_CREATED", intent_revision: 1 }],
      webhooks: [],
    });
    expect((await confirm({ url: other.url, id })).status).toBe(202);
    expect(state(files.paybridge).attempts).toHaveLength(1);
    expect(
      state(files.paybridge).commands.map((row) => [row.key, row.status]),
    ).toEqual([
      ["confirm-1", "COMPLETED"],
      ["create-1", "COMPLETED"],
    ]);
  } finally {
    await Promise.all([held.stop(), other.stop()]);
  }
}, 15_000);

test("a lost confirmation acknowledgment replays its exact committed attempt after process restart", async () => {
  await using files = await isolatedDatabases();
  const original = await launch({
    path: files.paybridge,
    fault: {
      operation: "confirm",
      kind: "after-commit",
    },
  });
  let id = "";
  let cached = "";
  let committed: ReturnType<typeof state>;
  try {
    id = await create({ url: original.url });
    const lost = confirm({ url: original.url, id }).then(
      () => "unexpected-response",
      () => "connection-lost",
    );
    expect(await original.message()).toEqual({ kind: "after-commit" });
    committed = state(files.paybridge);
    const db = new DatabaseSync(files.paybridge, { readOnly: true });
    try {
      cached = type({ response_body: "string" }).assert(
        db
          .prepare(
            "SELECT response_body FROM idempotency_keys WHERE key = 'confirm-1'",
          )
          .get(),
      ).response_body;
    } finally {
      db.close();
    }
    await original.stop();
    expect(await lost).toBe("connection-lost");
  } finally {
    await original.stop();
  }
  const restarted = await launch({ path: files.paybridge });
  try {
    const replay = await confirm({ url: restarted.url, id });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("location")).toBe(`/v1/payment-intents/${id}`);
    expect(await replay.text()).toBe(cached);
    expect(state(files.paybridge)).toEqual(committed);
    expect(state(files.paybridge).work).toHaveLength(1);
  } finally {
    await restarted.stop();
  }
});

test("a cancellation committed before a lost response retains exactly one webhook after restart", async () => {
  await using files = await isolatedDatabases();
  const original = await launch({
    path: files.paybridge,
    fault: {
      operation: "cancel",
      kind: "after-commit",
    },
  });
  let id = "";
  let committed: ReturnType<typeof state>;
  try {
    id = await create({ url: original.url });
    const lost = cancel({ url: original.url, id }).then(
      () => "unexpected-response",
      () => "connection-lost",
    );
    expect(await original.message()).toEqual({ kind: "after-commit" });
    committed = state(files.paybridge);
    await original.stop();
    expect(await lost).toBe("connection-lost");
  } finally {
    await original.stop();
  }
  const restarted = await launch({ path: files.paybridge });
  try {
    const repeated = await cancel({ url: restarted.url, id });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      status: "CANCELLED",
      revision: 2,
      latestAttempt: null,
    });
    expect(state(files.paybridge)).toEqual(committed);
    expect(state(files.paybridge).webhooks).toHaveLength(1);
  } finally {
    await restarted.stop();
  }
});
