import { BroadcastChannel } from "node:worker_threads";
import { type } from "arktype";
import { runPaybridgeWorkers } from "../../../apps/paybridge/worker-process.ts";

const mode = type("'failure' | 'exit' | 'startup'").assert(process.argv[7]);
const entrypoints = {
  failure: "./failed-thread.ts",
  exit: "./exited-thread.ts",
  startup: "./startup-failure-thread.ts",
};
let release: BroadcastChannel | undefined;
process.on("message", (message: unknown) => {
  type({ kind: "'fail'", "+": "reject" }).assert(message);
  if (!release) throw new Error("Fault release requires a ready thread");
  release.postMessage(message);
});
try {
  await runPaybridgeWorkers({
    args: process.argv.slice(2, 7),
    signal: new AbortController().signal,
    deliveryEntrypoint: new URL(entrypoints[mode], import.meta.url),
    ready: ({ workerId }) => {
      release = new BroadcastChannel(`webhook-failure-${workerId}`);
      process.send?.({ kind: "ready", workerId });
    },
  });
} catch {
  process.send?.({ kind: "failed" });
  process.exitCode = 1;
} finally {
  release?.close();
  process.disconnect?.();
}
