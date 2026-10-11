import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import { seedMerchants } from "../../../apps/paybridge/merchants.ts";
import { createPaybridgeApp } from "../../../apps/paybridge/app.ts";

const path = type("string > 0").assert(process.argv[2]);
const fault = type("'rollback' | 'before-commit' | 'after-commit'").assert(
  process.argv[3],
);
const db = await openPaybridgeDatabase({ path });
await seedMerchants({ db, merchantOrigin: "http://127.0.0.1:3101" });
let failOnce = true;
const app = await createPaybridgeApp({
  db,
  paybridgeOrigin: "http://127.0.0.1:3100",
  beforeCreationCommit: async () => {
    if (fault === "before-commit") {
      process.send?.({ kind: "before-commit" });
      await new Promise<void>(() => {});
    }
    if (fault === "rollback" && failOnce) {
      failOnce = false;
      throw new Error("Injected failure before commit");
    }
  },
});
app.addHook("onSend", async (_request, reply, payload) => {
  if (fault === "after-commit" && reply.statusCode === 201) {
    process.send?.({ kind: "after-commit" });
    await new Promise<void>(() => {});
  }
  return payload;
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
