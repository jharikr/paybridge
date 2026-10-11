import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { rows, workerReady } from "../provider/support.ts";

test("production inbox readiness follows database setup and SIGTERM interrupts a long idle poll", async () => {
  await using files = await isolatedDatabases();
  const worker = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("../../apps/merchant/worker.ts", import.meta.url),
    ),
    args: [files.merchant, "10000", "60000"],
  });
  try {
    workerReady.assert(await worker.message());
    expect(
      rows({ path: files.merchant, sql: "SELECT * FROM webhook_inbox" }),
    ).toEqual([]);
    const exited = once(worker.child, "exit", {
      signal: AbortSignal.timeout(2000),
    });
    worker.child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
    expect(
      rows({ path: files.merchant, sql: "SELECT * FROM webhook_inbox" }),
    ).toEqual([]);
  } finally {
    await worker.stop();
  }
});
