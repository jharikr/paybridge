import { createHash } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import { expect, test } from "vitest";
import previousContract from "../../apps/paybridge/migrations/snapshots/668fba7bd586d6ca897717a237ca3168f1a4d85aeace6872024ae7d849d6564c/contract.json" with { type: "json" };
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, journey, lookup, rows } from "./support.ts";

test("the result migration retains an accepted attempt, its immutable inputs and acknowledgment, and executes its existing work", async () => {
  await using files = await isolatedDatabases();
  const migrations = fileURLToPath(
    new URL("../../apps/paybridge/migrations", import.meta.url),
  );
  const previous = join(files.directory, "previous-migrations");
  await mkdir(join(previous, "app"), { recursive: true });
  for (const name of [
    "20261011T1133_merchant_creation",
    "20261011T1205_payment_acceptance",
  ])
    await cp(join(migrations, "app", name), join(previous, "app", name), {
      recursive: true,
    });
  await cp(join(migrations, "snapshots"), join(previous, "snapshots"), {
    recursive: true,
  });
  const control = createSqliteControlClient();
  try {
    expect(
      (
        await control.migrate({
          connection: files.paybridge,
          contract: previousContract,
          migrationsDir: previous,
        })
      ).ok,
    ).toBe(true);
  } finally {
    await control.close();
  }
  const id = `pi_${"a".repeat(32)}`;
  const attemptId = `pa_${"b".repeat(32)}`;
  const now = "2026-10-11T10:00:00.000Z";
  const responseBody = JSON.stringify({
    paymentIntentId: id,
    paymentAttemptId: attemptId,
    attemptNumber: 1,
    status: "PROCESSING",
    revision: 2,
    statusUrl: `http://127.0.0.1:3100/v1/payment-intents/${id}`,
  });
  const hash = (input: string) =>
    createHash("sha256").update(input).digest("hex");
  const old = new DatabaseSync(files.paybridge);
  try {
    old.exec("PRAGMA foreign_keys = ON");
    old
      .prepare(
        "INSERT INTO merchants (id,name,provider_account_ref,api_key_hash,webhook_url,webhook_secret,return_origin,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "merchant-a",
        "Preserved fixture",
        "mock-account-a",
        hash("mock-paybridge-key-a"),
        "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a",
        "mock-webhook-secret-a",
        "http://127.0.0.1:3101",
        1,
        now,
      );
    old
      .prepare(
        "INSERT INTO payment_intents (id,merchant_id,merchant_reference,amount,currency,return_url,status,revision,provider_invoice,checkout_token_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "merchant-a",
        "OLDER-ACCEPTANCE",
        99,
        "XCD",
        "http://127.0.0.1:3101/payment-return",
        "PROCESSING",
        2,
        "LEGACYINV1",
        hash("retained-synthetic-token"),
        now,
        now,
      );
    old
      .prepare(
        "INSERT INTO payment_attempts (id,payment_intent_id,attempt_number,provider,provider_account_ref,provider_transaction_id,status,mock_payment_method_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        attemptId,
        id,
        1,
        "4cs",
        "mock-account-a",
        "LEGACYTX1",
        "PROCESSING",
        "pm_mock_approved",
        now,
        now,
      );
    old
      .prepare(
        "INSERT INTO provider_outbox (id,payment_attempt_id,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run("pwo_legacy", attemptId, "PENDING", 0, now, now, now);
    old
      .prepare(
        "INSERT INTO payment_events (id,payment_intent_id,payment_attempt_id,type,from_status,to_status,intent_revision,actor_type,actor_id,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "evt_legacy",
        id,
        attemptId,
        "ATTEMPT_CREATED",
        "PENDING",
        "PROCESSING",
        2,
        "MERCHANT",
        "merchant-a",
        "{}",
        now,
      );
    const canonical = `{"input":{"expectedRevision":1,"mockPaymentMethodRef":"pm_mock_approved"},"method":"POST","operation":"confirm_payment","target":"/v1/payment-intents/${id}/confirm"}`;
    old
      .prepare(
        "INSERT INTO idempotency_keys (merchant_id,key,operation,request_hash,status,resource_id,payment_attempt_id,response_status,response_body,response_headers,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "merchant-a",
        "legacy-confirm",
        "confirm_payment",
        hash(canonical),
        "COMPLETED",
        id,
        attemptId,
        202,
        responseBody,
        JSON.stringify({
          location: `/v1/payment-intents/${id}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-type": "application/json; charset=utf-8",
        }),
        now,
        now,
      );
  } finally {
    old.close();
  }
  const retainedTables = [
    "payment_intents",
    "payment_attempts",
    "provider_outbox",
    "payment_events",
    "idempotency_keys",
  ];
  const before = retainedTables.map((table) =>
    rows(files.paybridge, `SELECT * FROM ${table}`),
  );
  await using app = await journey(files);
  expect(
    retainedTables.map((table) =>
      rows(files.paybridge, `SELECT * FROM ${table}`),
    ),
  ).toEqual(before);
  const guard = new DatabaseSync(files.paybridge);
  try {
    expect(() => guard.exec("UPDATE payment_intents SET amount = 100")).toThrow(
      /payment_inputs_fixed/,
    );
    expect(() =>
      guard.exec(
        "UPDATE payment_attempts SET provider_transaction_id = 'REPLACED'",
      ),
    ).toThrow(/attempt_identity_fixed/);
    expect(() => guard.exec("DELETE FROM payment_attempts")).toThrow(
      /payment_attempts_retained/,
    );
    expect(() =>
      guard.exec("UPDATE idempotency_keys SET response_body = '{}'"),
    ).toThrow(/completed_command_fixed/);
  } finally {
    guard.close();
  }
  await app.startWorker();
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "SUCCEEDED", revision: 3 });
  const replay = await confirm(app.url, id, { key: "legacy-confirm" });
  expect(replay.status).toBe(202);
  expect(await replay.text()).toBe(responseBody);
  expect(
    rows(
      files.mockFourcs,
      "SELECT provider_account, tran_id, invoice, amount_minor, effect_count FROM mock_transactions",
    ),
  ).toEqual([
    {
      provider_account: "mock-account-a",
      tran_id: "LEGACYTX1",
      invoice: "LEGACYINV1",
      amount_minor: 99,
      effect_count: 1,
    },
  ]);
});
