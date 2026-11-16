import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import {
  providerWorkerConfig,
  runProviderWorker,
} from "../../../apps/paybridge/provider-worker.ts";

const config = providerWorkerConfig(process.argv.slice(2));
const db = await openPaybridgeDatabase({ path: config.path });
const controller = new AbortController();
const workerId = "test-lease-worker";
const start = new Promise<void>((resolve) => {
  process.once("message", (message: unknown) => {
    type({ kind: "'start'", "+": "reject" }).assert(message);
    resolve();
  });
});
process.send?.({ kind: "ready", workerId });
await start;
process.send?.({ kind: "loop-started" });
try {
  await runProviderWorker({
    db,
    config,
    workerId,
    signal: controller.signal,
    diagnostic: (value) => process.send?.(value),
  });
} finally {
  await db.close();
}
