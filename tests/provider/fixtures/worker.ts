import { sensitiveFailure } from "../../support/failure.ts";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import {
  providerWorkerConfig,
  runProviderWorker,
} from "../../../apps/paybridge/provider-worker.ts";

const config = providerWorkerConfig(process.argv.slice(2, 7));
const db = await openPaybridgeDatabase({ path: config.path });
const controller = new AbortController();
const workerId = "test-result-worker";
let injected = false;
process.send?.({ kind: "ready", workerId });
try {
  await runProviderWorker({
    db,
    config,
    workerId,
    signal: controller.signal,
    beforeResultCommit: async () => {
      injected = true;
      throw sensitiveFailure();
    },
    diagnostic: (value) => {
      if (!injected)
        throw new Error("Result failed before the injected rollback");
      controller.abort();
      process.send?.({ kind: "result-rolled-back", failure: value.failure });
    },
  });
} finally {
  await db.close();
}
