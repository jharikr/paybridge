import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import { seedMerchants } from "../../../apps/paybridge/merchants.ts";
import { createPaybridgeApp } from "../../../apps/paybridge/app.ts";

const path = type("string > 0").assert(process.argv[2]);
const operation = type("'confirm' | 'cancel'").assert(process.argv[3]);
const fault = type("'rollback' | 'before-commit' | 'after-commit'").assert(
  process.argv[4],
);
const db = await openPaybridgeDatabase({ path });
await seedMerchants({ db, merchantOrigin: "http://127.0.0.1:3101" });
let first = true;
const beforeCommit = async () => {
  if (!first) return;
  first = false;
  if (fault === "rollback") throw new Error("Injected command rollback");
  if (fault === "before-commit") {
    process.send?.({ kind: "before-commit" });
    await new Promise<void>(() => {});
  }
};
const app = await createPaybridgeApp({
  db,
  paybridgeOrigin: "http://127.0.0.1:3100",
  ...(operation === "confirm"
    ? { beforeConfirmationCommit: beforeCommit }
    : { beforeCancellationCommit: beforeCommit }),
});
app.addHook("onSend", async (request, reply, payload) => {
  if (
    fault === "after-commit" &&
    request.url.endsWith(`/${operation}`) &&
    reply.statusCode === (operation === "confirm" ? 202 : 200)
  ) {
    process.send?.({ kind: "after-commit" });
    await new Promise<void>(() => {});
  }
  return payload;
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
