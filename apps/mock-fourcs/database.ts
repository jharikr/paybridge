import { safeFailure } from "../../contracts/diagnostics.ts";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSqliteControlClient } from "@prisma/orm-sqlite/control";
import sqlite from "@prisma/orm-sqlite/runtime";
import type { FourcsRequest } from "../../contracts/fourcs.ts";
import type { Contract } from "./contract.d.ts";
import contractJson from "./contract.json" with { type: "json" };

export async function openMockDatabase({ path }: { path: string }) {
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
      cause: safeFailure({ operation: "mock_migration", cause }),
    });
  } finally {
    await control.close();
  }
  const db = sqlite<Contract>({ contractJson, path });
  await db.connect();
  return db;
}
export type MockDatabase = Awaited<ReturnType<typeof openMockDatabase>>;

export async function acceptTransaction({
  db,
  request,
}: {
  db: MockDatabase;
  request: FourcsRequest;
}) {
  const finalOutcome =
    request.paymentMethodRef === "pm_mock_declined" ||
    request.paymentMethodRef === "pm_mock_decline_lost_response"
      ? "Declined"
      : request.paymentMethodRef === "pm_mock_incomplete"
        ? "Incomplete"
        : "Approved";
  const hostReference = randomUUID().replaceAll("-", "").slice(0, 16);
  const approvalCode = finalOutcome === "Approved" ? "MOCK01" : null;
  const effectCount = finalOutcome === "Approved" ? 1 : 0;
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  const id = `${request.providerAccount}:${request.tranId}`;
  const inserted = await db.runtime().execute(
    db.raw.sql`
    INSERT INTO mock_transactions (id, provider_account, tran_id, invoice, amount_minor, currency, payment_method_ref, request_fingerprint, final_outcome, effect_count, host_reference, approval_code, accepted_at)
    VALUES (${id}, ${request.providerAccount}, ${request.tranId}, ${request.invoice}, ${request.amountMinor}, ${request.currency}, ${request.paymentMethodRef}, ${requestFingerprint}, ${finalOutcome}, ${effectCount}, ${hostReference}, NULLIF(${approvalCode ?? ""}, ''), ${new Date().toISOString()})
    ON CONFLICT (provider_account, tran_id) DO NOTHING
  `
      .affectedCount()
      .build(),
  );
  if (inserted.affectedRows === 0) return { kind: "duplicate" } as const;
  return {
    kind: "accepted" as const,
    finalOutcome,
    hostReference,
    approvalCode,
  };
}
