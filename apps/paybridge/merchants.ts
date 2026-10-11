import { createHash } from "node:crypto";
import { type } from "arktype";
import { merchantId } from "../../contracts/payments.ts";
import type { PaybridgeDatabase } from "./database.ts";

export const hashSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const authenticatedMerchant = type({
  id: merchantId,
  returnOrigin: "string",
  providerAccountRef: "'mock-account-a' | 'mock-account-b'",
});
export type AuthenticatedMerchant = typeof authenticatedMerchant.infer;

export async function seedMerchants({
  db,
  merchantOrigin,
}: {
  db: PaybridgeDatabase;
  merchantOrigin: string;
}) {
  await db.transaction(async (tx) => {
    for (const letter of ["a", "b"]) {
      const id = `merchant-${letter}`;
      await tx.execute(
        db.raw.sql`
        INSERT INTO merchants (id, name, provider_account_ref, api_key_hash, webhook_url, webhook_secret, return_origin, is_active, created_at)
        VALUES (${id}, ${`Synthetic merchant ${letter.toUpperCase()}`}, ${`mock-account-${letter}`}, ${hashSecret(`mock-paybridge-key-${letter}`)},
          ${`${merchantOrigin}/api/webhooks/paybridge/${id}`}, ${`mock-webhook-secret-${letter}`}, ${merchantOrigin}, 1, ${new Date().toISOString()})
        ON CONFLICT(id) DO NOTHING
      `
          .affectedCount()
          .build(),
      );
    }
  });
}

export async function authenticateMerchant({
  db,
  authorization,
}: {
  db: PaybridgeDatabase;
  authorization: unknown;
}) {
  if (
    typeof authorization !== "string" ||
    !/^Bearer [A-Za-z0-9_-]{1,256}$/.test(authorization)
  )
    return null;
  const found = await db.orm.Merchant.where({
    apiKeyHash: hashSecret(authorization.slice(7)),
    isActive: 1,
  }).first();
  if (!found) return null;
  return authenticatedMerchant.assert({
    id: found.id,
    returnOrigin: found.returnOrigin,
    providerAccountRef: found.providerAccountRef,
  });
}
