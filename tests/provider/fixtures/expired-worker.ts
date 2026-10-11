import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import {
  providerWorkerConfig,
  runProviderWorker,
} from "../../../apps/paybridge/provider-worker.ts";

const config = providerWorkerConfig(process.argv.slice(2));
const db = await openPaybridgeDatabase({ path: config.path });
const controller = new AbortController();
const workerId = "test-expired-worker";
let offsetMs = 0;
process.on("message", (message: unknown) => {
  const command = type({
    kind: "'advance'",
    epochMs: "0 <= number.integer <= 8640000000000000",
    "+": "reject",
  }).assert(message);
  offsetMs = command.epochMs - Date.now();
  process.send?.({ kind: "advanced" });
});
process.send?.({ kind: "ready", workerId });
try {
  await runProviderWorker({
    db,
    config,
    workerId,
    signal: controller.signal,
    now: () => new Date(Date.now() + offsetMs),
    diagnostic: (value) => {
      controller.abort();
      process.send?.(value);
    },
  });
} finally {
  await db.close();
}
import { type } from "arktype";
