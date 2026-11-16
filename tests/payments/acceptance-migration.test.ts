import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import { type } from "arktype";
import { expect, test } from "vitest";
import legacyContract from "../../apps/paybridge/migrations/snapshots/4f8c8ff366a53054d16a2ef113d26f49096154023650a816fb53500d285aaec8/contract.json" with { type: "json" };
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";

const migrations = fileURLToPath(
  new URL("../../apps/paybridge/migrations", import.meta.url),
);
const entrypoint = fileURLToPath(
  new URL("../../apps/paybridge/server.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("the additive acceptance migration preserves legacy payments, exact creation replay, and prior database guards", async () => {
  await using files = await isolatedDatabases();
  const legacyMigrations = join(files.directory, "legacy-migrations");
  await mkdir(join(legacyMigrations, "app"), { recursive: true });
  await cp(
    join(migrations, "app/20261011T1133_merchant_creation"),
    join(legacyMigrations, "app/20261011T1133_merchant_creation"),
    { recursive: true },
  );
  await cp(join(migrations, "snapshots"), join(legacyMigrations, "snapshots"), {
    recursive: true,
  });
  const control = createSqliteControlClient();
  try {
    const result = await control.migrate({
      connection: files.paybridge,
      contract: legacyContract,
      migrationsDir: legacyMigrations,
    });
    expect(result.ok).toBe(true);
  } finally {
    await control.close();
  }
  const id = `pi_${"a".repeat(32)}`;
  const now = "2026-10-11T10:00:00.000Z";
  const body = JSON.stringify({
    id,
    merchantReference: "LEGACY-1",
    amount: 100,
    currency: "XCD",
    status: "PENDING",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    latestAttempt: null,
    checkoutUrl: `http://127.0.0.1:3100/checkout/${id}?token=synthetic-retained-token`,
  });
  const responseHeaders = JSON.stringify({
    location: `/v1/payment-intents/${id}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-type": "application/json; charset=utf-8",
  });
  const canonical =
    '{"input":{"amount":100,"currency":"XCD","merchantReference":"LEGACY-1","returnUrl":"http://127.0.0.1:3101/payment-return"},"method":"POST","operation":"create_payment","target":"/v1/payment-intents"}';
  const legacy = new DatabaseSync(files.paybridge);
  try {
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy
      .prepare(
        "INSERT INTO merchants (id,name,provider_account_ref,api_key_hash,webhook_url,webhook_secret,return_origin,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "merchant-a",
        "Legacy synthetic merchant",
        "mock-account-a",
        hash("mock-paybridge-key-a"),
        "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a",
        "mock-webhook-secret-a",
        "http://127.0.0.1:3101",
        1,
        now,
      );
    legacy
      .prepare(
        "INSERT INTO payment_intents (id,merchant_id,merchant_reference,amount,currency,description,return_url,status,revision,provider_invoice,checkout_token_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "merchant-a",
        "LEGACY-1",
        100,
        "XCD",
        null,
        "http://127.0.0.1:3101/payment-return",
        "PENDING",
        1,
        "LEGACYINV",
        hash("synthetic-retained-token"),
        now,
        now,
      );
    legacy
      .prepare(
        "INSERT INTO payment_events (id,payment_intent_id,payment_attempt_id,type,from_status,to_status,intent_revision,actor_type,actor_id,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "evt_legacy",
        id,
        null,
        "PAYMENT_CREATED",
        null,
        "PENDING",
        1,
        "MERCHANT",
        "merchant-a",
        "{}",
        now,
      );
    legacy
      .prepare(
        "INSERT INTO idempotency_keys (merchant_id,key,operation,request_hash,status,resource_id,payment_attempt_id,response_status,response_body,response_headers,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "merchant-a",
        "legacy-command",
        "create_payment",
        hash(canonical),
        "COMPLETED",
        id,
        null,
        201,
        body,
        responseHeaders,
        now,
        now,
      );
    expect(
      legacy
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'payment_attempts'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    legacy.close();
  }
  const server = startNodeProcess({ entrypoint, args: [files.paybridge, "0"] });
  try {
    const { url } = ready.assert(await server.message());
    const response = await fetch(`${url}/v1/payment-intents`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock-paybridge-key-a",
        "content-type": "application/json",
        "idempotency-key": "legacy-command",
      },
      body: JSON.stringify({
        merchantReference: "LEGACY-1",
        amount: 100,
        currency: "XCD",
        returnUrl: "http://127.0.0.1:3101/payment-return",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("location")).toBe(`/v1/payment-intents/${id}`);
    const inspect = new DatabaseSync(files.paybridge);
    try {
      expect(
        inspect
          .prepare("SELECT type, intent_revision, metadata FROM payment_events")
          .all(),
      ).toEqual([
        { type: "PAYMENT_CREATED", intent_revision: 1, metadata: "{}" },
      ]);
      expect(() =>
        inspect.exec("UPDATE payment_intents SET amount = 200"),
      ).toThrow(/payment_inputs_fixed/);
      expect(() =>
        inspect.exec("UPDATE payment_intents SET revision = 2"),
      ).toThrow(/payment_revision_tracks_status/);
      expect(() =>
        inspect.exec("UPDATE idempotency_keys SET response_body = '{}'"),
      ).toThrow(/completed_command_fixed/);
      expect(() =>
        inspect.exec("UPDATE payment_events SET metadata = '{}'"),
      ).toThrow(/payment_events_append_only/);
      expect(() => inspect.exec("DELETE FROM payment_events")).toThrow(
        /payment_events_retained/,
      );
      expect(() => inspect.exec("DELETE FROM payment_intents")).toThrow(
        /payment_intents_retained/,
      );
    } finally {
      inspect.close();
    }
    const accepted = await fetch(`${url}/v1/payment-intents/${id}/confirm`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock-paybridge-key-a",
        "content-type": "application/json",
        "idempotency-key": "legacy-confirmation",
      },
      body: JSON.stringify({
        mockPaymentMethodRef: "pm_mock_approved",
        expectedRevision: 1,
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      paymentIntentId: id,
      attemptNumber: 1,
      status: "PROCESSING",
      revision: 2,
    });
  } finally {
    await server.stop();
  }
});
