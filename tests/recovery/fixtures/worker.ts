import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import {
  providerWorkerConfig,
  runProviderWorker,
} from "../../../apps/paybridge/provider-worker.ts";

const config = providerWorkerConfig(process.argv.slice(2, 7));
const held = type("'none' | 'after-claim' | 'before-result-commit'").assert(
  process.argv[7] ?? "none",
);
const command = type({ kind: "'start'", "+": "reject" })
  .or({
    kind: "'advance'",
    epochMs: "0 <= number.integer <= 8640000000000000",
    "+": "reject",
  })
  .or({ kind: "'release'", "+": "reject" });
const db = await openPaybridgeDatabase({ path: config.path });
const workerId = `recovery_${randomUUID()}`;
let offsetMs = 0;
let release: (() => void) | undefined;
const start = new Promise<void>((resolve) => {
  process.on("message", (message: unknown) => {
    const input = command.assert(message);
    switch (input.kind) {
      case "start":
        resolve();
        break;
      case "advance":
        offsetMs = input.epochMs - Date.now();
        process.send?.({ kind: "advanced" });
        break;
      case "release":
        release?.();
        break;
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  });
});
async function checkpoint(kind: "after-claim" | "before-result-commit") {
  const wait =
    held === kind
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
  process.send?.({ kind, workerId });
  await wait;
}
process.send?.({ kind: "ready", workerId });
await start;
process.send?.({ kind: "loop-started" });
try {
  await runProviderWorker({
    db,
    config,
    workerId,
    signal: new AbortController().signal,
    now: () => new Date(Date.now() + offsetMs),
    afterClaim: () => checkpoint("after-claim"),
    ...(held === "before-result-commit"
      ? { beforeResultCommit: () => checkpoint("before-result-commit") }
      : {}),
    diagnostic: (value) => process.send?.(value),
  });
} finally {
  await db.close();
}
