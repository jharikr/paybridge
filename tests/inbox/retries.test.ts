import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { launchMerchant } from "../merchant/support.ts";
import { rows } from "../provider/support.ts";
import { payload } from "../webhooks/support.ts";
import { advance } from "../webhooks/system.ts";
import { controlledInbox, deliver } from "./support.ts";

test("unmatched receipt retries double to the cap without changing authenticated facts or creating an order", async () => {
  await using files = await isolatedDatabases();
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: "http://127.0.0.1:3100",
  });
  let worker: Awaited<ReturnType<typeof controlledInbox>> | undefined;
  try {
    expect((await deliver({ url: merchant.url, body: payload })).status).toBe(
      204,
    );
    const original = rows({
      path: files.merchant,
      sql: "SELECT event_id,receiving_merchant_id,payload,payload_hash,received_at FROM webhook_inbox",
    });
    worker = await controlledInbox({ path: files.merchant });
    let clock = Date.now();
    await advance({ worker, epochMs: clock });
    await worker.start();
    for (const [index, backoff] of [50, 100, 200, 200].entries()) {
      expect(await worker.message()).toMatchObject({
        code: "inbox_binding_unmatched",
        workerId: worker.workerId,
      });
      const record = type({
        status: "string",
        attempt_count: "number",
        next_attempt_at: "string",
        last_error: "string",
        claim_token: "null",
        locked_by: "null",
        lease_expires_at: "null",
      }).assert(
        rows({
          path: files.merchant,
          sql: "SELECT status,attempt_count,next_attempt_at,last_error,claim_token,locked_by,lease_expires_at FROM webhook_inbox",
        })[0],
      );
      expect(record).toMatchObject({
        status: "PENDING",
        attempt_count: index + 1,
        last_error: "inbox_binding_unmatched",
      });
      expect(Date.parse(record.next_attempt_at) - clock).toBe(backoff);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT event_id,receiving_merchant_id,payload,payload_hash,received_at FROM webhook_inbox",
        }),
      ).toEqual(original);
      expect(
        rows({ path: files.merchant, sql: "SELECT id FROM orders" }),
      ).toEqual([]);
      if (index < 3) {
        clock = Date.parse(record.next_attempt_at);
        await advance({ worker, epochMs: clock });
      }
    }
  } finally {
    await worker?.stop();
    await merchant.stop();
  }
});
