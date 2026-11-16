import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { type } from "arktype";
import { openPaybridgeDatabase } from "./database.ts";
import { providerWorkerConfig, runProviderWorker } from "./provider-worker.ts";
import { webhookWorkerConfig } from "./webhook-worker.ts";

export async function runPaybridgeWorkers({
  args,
  signal,
  ready,
  deliveryEntrypoint = new URL("./webhook-thread.ts", import.meta.url),
}: {
  args: string[];
  signal: AbortSignal;
  ready: (event: { workerId: string }) => void;
  deliveryEntrypoint?: URL;
}) {
  const config = providerWorkerConfig(args);
  const webhookArgs = args.slice(2);
  webhookWorkerConfig(webhookArgs);
  await mkdir(dirname(config.path), { recursive: true });
  const db = await openPaybridgeDatabase({ path: config.path });
  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (signal.aborted) controller.abort();
  const workerId = `worker_${randomUUID()}`;
  // SQLite busy waits block their Node event loop; give delivery its own loop and connection.
  const webhook = new Worker(deliveryEntrypoint, {
    workerData: { path: config.path, workerId, args: webhookArgs },
  });
  controller.signal.addEventListener(
    "abort",
    () => webhook.postMessage({ kind: "stop" }),
    { once: true },
  );
  if (controller.signal.aborted) webhook.postMessage({ kind: "stop" });
  const delivery = new Promise<void>((resolve, reject) => {
    webhook.once("message", (message: unknown) => {
      if (!type({ kind: "'ready'", "+": "reject" }).allows(message)) {
        controller.abort();
        void webhook.terminate();
        reject(new Error("Invalid webhook thread readiness"));
        return;
      }
      ready({ workerId });
    });
    webhook.once("error", () => {
      controller.abort();
      reject(new Error("Webhook delivery thread failed"));
    });
    webhook.once("exit", (code) => {
      const stopping = controller.signal.aborted;
      controller.abort();
      if (code === 0 && stopping) resolve();
      else reject(new Error("Webhook delivery thread exited unexpectedly"));
    });
  });
  const provider = runProviderWorker({
    db,
    config,
    workerId,
    signal: controller.signal,
    diagnostic: (value) => process.stderr.write(`${JSON.stringify(value)}\n`),
  });
  try {
    await Promise.all([provider, delivery]);
  } finally {
    controller.abort();
    await Promise.allSettled([provider, delivery]);
    await db.close();
  }
}
