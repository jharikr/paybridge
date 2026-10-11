import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type } from "arktype";
import { serviceOrigin } from "../paybridge/config.ts";
import { openMerchantDatabase } from "./database.ts";
import { seedContexts } from "./orders.ts";
import { createMerchantApp } from "./app.ts";

const path = type("string > 0").assert(process.argv[2] ?? ".data/merchant.db");
const port = type("0 <= number.integer <= 65535").assert(
  Number(process.argv[3] ?? "3101"),
);
const paybridgeOrigin = serviceOrigin(
  process.argv[4] ?? "http://127.0.0.1:3100",
);
const merchantOrigin = serviceOrigin(
  process.argv[5] ?? "http://127.0.0.1:3101",
);
await mkdir(dirname(path), { recursive: true });
const db = await openMerchantDatabase({ path });
await seedContexts({ db, origin: merchantOrigin });
const webhookToleranceSeconds = type("0 <= number.integer <= 3600").assert(
  Number(process.env["WEBHOOK_TOLERANCE_SECONDS"] ?? 300),
);
const app = await createMerchantApp({
  db,
  paybridgeOrigin,
  webhookToleranceSeconds,
});
const url = await app.listen({ host: "127.0.0.1", port });
process.send?.({ kind: "ready", url });
