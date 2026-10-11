import { type } from "arktype";
import { serviceOrigin } from "../../../apps/paybridge/config.ts";
import { openMerchantDatabase } from "../../../apps/merchant/database.ts";
import { seedContexts } from "../../../apps/merchant/orders.ts";
import { createMerchantApp } from "../../../apps/merchant/app.ts";

const path = type("string > 0").assert(process.argv[2]);
const paybridgeOrigin = serviceOrigin(process.argv[3]);
const fault = type("'rollback' | 'before-commit'").assert(process.argv[4]);
const db = await openMerchantDatabase({ path });
await seedContexts({ db, origin: "http://127.0.0.1:3101" });
const app = await createMerchantApp({
  db,
  paybridgeOrigin,
  beforeSnapshotCommit: async () => {
    if (fault === "rollback") throw new Error("Injected snapshot rollback");
    process.send?.({ kind: "before-commit" });
    await new Promise<void>(() => {});
  },
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
