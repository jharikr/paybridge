import { type } from "arktype";
import { openPaybridgeDatabase } from "../../../apps/paybridge/database.ts";
import { seedMerchants } from "../../../apps/paybridge/merchants.ts";
import { createPaybridgeApp } from "../../../apps/paybridge/app.ts";
const path = type("string").assert(process.argv[2]);
const origin = type("string").assert(process.argv[3]);
const db = await openPaybridgeDatabase({ path });
await seedMerchants({ db, merchantOrigin: origin });
const app = await createPaybridgeApp({
  db,
  paybridgeOrigin: "http://127.0.0.1:3100",
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
