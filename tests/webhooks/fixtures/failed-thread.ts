import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
import { type } from "arktype";

const { workerId } = type({ workerId: "string" }).assert(workerData);
const release = new BroadcastChannel(`webhook-failure-${workerId}`);
release.onmessage = (event) => {
  const message: unknown = event.data;
  type({ kind: "'fail'", "+": "reject" }).assert(message);
  throw new Error("Injected webhook thread failure");
};
parentPort?.postMessage({ kind: "ready" });
