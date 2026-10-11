import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";

const entrypoint = fileURLToPath(
  new URL("../../apps/paybridge/server.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const created = type({ id: "string" });
const accepted = type({
  paymentAttemptId: "string",
  revision: "number.integer",
});
const headers = {
  authorization: "Bearer mock-paybridge-key-a",
  "content-type": "application/json",
};
async function create({
  url,
  key = "create-1",
  authorization = headers.authorization,
}: {
  url: string;
  key?: string;
  authorization?: string;
}) {
  const response = await fetch(`${url}/v1/payment-intents`, {
    method: "POST",
    headers: { ...headers, authorization, "idempotency-key": key },
    body: JSON.stringify({
      merchantReference: "CONFIRM-1",
      amount: 7500,
      currency: "XCD",
      returnUrl:
        authorization === "Bearer mock-paybridge-key-b"
          ? "http://localhost:3101/payment-return"
          : "http://127.0.0.1:3101/payment-return",
    }),
  });
  expect(response.status).toBe(201);
  return created.assert(await response.json()).id;
}
function confirm({
  url,
  id,
  key = "confirm-1",
  input = {
    mockPaymentMethodRef: "pm_mock_approved",
    expectedRevision: 1,
  },
  authorization = headers.authorization,
}: {
  url: string;
  id: string;
  key?: string;
  input?: unknown;
  authorization?: string;
}) {
  return fetch(`${url}/v1/payment-intents/${id}/confirm`, {
    method: "POST",
    headers: { ...headers, authorization, "idempotency-key": key },
    body: JSON.stringify(input),
  });
}
function records(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      attempts: db
        .prepare(
          "SELECT payment_intent_id, attempt_number, provider_account_ref, provider_transaction_id, mock_payment_method_ref, status FROM payment_attempts ORDER BY attempt_number",
        )
        .all(),
      work: db
        .prepare(
          "SELECT payment_attempt_id, status, attempt_count FROM provider_outbox",
        )
        .all(),
      commands: db
        .prepare(
          "SELECT key, status, resource_id, payment_attempt_id FROM idempotency_keys ORDER BY key",
        )
        .all(),
      events: db
        .prepare(
          "SELECT type, intent_revision, payment_attempt_id FROM payment_events ORDER BY intent_revision, type",
        )
        .all(),
      webhooks: db
        .prepare("SELECT event_type, payload, status FROM webhook_outbox")
        .all(),
    };
  } finally {
    db.close();
  }
}

test("confirmation durably accepts one merchant-owned attempt and replays the exact acknowledgment with the worker stopped", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const id = await create({ url });
    const first = await confirm({ url, id });
    expect(first.status).toBe(202);
    expect(first.headers.get("location")).toBe(`/v1/payment-intents/${id}`);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = await first.text();
    const attempt = accepted.assert(JSON.parse(body));
    expect(JSON.parse(body)).toEqual({
      paymentIntentId: id,
      paymentAttemptId: expect.stringMatching(/^pa_[a-f0-9]{32}$/),
      attemptNumber: 1,
      status: "PROCESSING",
      revision: 2,
      statusUrl: `http://127.0.0.1:3100/v1/payment-intents/${id}`,
    });
    const replay = await confirm({ url, id });
    expect(replay.status).toBe(202);
    expect(await replay.text()).toBe(body);
    const lookup = await fetch(`${url}/v1/payment-intents/${id}`, { headers });
    expect(await lookup.json()).toMatchObject({
      status: "PROCESSING",
      revision: 2,
      latestAttempt: {
        id: attempt.paymentAttemptId,
        attemptNumber: 1,
        status: "PROCESSING",
      },
    });
    expect(records(files.paybridge)).toEqual({
      attempts: [
        {
          payment_intent_id: id,
          attempt_number: 1,
          provider_account_ref: "mock-account-a",
          provider_transaction_id: expect.stringMatching(/^[A-Za-z0-9]{1,16}$/),
          mock_payment_method_ref: "pm_mock_approved",
          status: "PROCESSING",
        },
      ],
      work: [
        {
          payment_attempt_id: attempt.paymentAttemptId,
          status: "PENDING",
          attempt_count: 0,
        },
      ],
      commands: [
        {
          key: "confirm-1",
          status: "COMPLETED",
          resource_id: id,
          payment_attempt_id: attempt.paymentAttemptId,
        },
        {
          key: "create-1",
          status: "COMPLETED",
          resource_id: id,
          payment_attempt_id: null,
        },
      ],
      events: [
        {
          type: "PAYMENT_CREATED",
          intent_revision: 1,
          payment_attempt_id: null,
        },
        {
          type: "ATTEMPT_CREATED",
          intent_revision: 2,
          payment_attempt_id: attempt.paymentAttemptId,
        },
      ],
      webhooks: [],
    });
  } finally {
    await server.stop();
  }
});

test("merchant cancellation is terminal and repeating it preserves one revision, event, and exact webhook", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const id = await create({ url });
    const cancel = () =>
      fetch(`${url}/v1/payment-intents/${id}/cancel`, {
        method: "POST",
        headers: { authorization: headers.authorization },
      });
    const first = await cancel();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = await first.text();
    expect(JSON.parse(body)).toMatchObject({
      id,
      status: "CANCELLED",
      revision: 2,
      latestAttempt: null,
    });
    const repeat = await cancel();
    expect(repeat.status).toBe(200);
    expect(await repeat.text()).toBe(body);
    const rejected = await confirm({
      url,
      id,
      key: "after-cancellation",
      input: {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 2,
      },
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: "payment_not_confirmable" },
    });
    const stored = records(files.paybridge);
    expect(stored.attempts).toEqual([]);
    expect(stored.work).toEqual([]);
    expect(stored.commands.map((row) => row.key)).toEqual(["create-1"]);
    expect(stored.events).toEqual([
      { type: "PAYMENT_CREATED", intent_revision: 1, payment_attempt_id: null },
      {
        type: "PAYMENT_CANCELLED",
        intent_revision: 2,
        payment_attempt_id: null,
      },
    ]);
    expect(stored.webhooks).toHaveLength(1);
    expect(stored.webhooks[0]).toMatchObject({
      event_type: "payment.cancelled",
      status: "PENDING",
    });
    expect(
      JSON.parse(type("string").assert(stored.webhooks[0]?.payload)),
    ).toEqual({
      id: expect.stringMatching(/^evt_/),
      type: "payment.cancelled",
      createdAt: expect.any(String),
      data: {
        paymentIntentId: id,
        merchantReference: "CONFIRM-1",
        amount: 7500,
        currency: "XCD",
        status: "CANCELLED",
        revision: 2,
      },
    });
  } finally {
    await server.stop();
  }
});

test("database constraints retain fixed attempt identity and permit only one unresolved attempt and work item", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const id = await create({ url });
    expect((await confirm({ url, id })).status).toBe(202);
    const db = new DatabaseSync(files.paybridge);
    try {
      expect(() =>
        db.exec(
          "UPDATE payment_attempts SET provider_account_ref = 'mock-account-b'",
        ),
      ).toThrow(/attempt_identity_fixed/);
      expect(() =>
        db.exec(
          "UPDATE payment_attempts SET provider_transaction_id = 'DIFFERENT'",
        ),
      ).toThrow(/attempt_identity_fixed/);
      expect(() =>
        db.exec(
          "UPDATE payment_attempts SET mock_payment_method_ref = 'pm_mock_declined'",
        ),
      ).toThrow(/attempt_identity_fixed/);
      expect(() => db.exec("DELETE FROM payment_attempts")).toThrow(/retained/);
      expect(() =>
        db.exec("UPDATE provider_outbox SET payment_attempt_id = 'different'"),
      ).toThrow();
      expect(() =>
        db.exec(
          "INSERT INTO payment_attempts SELECT attempt_number + 1, created_at, failure_code, failure_message, 'pa_second', mock_payment_method_ref, payment_intent_id, provider, provider_account_ref, provider_financial_result, provider_host_reference, provider_operation_result, provider_service_result, 'SECONDTRAN', status, updated_at FROM payment_attempts LIMIT 1",
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.exec("UPDATE payment_attempts SET status = 'PENDING'"),
      ).toThrow(/attempt_/);
    } finally {
      db.close();
    }
    const lookup = await fetch(`${url}/v1/payment-intents/${id}`, { headers });
    expect(await lookup.json()).toMatchObject({
      status: "PROCESSING",
      revision: 2,
      latestAttempt: { status: "PROCESSING" },
    });
    expect(records(files.paybridge).attempts).toHaveLength(1);
  } finally {
    await server.stop();
  }
});

test("confirmation validates ownership, the observed revision, synthetic input, and the full command identity", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const id = await create({ url });
    const missingKey = await fetch(`${url}/v1/payment-intents/${id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
      }),
    });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    const otherId = await create({ url, key: "create-2" });
    const merchantB = "Bearer mock-paybridge-key-b";
    for (const input of [
      {},
      { mockPaymentMethodRef: "pm_mock_approved" },
      { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 0 },
      { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 1.5 },
      { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: "1" },
      {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 9007199254740992,
      },
      { mockPaymentMethodRef: "real-token", expectedRevision: 1 },
      {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
        cardNumber: "4111111111111111",
      },
      {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
        providerAccountRef: "mock-account-b",
      },
    ])
      expect(
        (await confirm({ url, id, key: "valid-after-rejections", input }))
          .status,
      ).toBe(400);
    const foreign = await confirm({
      url,
      id,
      key: "foreign",
      input: undefined,
      authorization: merchantB,
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({
      error: { code: "payment_not_found" },
    });
    const missing = await confirm({
      url,
      id: `pi_${"f".repeat(32)}`,
      key: "missing",
    });
    expect(missing.status).toBe(404);
    expect(
      (
        await confirm({
          url,
          id,
          key: "bad-auth",
          input: undefined,
          authorization: "Bearer mock-provider-key-a",
        })
      ).status,
    ).toBe(401);
    const stale = await confirm({
      url,
      id,
      key: "stale",
      input: {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 9,
      },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "payment_revision_conflict" },
    });
    expect(records(files.paybridge).commands.map((row) => row.key)).toEqual([
      "create-1",
      "create-2",
    ]);
    expect(records(files.paybridge).attempts).toEqual([]);
    const first = await confirm({ url, id, key: "valid-after-rejections" });
    expect(first.status).toBe(202);
    const original = await first.text();
    for (const [target, key, input] of [
      [
        id,
        "valid-after-rejections",
        { mockPaymentMethodRef: "pm_mock_declined", expectedRevision: 1 },
      ],
      [
        id,
        "valid-after-rejections",
        { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 2 },
      ],
      [
        otherId,
        "valid-after-rejections",
        { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 1 },
      ],
      [
        otherId,
        "create-2",
        { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 1 },
      ],
    ] as const) {
      const conflict = await confirm({ url, id: target, key, input });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        error: { code: "idempotency_conflict" },
      });
    }
    expect(
      await (await confirm({ url, id, key: "valid-after-rejections" })).text(),
    ).toBe(original);
    const duplicateRevision = await confirm({ url, id, key: "different-key" });
    expect(duplicateRevision.status).toBe(409);
    expect(await duplicateRevision.json()).toMatchObject({
      error: { code: "payment_revision_conflict" },
    });
    const unresolved = await confirm({
      url,
      id,
      key: "unresolved",
      input: {
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 2,
      },
    });
    expect(unresolved.status).toBe(409);
    expect(await unresolved.json()).toMatchObject({
      error: { code: "payment_not_confirmable" },
    });
    expect(
      (
        await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
          method: "POST",
          headers: { authorization: headers.authorization },
        })
      ).status,
    ).toBe(409);
    const bId = await create({
      url,
      key: "create-1",
      authorization: merchantB,
    });
    const b = await confirm({
      url,
      id: bId,
      key: "valid-after-rejections",
      input: undefined,
      authorization: merchantB,
    });
    expect(b.status).toBe(202);
    expect(
      records(files.paybridge)
        .attempts.map((row) => row.provider_account_ref)
        .sort(),
    ).toEqual(["mock-account-a", "mock-account-b"]);
    expect(records(files.paybridge).work).toHaveLength(2);
    expect(server.output()).not.toMatch(
      /mock-provider-key|pm_mock_approved|mock-paybridge-key|checkout/,
    );
  } finally {
    await server.stop();
  }
});

test("cancellation hides other merchants' payments and rejects payloads without changing a pending intent", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const id = await create({ url });
    const foreign = await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer mock-paybridge-key-b" },
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({
      error: { code: "payment_not_found" },
    });
    const unauthenticated = await fetch(
      `${url}/v1/payment-intents/${id}/cancel`,
      { method: "POST" },
    );
    expect(unauthenticated.status).toBe(401);
    const body = await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ providerAccountRef: "mock-account-b" }),
    });
    expect(body.status).toBe(400);
    const query = await fetch(
      `${url}/v1/payment-intents/${id}/cancel?unexpected=true`,
      { method: "POST", headers: { authorization: headers.authorization } },
    );
    expect(query.status).toBe(400);
    expect(records(files.paybridge).events).toEqual([
      { type: "PAYMENT_CREATED", intent_revision: 1, payment_attempt_id: null },
    ]);
    expect(records(files.paybridge).webhooks).toEqual([]);
    const owned = await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
      method: "POST",
      headers: { authorization: headers.authorization },
    });
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({
      status: "CANCELLED",
      revision: 2,
    });
  } finally {
    await server.stop();
  }
});
