import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openPaybridgeDatabase } from "./database.ts";
import { providerWorkerConfig, runProviderWorker } from "./provider-worker.ts";

const config = providerWorkerConfig(process.argv.slice(2));
await mkdir(dirname(config.path), { recursive: true });
const db = await openPaybridgeDatabase({ path: config.path });
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const workerId = `worker_${randomUUID()}`;
process.send?.({ kind: "ready", workerId });
try {
  await runProviderWorker({
    db,
    config,
    workerId,
    signal: controller.signal,
    diagnostic: (value) => process.stderr.write(`${JSON.stringify(value)}\n`),
  });
} finally {
  await db.close();
}
