import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import {
  runWebhookWorker,
  webhookWorkerConfig,
} from "../../../apps/paybridge/webhook-worker.ts";
const path = type("string").assert(process.argv[2]);
const held = type(
  "'none'|'after-webhook-claim'|'after-webhook-response'|'before-webhook-completion-commit'",
).assert(process.argv[3] ?? "none");
const config = webhookWorkerConfig(process.argv.slice(4));
const input = type({ kind: "'start'", "+": "reject" })
  .or({ kind: "'release'", "+": "reject" })
  .or({
    kind: "'advance'",
    epochMs: "0 <= number.integer <= 8640000000000000",
    "+": "reject",
  });
const db = await openPaybridgeDatabase({ path });
const workerId = `webhook-test-${randomUUID()}`;
let clock: number | undefined;
let release: (() => void) | undefined;
const start = new Promise<void>((resolve) =>
  process.on("message", (message: unknown) => {
    const command = input.assert(message);
    switch (command.kind) {
      case "start":
        resolve();
        break;
      case "release":
        release?.();
        process.send?.({ kind: "released" });
        break;
      case "advance":
        clock = command.epochMs;
        process.send?.({ kind: "advanced" });
        break;
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }),
);
process.send?.({ kind: "ready", workerId });
await start;
process.send?.({ kind: "loop-started" });
let heldOnce = false;
try {
  await runWebhookWorker({
    db,
    workerId,
    config,
    signal: new AbortController().signal,
    now: () => new Date(clock ?? Date.now()),
    checkpoint: async (event) => {
      if (event.kind !== held || heldOnce) return;
      heldOnce = true;
      process.send?.(event);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    diagnostic: (value) => process.send?.(value),
  });
} finally {
  await db.close();
}
