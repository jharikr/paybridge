import { type } from "arktype";
import { serviceOrigin } from "../../../apps/paybridge/config.ts";
import { openMerchantDatabase } from "../../../apps/merchant/database.ts";
import { seedContexts } from "../../../apps/merchant/orders.ts";
import { createMerchantApp } from "../../../apps/merchant/app.ts";

const path = type("string").assert(process.argv[2]);
const paybridgeOrigin = serviceOrigin(process.argv[4]);
const fault = type(
  "'prepared' | 'received' | 'before-completion-commit' | 'rollback'",
).assert(process.argv[5]);
const db = await openMerchantDatabase({ path });
await seedContexts({ db, origin: "http://127.0.0.1:3101" });
const app = await createMerchantApp({
  db,
  paybridgeOrigin,
  checkpoint: async (event) => {
    if (fault === "rollback" && event.kind === "before-completion-commit")
      throw new Error("Injected local completion rollback");
    if (event.kind !== fault) return;
    process.send?.(event);
    await new Promise<void>(() => {});
  },
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
