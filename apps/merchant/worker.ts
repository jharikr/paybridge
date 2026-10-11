import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type } from "arktype";
import { openMerchantDatabase } from "./database.ts";
import { inboxWorkerConfig, runInboxWorker } from "./inbox-worker.ts";

const path = type("string > 0").assert(process.argv[2] ?? ".data/merchant.db");
const config = inboxWorkerConfig(process.argv.slice(3));
await mkdir(dirname(path), { recursive: true });
const db = await openMerchantDatabase({ path });
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const workerId = `inbox_${randomUUID()}`;
process.send?.({ kind: "ready", workerId });
try {
  await runInboxWorker({
    db,
    config,
    workerId,
    signal: controller.signal,
    diagnostic: (value) => process.stderr.write(`${JSON.stringify(value)}\n`),
  });
} finally {
  await db.close();
}
