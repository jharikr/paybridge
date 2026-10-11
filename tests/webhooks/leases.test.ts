import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { launchMerchant } from "../merchant/support.ts";
import { rows } from "../provider/support.ts";
import { cancelled, startApi, startDelivery } from "./system.ts";

test.each([
  { lock: "writer", transaction: "BEGIN IMMEDIATE", count: 1 },
  { lock: "reader delaying commit", transaction: "BEGIN", count: 2 },
])(
  "a $lock cannot consume the delivery lease before bounded HTTP starts",
  async ({ transaction, count }) => {
    await using files = await isolatedDatabases();
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: "http://127.0.0.1:3100",
    });
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: merchant.url,
    });
    let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
    try {
      await cancelled({ url: api.url, merchantOrigin: merchant.url });
      worker = await startDelivery({
        path: files.paybridge,
        options: {
          timeout: 300,
          lease: 500,
        },
      });
      const blocker = new DatabaseSync(files.paybridge);
      try {
        blocker.exec(transaction);
        blocker.prepare("SELECT id FROM webhook_outbox").all();
        await worker.start();
        await delay(800);
        blocker.exec("COMMIT");
      } finally {
        blocker.close();
      }
      await expect
        .poll(() =>
          rows({
            path: files.paybridge,
            sql: "SELECT status,attempt_count FROM webhook_outbox",
          }),
        )
        .toEqual([{ status: "DELIVERED", attempt_count: count }]);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT event_id FROM webhook_inbox",
        }),
      ).toHaveLength(1);
    } finally {
      await worker?.stop();
      await api.stop();
      await merchant.stop();
    }
  },
);

test("two simultaneous senders have one owner for fresh work", async () => {
  await using files = await isolatedDatabases();
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  const api = await startApi({
    path: files.paybridge,
    merchantOrigin: merchant.url,
  });
  const workers: Awaited<ReturnType<typeof startDelivery>>[] = [];
  try {
    await cancelled({ url: api.url, merchantOrigin: merchant.url });
    workers.push(
      await startDelivery({
        path: files.paybridge,
        options: { held: "after-webhook-claim" },
      }),
      await startDelivery({
        path: files.paybridge,
        options: { held: "after-webhook-claim" },
      }),
    );
    await Promise.all(workers.map((worker) => worker.start()));
    await expect
      .poll(() =>
        rows({
          path: files.paybridge,
          sql: "SELECT status,attempt_count FROM webhook_outbox",
        }),
      )
      .toEqual([{ status: "PROCESSING", attempt_count: 1 }]);
    const owner = rows({
      path: files.paybridge,
      sql: "SELECT locked_by FROM webhook_outbox",
    })[0]?.locked_by;
    const winner = workers.find((worker) => worker.workerId === owner);
    if (!winner) throw new Error("Claim owner did not match either worker");
    await winner.message();
    expect(
      rows({ path: files.merchant, sql: "SELECT event_id FROM webhook_inbox" }),
    ).toEqual([]);
    winner.child.send({ kind: "release" });
    await winner.message();
    await expect
      .poll(() =>
        rows({
          path: files.paybridge,
          sql: "SELECT status,attempt_count FROM webhook_outbox",
        }),
      )
      .toEqual([{ status: "DELIVERED", attempt_count: 1 }]);
    expect(
      rows({ path: files.merchant, sql: "SELECT event_id FROM webhook_inbox" }),
    ).toHaveLength(1);
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
    await api.stop();
    await merchant.stop();
  }
});

test("completion checks fresh lease time after waiting for write access", async () => {
  await using files = await isolatedDatabases();
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  const api = await startApi({
    path: files.paybridge,
    merchantOrigin: merchant.url,
  });
  let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
  try {
    await cancelled({ url: api.url, merchantOrigin: merchant.url });
    worker = await startDelivery({
      path: files.paybridge,
      options: {
        held: "after-webhook-response",
        timeout: 300,
        lease: 500,
      },
    });
    await worker.start();
    await worker.message();
    const blocker = new DatabaseSync(files.paybridge);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      worker.child.send({ kind: "release" });
      await worker.message();
      await delay(800);
      blocker.exec("COMMIT");
    } finally {
      blocker.close();
    }
    expect(await worker.message()).toMatchObject({
      code: "webhook_stale_completion",
    });
    await expect
      .poll(() =>
        rows({
          path: files.paybridge,
          sql: "SELECT status,attempt_count FROM webhook_outbox",
        }),
      )
      .toEqual([{ status: "DELIVERED", attempt_count: 2 }]);
    expect(
      rows({ path: files.merchant, sql: "SELECT event_id FROM webhook_inbox" }),
    ).toHaveLength(1);
  } finally {
    await worker?.stop();
    await api.stop();
    await merchant.stop();
  }
});
