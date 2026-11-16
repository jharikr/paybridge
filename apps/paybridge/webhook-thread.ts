import { parentPort, workerData } from "node:worker_threads";
import { type } from "arktype";
import { openPaybridgeDatabase } from "./database.ts";
import { runWebhookWorker, webhookWorkerConfig } from "./webhook-worker.ts";
const input = type({
  path: "string",
  workerId: "string",
  args: "string[]",
  "+": "reject",
}).assert(workerData);
const port = parentPort;
if (!port) throw new Error("Webhook thread requires its worker process");
const controller = new AbortController();
port.on("message", (message: unknown) => {
  type({ kind: "'stop'", "+": "reject" }).assert(message);
  controller.abort();
});
const db = await openPaybridgeDatabase({ path: input.path });
port.postMessage({ kind: "ready" });
try {
  await runWebhookWorker({
    db,
    config: webhookWorkerConfig(input.args),
    workerId: input.workerId,
    signal: controller.signal,
    diagnostic: (value) => process.stderr.write(`${JSON.stringify(value)}\n`),
  });
} finally {
  await db.close();
  port.close();
}
