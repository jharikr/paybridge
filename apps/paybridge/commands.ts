import { type } from "arktype";
import type { PaybridgeDatabase, PaybridgeTransaction } from "./database.ts";
import { hashSecret } from "./merchants.ts";
import type { merchantId, paymentId } from "../../contracts/payments.ts";

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}
export function commandHash(command: {
  operation: string;
  method: string;
  target: string;
  input: JsonValue;
}) {
  return hashSecret(canonical(command));
}
const acknowledgment = type({
  status: "100 <= number.integer <= 599",
  body: "string",
  headers: { "[string]": "string" },
});
export type CommandAcknowledgment = typeof acknowledgment.infer;
export type CommandIdentity = {
  merchantId: typeof merchantId.infer;
  key: string;
  operation: string;
  requestHash: string;
};

export type Reservation =
  | { kind: "new" }
  | { kind: "completed"; acknowledgment: CommandAcknowledgment }
  | { kind: "conflict" }
  | { kind: "in_progress" };
export async function reserveCommand({
  db,
  tx,
  identity,
}: {
  db: PaybridgeDatabase;
  tx: PaybridgeTransaction;
  identity: CommandIdentity;
}): Promise<Reservation> {
  const inserted = await tx.execute(
    db.raw.sql`
    INSERT INTO idempotency_keys (merchant_id, key, operation, request_hash, status, created_at)
    VALUES (${identity.merchantId}, ${identity.key}, ${identity.operation}, ${identity.requestHash}, 'IN_PROGRESS', ${new Date().toISOString()})
    ON CONFLICT(merchant_id, key) DO NOTHING
  `
      .affectedCount()
      .build(),
  );
  if (inserted.affectedRows === 1) return { kind: "new" };
  const found = await tx.orm.Command.where({
    merchantId: identity.merchantId,
    key: identity.key,
  }).first();
  if (!found) throw new Error("Reserved command could not be read");
  if (
    found.requestHash !== identity.requestHash ||
    found.operation !== identity.operation
  )
    return { kind: "conflict" };
  if (found.status === "IN_PROGRESS") return { kind: "in_progress" };
  if (found.responseHeaders === null)
    throw new Error("Completed command lacks acknowledgment headers");
  return {
    kind: "completed",
    acknowledgment: acknowledgment.assert({
      status: found.responseStatus,
      body: found.responseBody,
      headers: JSON.parse(found.responseHeaders),
    }),
  };
}
export async function completeCommand({
  db,
  tx,
  identity,
  resourceId,
  response,
}: {
  db: PaybridgeDatabase;
  tx: PaybridgeTransaction;
  identity: CommandIdentity;
  resourceId: typeof paymentId.infer;
  response: CommandAcknowledgment;
}) {
  await tx.execute(
    db.raw.sql`
    UPDATE idempotency_keys SET status = 'COMPLETED', resource_id = ${resourceId}, response_status = ${response.status},
      response_body = ${response.body}, response_headers = ${JSON.stringify(response.headers)}, completed_at = ${new Date().toISOString()}
    WHERE merchant_id = ${identity.merchantId} AND key = ${identity.key} AND status = 'IN_PROGRESS'
  `
      .affectedCount()
      .build(),
  );
}
