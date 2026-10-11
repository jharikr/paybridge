import { sensitiveFailure } from "../../support/failure.ts";
import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import { seedMerchants } from "../../../apps/paybridge/merchants.ts";
import { createPaybridgeApp } from "../../../apps/paybridge/app.ts";
const db = await openPaybridgeDatabase({
  path: type("string").assert(process.argv[2]),
});
await seedMerchants({ db, merchantOrigin: "http://127.0.0.1:3101" });
const app = await createPaybridgeApp({
  db,
  paybridgeOrigin: "http://127.0.0.1:3100",
  beforeCreationCommit: async () => {
    throw sensitiveFailure();
  },
});
process.send?.({
  kind: "ready",
  url: await app.listen({ host: "127.0.0.1", port: 0 }),
});
