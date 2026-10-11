import { safeFailure } from "../../contracts/diagnostics.ts";
import { fileURLToPath } from "node:url";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import sqlite from "@prisma/orm-sqlite/runtime";
import type { Contract } from "./contract.d.ts";
import contractJson from "./contract.json" with { type: "json" };

export async function openMerchantDatabase({ path }: { path: string }) {
  const control = createSqliteControlClient();
  try {
    const result = await control.migrate({
      connection: path,
      contract: contractJson,
      migrationsDir: fileURLToPath(new URL("./migrations", import.meta.url)),
    });
    if (!result.ok) throw result.failure;
  } catch (cause) {
    throw new Error("Database migration failed", {
      cause: safeFailure({ operation: "merchant_migration", cause }),
    });
  } finally {
    await control.close();
  }
  const db = sqlite<Contract>({ contractJson, path });
  await db.connect();
  try {
    // Prisma verifies its contract marker on first use; keep that read outside command transactions.
    await db
      .runtime()
      .query(
        db.raw.sql`SELECT 1 AS initialized`
          .returnsRow({ initialized: "sqlite/integer@1" })
          .build(),
      );
  } catch (cause) {
    await db.close();
    throw cause;
  }
  return db;
}
export type MerchantDatabase = Awaited<ReturnType<typeof openMerchantDatabase>>;
export type MerchantTransaction = Parameters<
  Parameters<MerchantDatabase["transaction"]>[0]
>[0];
