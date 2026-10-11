import { sensitiveFailure } from "../../support/failure.ts";
import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { openMerchantDatabase } from "../../../apps/merchant/database.ts";
import {
  inboxWorkerConfig,
  runInboxWorker,
} from "../../../apps/merchant/inbox-worker.ts";

const path = type("string > 0").assert(process.argv[2]);
const held = type(
  "'none'|'after-inbox-claim'|'before-inbox-completion-commit'|'after-inbox-completion'|'rollback'",
).assert(process.argv[3]);
const config = inboxWorkerConfig(process.argv.slice(4));
const instruction = type({ kind: "'start'", "+": "reject" })
  .or({ kind: "'release'", "+": "reject" })
  .or({
    kind: "'advance'",
    epochMs: "0 <= number.integer <= 8640000000000000",
    "+": "reject",
  });
const db = await openMerchantDatabase({ path });
const workerId = `inbox-test-${randomUUID()}`;
let clock: number | undefined;
let release: (() => void) | undefined;
const start = new Promise<void>((resolve) =>
  process.on("message", (message: unknown) => {
    const command = instruction.assert(message);
    switch (command.kind) {
      case "start":
        resolve();
        break;
      case "release":
        release?.();
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
await runInboxWorker({
  db,
  workerId,
  config,
  signal: new AbortController().signal,
  now: () => new Date(clock ?? Date.now()),
  checkpoint: async (event) => {
    if (held === "rollback" && event.kind === "before-inbox-completion-commit")
      throw sensitiveFailure();
    if (event.kind !== held || heldOnce) return;
    heldOnce = true;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    process.send?.(event);
    await waiting;
  },
  diagnostic: (value) => process.send?.(value),
});
