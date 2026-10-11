import { fileURLToPath } from "node:url";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import sqlite from "@prisma/orm-sqlite/runtime";
import type { Contract } from "./contract.d.ts";
import contractJson from "./contract.json" with { type: "json" };

export async function openProofDatabase({ path }: { path: string }) {
  const control = createSqliteControlClient();
  try {
    const result = await control.migrate({
      connection: path,
      contract: contractJson,
      migrationsDir: fileURLToPath(new URL("./migrations", import.meta.url)),
    });
    if (!result.ok)
      throw new Error("Stack proof migration failed", { cause: result });
  } finally {
    await control.close();
  }

  const db = sqlite<Contract>({ contractJson, path });
  await db.connect();
  return db;
}

export type ProofDatabase = Awaited<ReturnType<typeof openProofDatabase>>;

export async function writeProofRecord({
  db,
  record,
  afterWrites,
}: {
  db: ProofDatabase;
  record: Required<
    Pick<
      Parameters<ProofDatabase["orm"]["ProofRecord"]["create"]>[0],
      "id" | "label" | "amount"
    >
  >;
  afterWrites?: () => Promise<void>;
}) {
  return db.transaction(async (tx) => {
    await tx.orm.ProofRecord.create({ ...record, label: "" });
    const result = await tx.execute(
      db.raw.sql`
      UPDATE proof_records SET label = ${record.label} WHERE id = ${record.id}
    `
        .affectedCount()
        .build(),
    );
    await afterWrites?.();
    return result;
  });
}
