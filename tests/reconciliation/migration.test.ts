import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import { expect, test } from "vitest";
import previousContract from "../../apps/paybridge/migrations/snapshots/b81791e37db9f73e826b73c7def36cc02f1057bb1ba5ead750406228108cbb06/contract.json" with { type: "json" };
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { records } from "../recovery/support.ts";
import { command } from "./support.ts";

test("the additive list index retains a preexisting investigation and all earlier retention guards", async () => {
  await using files = await isolatedDatabases();
  const migrations = fileURLToPath(
    new URL("../../apps/paybridge/migrations", import.meta.url),
  );
  const previous = join(files.directory, "previous-migrations");
  await mkdir(join(previous, "app"), { recursive: true });
  for (const name of [
    "20261011T1133_merchant_creation",
    "20261011T1205_payment_acceptance",
    "20261011T1230_provider_results",
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
  const old = new DatabaseSync(files.paybridge);
  try {
    old.exec(`PRAGMA foreign_keys = ON;
      INSERT INTO merchants (id,name,provider_account_ref,api_key_hash,webhook_url,webhook_secret,return_origin,is_active,created_at)
        VALUES ('merchant-a','Preserved fixture','mock-account-a','old-api-hash','http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a','mock-webhook-secret-a','http://127.0.0.1:3101',1,'2026-10-10T10:00:00.000Z');
      INSERT INTO payment_intents (id,merchant_id,merchant_reference,amount,currency,return_url,status,revision,provider_invoice,checkout_token_hash,created_at,updated_at)
        VALUES ('pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','merchant-a','LEGACY-UNKNOWN',99,'XCD','http://127.0.0.1:3101/return','UNKNOWN',3,'LEGACYINV1','old-capability-hash','2026-10-10T10:00:00.000Z','2026-10-10T10:00:01.000Z');
      INSERT INTO payment_attempts (id,payment_intent_id,attempt_number,provider,provider_account_ref,provider_transaction_id,status,mock_payment_method_ref,failure_code,created_at,updated_at)
        VALUES ('pa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'4cs','mock-account-a','LEGACYTX1','UNKNOWN','pm_mock_lost_response','TransportFailure','2026-10-10T10:00:00.000Z','2026-10-10T10:00:01.000Z');
      INSERT INTO reconciliations (id,payment_intent_id,payment_attempt_id,status,reason,created_at)
        VALUES ('rec_cccccccccccccccccccccccccccccccc','pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','REQUIRED','TransportFailure','2026-10-10T10:00:01.000Z');
      UPDATE reconciliations SET status='IN_PROGRESS',started_by='prior-operator',started_at='2026-10-10T10:05:00.000Z';
      INSERT INTO payment_events (id,payment_intent_id,payment_attempt_id,type,from_status,to_status,intent_revision,actor_type,actor_id,metadata,created_at)
        VALUES ('evt_dddddddddddddddddddddddddddddddd','pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','PAYMENT_UNKNOWN','PROCESSING','UNKNOWN',3,'WORKER','old-worker','{"failureCode":"TransportFailure"}','2026-10-10T10:00:01.000Z');
      INSERT INTO provider_outbox (id,payment_attempt_id,status,attempt_count,next_attempt_at,created_at,updated_at,completed_at)
        VALUES ('pwo_legacy','pa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','COMPLETED',1,'2026-10-10T10:00:00.000Z','2026-10-10T10:00:00.000Z','2026-10-10T10:00:01.000Z','2026-10-10T10:00:01.000Z');`);
  } finally {
    old.close();
  }
  const baseline = records(files.paybridge);
  const listed = await command({
    path: files.paybridge,
    directory: files.directory,
    input: { kind: "list" },
  });
  expect(listed.code).toBe(0);
  expect(listed.body).toMatchObject({
    kind: "listed",
    cases: [
      {
        status: "IN_PROGRESS",
        startedBy: "prior-operator",
        reason: "TransportFailure",
        providerAccount: "mock-account-a",
        tranId: "LEGACYTX1",
        invoice: "LEGACYINV1",
        amountMinor: 99,
      },
    ],
  });
  expect(records(files.paybridge)).toEqual(baseline);
  expect(
    rows({
      path: files.paybridge,
      sql: "PRAGMA index_info('reconciliations_status_created_at_idx_1bbe8adf')",
    }).map((row) => row.name),
  ).toEqual(["status", "created_at"]);
  const migrated = new DatabaseSync(files.paybridge);
  try {
    migrated.exec("PRAGMA foreign_keys = ON");
    expect(() => migrated.exec("DELETE FROM reconciliations")).toThrow();
    expect(() =>
      migrated.exec("UPDATE reconciliations SET status='RESOLVED'"),
    ).toThrow();
    expect(() =>
      migrated.exec("UPDATE reconciliations SET status='REQUIRED'"),
    ).toThrow();
    expect(() =>
      migrated.exec("UPDATE payment_events SET metadata='{}'"),
    ).toThrow();
    expect(() =>
      migrated.exec(
        "UPDATE payment_attempts SET provider_transaction_id='OTHER'",
      ),
    ).toThrow();
  } finally {
    migrated.close();
  }
  expect(records(files.paybridge)).toEqual(baseline);
});
