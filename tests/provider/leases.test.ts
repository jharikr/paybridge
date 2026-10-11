import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, create, journey, lookup, rows } from "./support.ts";

test.each([
  { lock: "writer", transaction: "BEGIN IMMEDIATE", executions: 1 },
  { lock: "reader delaying claim commit", transaction: "BEGIN", executions: 2 },
])(
  "$lock does not cause a submission under an exhausted lease",
  async ({ transaction, executions }) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    const { id } = type({ id: "string" }).assert(
      await (await create(app.url)).json(),
    );
    expect((await confirm(app.url, id)).status).toBe(202);
    const worker = await app.startWorker({
      entrypoint: fileURLToPath(
        new URL("./fixtures/lease-worker.ts", import.meta.url),
      ),
      timeout: 300,
      lease: 500,
    });
    const blocker = new DatabaseSync(files.paybridge);
    try {
      blocker.exec(transaction);
      blocker.prepare("SELECT id FROM provider_outbox").all();
      worker.child.send({ kind: "start" });
      expect(await worker.message()).toEqual({ kind: "loop-started" });
      await delay(800);
      blocker.exec("COMMIT");
    } finally {
      blocker.close();
    }
    await expect
      .poll(() => lookup(app.url, id), { timeout: 2000 })
      .toMatchObject({ status: "SUCCEEDED", revision: 3 });
    expect(
      rows(
        files.paybridge,
        "SELECT attempt_count, status FROM provider_outbox",
      ),
    ).toEqual([{ attempt_count: executions, status: "COMPLETED" }]);
    expect(
      rows(
        files.paybridge,
        "SELECT type FROM payment_events WHERE type = 'PROVIDER_RESPONSE_OBSERVED'",
      ),
    ).toEqual([]);
    expect(rows(files.paybridge, "SELECT id FROM reconciliations")).toEqual([]);
    expect(
      rows(
        files.mockFourcs,
        "SELECT final_outcome, effect_count FROM mock_transactions",
      ),
    ).toEqual([{ final_outcome: "Approved", effect_count: 1 }]);
  },
);
