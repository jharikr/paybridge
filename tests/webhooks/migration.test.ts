import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import { expect, test } from "vitest";
import merchantBefore from "../../apps/merchant/migrations/snapshots/5124c0135cca8451f39c2883931e44372af72eae8562378e2b8e15607d3e44ad/contract.json" with { type: "json" };
import paybridgeBefore from "../../apps/paybridge/migrations/snapshots/9fbd3da4a17aaa43793ef7162f950da73dae1a48622c73cdf1385c6b1baf95e1/contract.json" with { type: "json" };
import { isolatedDatabases } from "../support/databases.ts";
import { launchMerchant } from "../merchant/support.ts";
import { rows } from "../provider/support.ts";
import { startApi, startDelivery } from "./system.ts";

test("additive inbox and delivery indexes retain old orders, exact acknowledgments, events, and pending notifications", async () => {
  await using files = await isolatedDatabases();
  const control = createSqliteControlClient();
  try {
    for (const setup of [
      {
        app: "merchant",
        path: files.merchant,
        contract: merchantBefore,
        migrations: ["20261011T1310_merchant_commands"],
      },
      {
        app: "paybridge",
        path: files.paybridge,
        contract: paybridgeBefore,
        migrations: [
          "20261011T1133_merchant_creation",
          "20261011T1205_payment_acceptance",
          "20261011T1230_provider_results",
          "20261011T1332_reconciliation_index",
        ],
      },
    ]) {
      const source = fileURLToPath(
        new URL(`../../apps/${setup.app}/migrations`, import.meta.url),
      );
      const previous = join(files.directory, setup.app + "-previous");
      await mkdir(join(previous, "app"), { recursive: true });
      for (const name of setup.migrations)
        await cp(join(source, "app", name), join(previous, "app", name), {
          recursive: true,
        });
      await cp(join(source, "snapshots"), join(previous, "snapshots"), {
        recursive: true,
      });
      expect(
        (
          await control.migrate({
            connection: setup.path,
            contract: setup.contract,
            migrationsDir: previous,
          })
        ).ok,
      ).toBe(true);
      await control.close();
    }
  } finally {
    await control.close();
  }
  const id = "pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const orderId = "ord_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const commandId = "mc_cccccccccccccccccccccccccccccccc";
  const eventId = "evt_dddddddddddddddddddddddddddddddd";
  const at = "2026-10-10T10:00:00.000Z";
  const acknowledgment = JSON.stringify({
    id,
    merchantReference: "LEGACY",
    amount: 99,
    currency: "XCD",
    status: "PENDING",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    latestAttempt: null,
    checkoutUrl: "http://127.0.0.1:3100/checkout/legacy?token=synthetic",
  });
  const oldMerchant = new DatabaseSync(files.merchant);
  try {
    oldMerchant.exec("PRAGMA foreign_keys=ON");
    oldMerchant
      .prepare(
        "INSERT INTO merchant_contexts(id,return_url,webhook_url,created_at) VALUES(?,?,?,?)",
      )
      .run(
        "merchant-a",
        "http://127.0.0.1:3101/merchant-a/payment-return",
        "http://127.0.0.1:3101/api/webhooks/paybridge/merchant-a",
        at,
      );
    oldMerchant
      .prepare(
        "INSERT INTO orders(id,merchant_id,business_reference,amount,currency,state,created_at,updated_at) VALUES(?,?,?,?,?,'UNPAID',?,?)",
      )
      .run(orderId, "merchant-a", "LEGACY", 99, "XCD", at, at);
    oldMerchant
      .prepare(
        "INSERT INTO merchant_commands(id,merchant_id,order_id,operation,command_number,idempotency_key,target,request_body,status,response_status,response_body,response_headers,created_at,completed_at) VALUES(?,?,?,'create',1,'legacy-key','/v1/payment-intents','{}','COMPLETED',201,?,'{\"content-type\":\"application/json\",\"cache-control\":\"no-store\"}',?,?)",
      )
      .run(commandId, "merchant-a", orderId, acknowledgment, at, at);
    oldMerchant
      .prepare(
        "INSERT INTO merchant_payments(payment_intent_id,merchant_id,order_id,last_applied_revision,created_at,updated_at) VALUES(?,?,?,0,?,?)",
      )
      .run(id, "merchant-a", orderId, at, at);
  } finally {
    oldMerchant.close();
  }
  const oldContexts = rows({
    path: files.merchant,
    sql: "SELECT * FROM merchant_contexts",
  });
  const oldOrders = rows({ path: files.merchant, sql: "SELECT * FROM orders" });
  const oldCommands = rows({
    path: files.merchant,
    sql: "SELECT * FROM merchant_commands",
  });
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
  try {
    const replay = await fetch(
      `${merchant.url}/merchant-a/orders/${orderId}/payment`,
      { method: "POST" },
    );
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(acknowledgment);
    const payload = JSON.stringify({
      id: eventId,
      type: "payment.cancelled",
      createdAt: at,
      data: {
        paymentIntentId: id,
        merchantReference: "LEGACY",
        amount: 99,
        currency: "XCD",
        status: "CANCELLED",
        revision: 2,
      },
    });
    const oldPaybridge = new DatabaseSync(files.paybridge);
    try {
      oldPaybridge.exec("PRAGMA foreign_keys=ON");
      oldPaybridge
        .prepare(
          "INSERT INTO merchants(id,name,provider_account_ref,api_key_hash,webhook_url,webhook_secret,return_origin,is_active,created_at) VALUES('merchant-a','Legacy','mock-account-a','legacy-key',?,'mock-webhook-secret-a',?,1,?)",
        )
        .run(
          `${merchant.url}/api/webhooks/paybridge/merchant-a`,
          merchant.url,
          at,
        );
      oldPaybridge
        .prepare(
          "INSERT INTO payment_intents(id,merchant_id,merchant_reference,amount,currency,return_url,status,revision,provider_invoice,checkout_token_hash,created_at,updated_at) VALUES(?,'merchant-a','LEGACY',99,'XCD',?,'CANCELLED',2,'LEGACYINVOICE','legacy-token',?,?)",
        )
        .run(id, merchant.url, at, at);
      oldPaybridge
        .prepare(
          "INSERT INTO payment_events(id,payment_intent_id,type,from_status,to_status,intent_revision,actor_type,actor_id,metadata,created_at) VALUES(?,?,'PAYMENT_CANCELLED','PENDING','CANCELLED',2,'MERCHANT','merchant-a','{}',?)",
        )
        .run(eventId, id, at);
      oldPaybridge
        .prepare(
          "INSERT INTO webhook_outbox(id,payment_event_id,merchant_id,payment_intent_id,event_type,payload,status,attempt_count,next_attempt_at,created_at) VALUES('who_legacy',?,'merchant-a',?,'payment.cancelled',?,'PENDING',0,?,?)",
        )
        .run(eventId, id, payload, at, at);
    } finally {
      oldPaybridge.close();
    }
    const oldMerchants = rows({
      path: files.paybridge,
      sql: "SELECT * FROM merchants",
    });
    const oldEvents = rows({
      path: files.paybridge,
      sql: "SELECT * FROM payment_events",
    });
    worker = await startDelivery({ path: files.paybridge });
    await worker.start();
    await expect
      .poll(() =>
        rows({
          path: files.paybridge,
          sql: "SELECT status FROM webhook_outbox",
        }),
      )
      .toEqual([{ status: "DELIVERED" }]);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT event_id,payload,status FROM webhook_inbox",
      }),
    ).toEqual([{ event_id: eventId, payload, status: "PENDING" }]);
    expect(rows({ path: files.merchant, sql: "SELECT * FROM orders" })).toEqual(
      oldOrders,
    );
    expect(
      rows({ path: files.merchant, sql: "SELECT * FROM merchant_commands" }),
    ).toEqual(oldCommands);
    expect(
      rows({ path: files.paybridge, sql: "SELECT * FROM payment_events" }),
    ).toEqual(oldEvents);
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: "http://localhost:3999",
    });
    await api.stop();
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT * FROM merchants WHERE id='merchant-a'",
      }),
    ).toEqual(oldMerchants);
    expect(
      rows({
        path: files.merchant,
        sql: "SELECT * FROM merchant_contexts WHERE id='merchant-a'",
      }),
    ).toEqual(oldContexts);
    const migrated = new DatabaseSync(files.paybridge);
    try {
      const indexes = migrated
        .prepare(
          "SELECT il.name, il.partial, group_concat(ii.name, ',') AS columns FROM pragma_index_list('payment_attempts') il JOIN pragma_index_info(il.name) ii GROUP BY il.name",
        )
        .all();
      expect(
        indexes.filter((index) => index.columns === "payment_intent_id"),
      ).toEqual([
        {
          name: "one_unresolved_attempt",
          partial: 1,
          columns: "payment_intent_id",
        },
      ]);
      for (const name of [
        "payment_intents_merchant_id_merchant_reference_idx_",
        "payment_intents_merchant_id_status_idx_",
        "payment_intents_created_at_idx_",
        "payment_events_payment_intent_id_created_at_idx_",
      ]) {
        expect(
          migrated
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE ?",
            )
            .get(name + "%"),
        ).toEqual({ count: 1 });
      }
      expect(() => migrated.exec("DELETE FROM payment_events")).toThrow();
      expect(() =>
        migrated.exec("UPDATE webhook_outbox SET payload='{}'"),
      ).toThrow();
    } finally {
      migrated.close();
    }
  } finally {
    await worker?.stop();
    await merchant.stop();
  }
});
