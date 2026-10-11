import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";

const entrypoint = fileURLToPath(
  new URL("../../apps/paybridge/server.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const created = type({ id: "string", checkoutUrl: "string" });
const input = {
  merchantReference: "REG-2026-00124",
  amount: 7500,
  currency: "XCD",
  description: "Nursing registration",
  returnUrl: "http://127.0.0.1:3101/payment-return",
};
const headers = {
  authorization: "Bearer mock-paybridge-key-a",
  "content-type": "application/json",
  "idempotency-key": "create-1",
};

test("a merchant creates a pending intent and retrieves its persisted public snapshot", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const response = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    const payment = created.assert(body);
    expect(body).toEqual({
      id: expect.stringMatching(/^pi_/),
      merchantReference: "REG-2026-00124",
      amount: 7500,
      currency: "XCD",
      status: "PENDING",
      revision: 1,
      latestAttempt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      checkoutUrl: expect.stringMatching(/\/checkout\/pi_.+\?token=.+/),
    });
    expect(response.headers.get("location")).toBe(
      `/v1/payment-intents/${payment.id}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const lookup = await fetch(`${url}/v1/payment-intents/${payment.id}`, {
      headers: { authorization: headers.authorization },
    });
    expect(lookup.status).toBe(200);
    expect(lookup.headers.get("cache-control")).toBe("no-store");
    expect(lookup.headers.get("x-content-type-options")).toBe("nosniff");
    const actual: unknown = await lookup.json();
    expect(actual).toMatchObject({
      id: payment.id,
      status: "PENDING",
      revision: 1,
      amount: 7500,
      latestAttempt: null,
    });
    expect(actual).not.toHaveProperty("checkoutUrl");
  } finally {
    await server.stop();
  }
});

test("creation replays exact acknowledgments, conflicts on changed input, and scopes keys to merchants", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const create = ({
      body = input,
      key = "create-1",
      authorization = headers.authorization,
    }: {
      body?: unknown;
      key?: string;
      authorization?: string;
    }) =>
      fetch(`${url}/v1/payment-intents`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": key, authorization },
        body: JSON.stringify(body),
      });
    const first = await create({});
    expect(first.status).toBe(201);
    const original = await first.text();
    const originalId = created.assert(JSON.parse(original)).id;
    const reordered = {
      returnUrl: input.returnUrl,
      description: input.description,
      currency: input.currency,
      amount: input.amount,
      merchantReference: input.merchantReference,
    };
    const replay = await create({ body: reordered });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await replay.text()).toBe(original);
    expect(replay.headers.get("location")).toBe(first.headers.get("location"));
    for (const changed of [
      { ...input, amount: 7501 },
      { ...input, merchantReference: "Other reference" },
      { ...input, description: "Changed" },
      { ...input, returnUrl: `${input.returnUrl}?different=1` },
    ]) {
      const conflict = await create({ body: changed });
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get("retry-after")).toBeNull();
      expect(await conflict.json()).toMatchObject({
        error: { code: "idempotency_conflict" },
      });
    }
    const [otherKey, otherMerchant] = await Promise.all([
      create({ body: input, key: "create-2" }),
      create({
        body: { ...input, returnUrl: "http://localhost:3101/payment-return" },
        key: "create-1",
        authorization: "Bearer mock-paybridge-key-b",
      }),
    ]);
    expect(otherKey.status).toBe(201);
    expect(otherMerchant.status).toBe(201);
    expect(created.assert(await otherKey.json()).id).not.toBe(originalId);
    expect(created.assert(await otherMerchant.json()).id).not.toBe(originalId);
  } finally {
    await server.stop();
  }
});

test("merchant ownership and strict request validation reject invalid alternatives without consuming the command key", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const create = ({
      body,
      customHeaders = headers,
    }: {
      body: unknown;
      customHeaders?: Record<string, string>;
    }) =>
      fetch(`${url}/v1/payment-intents`, {
        method: "POST",
        headers: customHeaders,
        body: JSON.stringify(body),
      });
    for (const authorization of [
      "",
      "Bearer invalid",
      "Basic mock-paybridge-key-a",
      "Bearer mock-provider-key-a",
    ]) {
      expect(
        (
          await create({
            body: input,
            customHeaders: { ...headers, authorization },
          })
        ).status,
      ).toBe(401);
    }
    for (const key of ["", "x".repeat(129)]) {
      const rejected = await create({
        body: input,
        customHeaders: {
          ...headers,
          "idempotency-key": key,
        },
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { code: "invalid_idempotency_key" },
      });
    }
    const { "idempotency-key": _key, ...withoutKey } = headers;
    expect(
      (await create({ body: input, customHeaders: withoutKey })).status,
    ).toBe(400);
    for (const body of [
      ...[0, -1, 1.25, 10_000_000_000, 9007199254740992, "7500"].map(
        (amount) => ({ ...input, amount }),
      ),
      { ...input, currency: "USD" },
      { ...input, currency: "xcd" },
      { ...input, merchantReference: "" },
      { ...input, merchantReference: "x".repeat(129) },
      { ...input, description: "x".repeat(257) },
      { ...input, providerAccountRef: "mock-account-b" },
      { ...input, merchantId: "merchant-b" },
      { ...input, cardNumber: "synthetic-forbidden" },
      { ...input, card: { pan: "synthetic-forbidden", cvv: "synthetic" } },
      ...[
        "javascript:alert(1)",
        "https://attacker.example/",
        "http://127.0.0.1:3101.attacker.example/",
        "http://user:secret@127.0.0.1:3101/",
        `${input.returnUrl}#fragment`,
      ].map((returnUrl) => ({ ...input, returnUrl })),
    ]) {
      const rejected = await create({ body });
      expect(rejected.status, JSON.stringify(body)).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    const accepted = await create({
      body: {
        ...input,
        merchantReference: "😀".repeat(64),
        description: "<script>alert('inert')</script>",
        amount: 9_999_999_999,
      },
    });
    expect(accepted.status).toBe(201);
    const body = created.assert(await accepted.json());
    for (const authorization of ["", "Bearer wrong"]) {
      expect(
        (
          await fetch(`${url}/v1/payment-intents/${body.id}`, {
            headers: { authorization },
          })
        ).status,
      ).toBe(401);
    }
    const crossMerchant = await fetch(`${url}/v1/payment-intents/${body.id}`, {
      headers: { authorization: "Bearer mock-paybridge-key-b" },
    });
    const absent = await fetch(
      `${url}/v1/payment-intents/pi_${"0".repeat(32)}`,
      { headers: { authorization: headers.authorization } },
    );
    expect(crossMerchant.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await crossMerchant.json()).toEqual({
      error: {
        code: "payment_not_found",
        message: "The payment was not found.",
        requestId: expect.stringMatching(/^req_/),
      },
    });
    expect(await absent.json()).toEqual({
      error: {
        code: "payment_not_found",
        message: "The payment was not found.",
        requestId: expect.stringMatching(/^req_/),
      },
    });
    expect(server.output()).not.toContain("mock-paybridge-key");
    expect(server.output()).not.toContain(body.checkoutUrl);
  } finally {
    await server.stop();
  }
});

test("inactive merchant credentials stay disabled after restart", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  await using files = await isolatedDatabases();
  const first = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  await first.message();
  await first.stop();
  const db = new DatabaseSync(files.paybridge);
  db.prepare("UPDATE merchants SET is_active = 0 WHERE id = ?").run(
    "merchant-a",
  );
  db.close();
  const restarted = startNodeProcess({
    entrypoint,
    args: [files.paybridge, "0"],
  });
  try {
    const { url } = ready.assert(await restarted.message());
    const rejected = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    const allowed = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer mock-paybridge-key-b" },
      body: JSON.stringify({
        ...input,
        returnUrl: "http://localhost:3101/payment-return",
      }),
    });
    expect(allowed.status).toBe(201);
  } finally {
    await restarted.stop();
  }
});

test("database constraints preserve financial inputs and append-only creation evidence", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  let id = "";
  try {
    const { url } = ready.assert(await server.message());
    const response = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    id = created.assert(await response.json()).id;
  } finally {
    await server.stop();
  }
  const db = new DatabaseSync(files.paybridge);
  try {
    expect(
      db
        .prepare(
          "SELECT merchant_id, amount, currency, merchant_reference, description, status, revision FROM payment_intents WHERE id = ?",
        )
        .get(id),
    ).toEqual({
      merchant_id: "merchant-a",
      amount: 7500,
      currency: "XCD",
      merchant_reference: input.merchantReference,
      description: "Nursing registration",
      status: "PENDING",
      revision: 1,
    });
    expect(
      db
        .prepare(
          "SELECT type, actor_id, intent_revision FROM payment_events WHERE payment_intent_id = ?",
        )
        .all(id),
    ).toEqual([
      { type: "PAYMENT_CREATED", actor_id: "merchant-a", intent_revision: 1 },
    ]);
    for (const mutation of [
      "UPDATE payment_intents SET amount = 1",
      "UPDATE payment_intents SET merchant_id = 'merchant-b'",
      "UPDATE payment_intents SET currency = 'USD'",
      "UPDATE payment_intents SET merchant_reference = 'changed'",
      "UPDATE payment_intents SET return_url = 'http://attacker.example'",
      "UPDATE payment_intents SET description = 'changed'",
      "UPDATE payment_intents SET provider_invoice = 'CHANGED'",
      "UPDATE payment_intents SET status = 'UNKNOWN'",
      "UPDATE payment_intents SET revision = 2",
      "UPDATE payment_events SET type = 'CHANGED'",
      "DELETE FROM payment_events",
      "DELETE FROM idempotency_keys",
      "UPDATE idempotency_keys SET response_body = '{}'",
      "UPDATE merchants SET provider_account_ref = 'different'",
      "UPDATE merchants SET is_active = 2",
    ])
      expect(() => db.exec(mutation), mutation).toThrow();
  } finally {
    db.close();
  }
});

test("stored creation evidence keeps credential hashes, distinct invoice identity, and sensitive replay bytes", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  let firstBody = "";
  try {
    const { url } = ready.assert(await server.message());
    for (const key of ["first", "second"]) {
      const response = await fetch(`${url}/v1/payment-intents`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": key },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(201);
      const body = await response.text();
      if (key === "first") firstBody = body;
    }
  } finally {
    await server.stop();
  }
  const db = new DatabaseSync(files.paybridge);
  try {
    const merchants = type({
      id: "string",
      api_key_hash: "string",
      provider_account_ref: "string",
      webhook_secret: "string",
      webhook_url: "string",
    })
      .array()
      .assert(
        db
          .prepare(
            "SELECT id, api_key_hash, provider_account_ref, webhook_secret, webhook_url FROM merchants ORDER BY id",
          )
          .all(),
      );
    expect(
      merchants.map(({ id, provider_account_ref, webhook_url }) => ({
        id,
        provider_account_ref,
        webhook_url,
      })),
    ).toEqual([
      {
        id: "merchant-a",
        provider_account_ref: "mock-account-a",
        webhook_url: "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a",
      },
      {
        id: "merchant-b",
        provider_account_ref: "mock-account-b",
        webhook_url: "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-b",
      },
    ]);
    expect(
      new Set(merchants.map((merchant) => merchant.webhook_secret)).size,
    ).toBe(2);
    for (const merchant of merchants)
      expect(merchant.api_key_hash).toMatch(/^[a-f0-9]{64}$/);
    const payment = created.assert(JSON.parse(firstBody));
    const token = new URL(payment.checkoutUrl).searchParams.get("token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const record = type({
      checkout_token_hash: "string",
      provider_invoice: "string",
    }).assert(
      db
        .prepare(
          "SELECT checkout_token_hash, provider_invoice FROM payment_intents WHERE id = ?",
        )
        .get(payment.id),
    );
    expect(record.checkout_token_hash).toBe(
      createHash("sha256").update(type("string").assert(token)).digest("hex"),
    );
    expect(record.provider_invoice).toMatch(/^[A-Za-z0-9]{1,16}$/);
    expect(
      db
        .prepare(
          "SELECT COUNT(DISTINCT provider_invoice) AS count FROM payment_intents",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT response_body FROM idempotency_keys WHERE key = 'first'",
        )
        .get(),
    ).toEqual({ response_body: firstBody });
    const cached = type({ response_headers: "string" }).assert(
      db
        .prepare(
          "SELECT response_headers FROM idempotency_keys WHERE key = 'first'",
        )
        .get(),
    );
    expect(JSON.parse(cached.response_headers)).toMatchObject({
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    const columns = [
      "id",
      "merchant_id",
      "merchant_reference",
      "amount",
      "currency",
      "description",
      "return_url",
      "status",
      "revision",
      "provider_invoice",
      "checkout_token_hash",
      "created_at",
      "updated_at",
    ];
    for (const scenario of [
      { column: "amount", value: 0 },
      { column: "amount", value: 1.5 },
      { column: "amount", value: 10_000_000_000 },
      { column: "currency", value: "USD" },
      { column: "status", value: "INVALID" },
      { column: "revision", value: 0 },
      { column: "merchant_id", value: "absent" },
      { column: "provider_invoice", value: "bad-invoice-!" },
    ]) {
      const selected = columns.map((column) =>
        column === scenario.column
          ? "?"
          : column === "id"
            ? "'invalid'"
            : column === "provider_invoice"
              ? "'UNIQUEINVOICE'"
              : column,
      );
      expect(
        () =>
          db
            .prepare(
              `INSERT INTO payment_intents (${columns.join(",")}) SELECT ${selected.join(",")} FROM payment_intents WHERE id = ?`,
            )
            .run(scenario.value, payment.id),
        JSON.stringify(scenario),
      ).toThrow();
    }
  } finally {
    db.close();
  }
});

test("text rejected by SQLite never reserves a command, while accepted Unicode remains unchanged", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  await using files = await isolatedDatabases();
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  let paymentId = "";
  const merchantReference = "Café e\u0301 😀 O'Neil";
  const description = "<script>inert</script>\nCafé 😀";
  try {
    const { url } = ready.assert(await server.message());
    for (const text of ["\ud800", "\udfff", "\u0000", "before\u0000after"]) {
      for (const body of [
        { ...input, merchantReference: text },
        { ...input, description: text },
        { ...input, returnUrl: `${input.returnUrl}?text=${text}` },
      ]) {
        const rejected = await fetch(`${url}/v1/payment-intents`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(rejected.status, JSON.stringify(body)).toBe(400);
        expect(await rejected.json()).toMatchObject({
          error: { code: "invalid_request" },
        });
      }
    }
    for (const control of ["\r", "\n", "\t"]) {
      const rejected = await fetch(`${url}/v1/payment-intents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...input,
          returnUrl: `${input.returnUrl}${control}suffix`,
        }),
      });
      expect(rejected.status).toBe(400);
    }
    const accepted = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, merchantReference, description }),
    });
    expect(accepted.status).toBe(201);
    const body: unknown = await accepted.json();
    paymentId = created.assert(body).id;
    expect(body).toMatchObject({ merchantReference });
    const lookup = await fetch(`${url}/v1/payment-intents/${paymentId}`, {
      headers,
    });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ merchantReference });
  } finally {
    await server.stop();
  }
  const db = new DatabaseSync(files.paybridge, { readOnly: true });
  try {
    expect(
      db
        .prepare(
          "SELECT merchant_reference, description FROM payment_intents WHERE id = ?",
        )
        .get(paymentId),
    ).toEqual({ merchant_reference: merchantReference, description });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get(),
    ).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
