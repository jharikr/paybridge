import { type } from "arktype";
import { createMerchantApp } from "../../../apps/merchant/app.ts";
import { openMerchantDatabase } from "../../../apps/merchant/database.ts";
import { seedContexts } from "../../../apps/merchant/orders.ts";

const path = type("string").assert(process.argv[2]);
const fault = process.argv[3] ?? "none";
const epoch = Number(process.argv[4] ?? Date.now());
const tolerance = Number(process.argv[5] ?? 300);
const db = await openMerchantDatabase({ path });
await seedContexts({ db, origin: "http://127.0.0.1:3101" });
const app = await createMerchantApp({
  db,
  paybridgeOrigin: "http://127.0.0.1:3100",
  webhookNow: () => new Date(epoch),
  webhookToleranceSeconds: tolerance,
  receiptCheckpoint: async (event) => {
    if (fault === "rollback" && event.kind === "before-receipt-commit")
      throw new Error("Injected receipt rollback");
    if (event.kind !== fault) return;
    process.send?.(event);
    await new Promise<void>(() => {});
  },
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
