import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import { seedMerchants } from "../../../apps/paybridge/merchants.ts";
import { createPaybridgeApp } from "../../../apps/paybridge/app.ts";

const path = type("string > 0").assert(process.argv[2]);
const fault = type(
  "'rollback' | 'before-commit' | 'after-commit' | 'lookup'",
).assert(process.argv[3]);
const db = await openPaybridgeDatabase({ path });
await seedMerchants({ db, merchantOrigin: "http://127.0.0.1:3101" });
let first = true;
let holdLookup = false;
let release: (() => void) | undefined;
process.on("message", (message: unknown) => {
  const command = type({
    kind: "'hold-lookup' | 'release' | 'deactivate'",
  }).assert(message);
  if (command.kind === "hold-lookup") {
    holdLookup = true;
    process.send?.({ kind: "holding" });
  }
  if (command.kind === "release") release?.();
  if (command.kind === "deactivate")
    void db
      .transaction((tx) =>
        tx.execute(
          db.raw.sql`UPDATE merchants SET is_active = 0 WHERE id = 'merchant-a'`
            .affectedCount()
            .build(),
        ),
      )
      .then(() => process.send?.({ kind: "deactivated" }));
});
const app = await createPaybridgeApp({
  db,
  paybridgeOrigin: "http://127.0.0.1:3100",
  beforeConfirmationCommit: async () => {
    if (!first) return;
    first = false;
    if (fault === "rollback") throw new Error("Injected checkout rollback");
    if (fault === "before-commit") {
      process.send?.({ kind: "before-commit" });
      await new Promise<void>(() => {});
    }
  },
});
app.addHook("onSend", async (request, reply, payload) => {
  if (fault === "after-commit" && reply.statusCode === 303) {
    process.send?.({ kind: "after-commit" });
    await new Promise<void>(() => {});
  }
  if (
    fault === "lookup" &&
    holdLookup &&
    request.method === "GET" &&
    request.url.startsWith("/v1/payment-intents/") &&
    reply.statusCode === 200
  ) {
    holdLookup = false;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    process.send?.({ kind: "lookup-held" });
    await wait;
  }
  return payload;
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
