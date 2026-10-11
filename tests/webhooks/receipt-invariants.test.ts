import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { payload, receiver, signed } from "./support.ts";

test("authenticated receipt facts and completed work remain immutable and retained", async () => {
  await using files = await isolatedDatabases();
  const app = await receiver({ path: files.merchant });
  try {
    expect(
      (
        await fetch(`${app.url}/api/webhooks/paybridge/merchant-a`, {
          method: "POST",
          body: payload,
          headers: signed({ body: payload }),
        })
      ).status,
    ).toBe(204);
    const db = new DatabaseSync(files.merchant);
    try {
      for (const sql of [
        "DELETE FROM webhook_inbox",
        "UPDATE webhook_inbox SET receiving_merchant_id='merchant-b'",
        "UPDATE webhook_inbox SET revision=4",
        "UPDATE webhook_inbox SET payload='{}'",
        "UPDATE webhook_inbox SET payload_hash='other'",
        "UPDATE webhook_inbox SET status='INVALID'",
        "UPDATE webhook_inbox SET status='PROCESSING'",
        "UPDATE webhook_inbox SET status='PROCESSED'",
        "UPDATE webhook_inbox SET attempt_count=-1",
      ])
        expect(() => db.exec(sql), sql).toThrow();
      db.exec(
        "UPDATE webhook_inbox SET status='PROCESSING',attempt_count=1,claim_token='token',locked_by='worker',lease_expires_at='2026-10-11T12:01:00.000Z'",
      );
      expect(() =>
        db.exec("UPDATE webhook_inbox SET attempt_count=0"),
      ).toThrow();
      db.exec(
        "UPDATE webhook_inbox SET status='PROCESSED',processed_at='2026-10-11T12:00:02.000Z',claim_token=NULL,locked_by=NULL,lease_expires_at=NULL",
      );
      expect(() =>
        db.exec("UPDATE webhook_inbox SET status='PENDING',processed_at=NULL"),
      ).toThrow();
    } finally {
      db.close();
    }
  } finally {
    await app.stop();
  }
});
