import { runPaybridgeWorkers } from "./worker-process.ts";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
await runPaybridgeWorkers({
  args: process.argv.slice(2),
  signal: controller.signal,
  ready: ({ workerId }) => process.send?.({ kind: "ready", workerId }),
});
