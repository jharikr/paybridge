import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type } from "arktype";
import { openPaybridgeDatabase } from "./database.ts";
import { seedMerchants } from "./merchants.ts";
import { serviceOrigin } from "./config.ts";
import { createPaybridgeApp } from "./app.ts";

const path = type("string > 0").assert(process.argv[2] ?? ".data/paybridge.db");
const port = type("0 <= number.integer <= 65535").assert(
  Number(process.argv[3] ?? "3100"),
);
const merchantOrigin = serviceOrigin(
  process.env["MERCHANT_ORIGIN"] ?? "http://127.0.0.1:3101",
);
const paybridgeOrigin = serviceOrigin(
  process.env["PAYBRIDGE_ORIGIN"] ?? "http://127.0.0.1:3100",
);
await mkdir(dirname(path), { recursive: true });
const db = await openPaybridgeDatabase({ path });
await seedMerchants({ db, merchantOrigin });
const app = await createPaybridgeApp({ db, paybridgeOrigin });
const url = await app.listen({ host: "127.0.0.1", port });
process.send?.({ kind: "ready", url });
