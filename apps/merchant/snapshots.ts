import { type } from "arktype";
import {
  merchantPaymentSnapshot,
  merchantReturnResult,
  orderId,
} from "../../contracts/merchant.ts";
import type { MerchantFixture } from "../../contracts/merchant.ts";
import type { paymentId } from "../../contracts/payments.ts";
import type { MerchantDatabase, MerchantTransaction } from "./database.ts";
import type { MerchantContext } from "./config.ts";
import { lookupOrderPayment, parseJson } from "./paybridge.ts";
import { MerchantError } from "./orders.ts";

type SnapshotApplication =
  | { kind: "unmatched" }
  | { kind: "conflict" }
  | { kind: "applied" | "stale"; result: typeof merchantReturnResult.infer };

export async function applyPaymentSnapshot({
  db,
  tx,
  receivingMerchantId,
  snapshot,
}: {
  db: MerchantDatabase;
  tx: MerchantTransaction;
  receivingMerchantId: MerchantFixture;
  snapshot: typeof merchantPaymentSnapshot.infer;
}): Promise<SnapshotApplication> {
  await tx.execute(
    db.raw
      .sql`UPDATE merchant_payments SET updated_at = updated_at WHERE payment_intent_id = ${snapshot.paymentIntentId} AND merchant_id = ${receivingMerchantId}`
      .affectedCount()
      .build(),
  );
  const payment = await tx.orm.MerchantPayment.where({
    paymentIntentId: snapshot.paymentIntentId,
    merchantId: receivingMerchantId,
  }).first();
  if (!payment) return { kind: "unmatched" };
  const order = await tx.orm.Order.where({
    id: payment.orderId,
    merchantId: receivingMerchantId,
  }).first();
  if (
    !order ||
    order.amount !== snapshot.amount ||
    order.currency !== snapshot.currency ||
    order.businessReference !== snapshot.merchantReference
  )
    return { kind: "conflict" };
  if (snapshot.revision <= payment.lastAppliedRevision) {
    return {
      kind: "stale",
      result: merchantReturnResult.assert({
        orderId: order.id,
        state: order.state,
        paidAt: order.paidAt,
        payment: parseJson(payment.snapshot ?? "null"),
      }),
    };
  }
  const now = new Date().toISOString();
  await tx.execute(
    db.raw.sql`
    UPDATE merchant_payments SET status = ${snapshot.status}, snapshot = ${JSON.stringify(snapshot)}, last_applied_revision = ${snapshot.revision}, updated_at = ${now}
    WHERE payment_intent_id = ${snapshot.paymentIntentId} AND merchant_id = ${receivingMerchantId} AND last_applied_revision < ${snapshot.revision}
  `
      .affectedCount()
      .build(),
  );
  if (snapshot.status === "SUCCEEDED") {
    await tx.execute(
      db.raw
        .sql`UPDATE orders SET state = 'PAID', paid_at = ${now}, updated_at = ${now} WHERE id = ${order.id} AND merchant_id = ${receivingMerchantId} AND state = 'UNPAID'`
        .affectedCount()
        .build(),
    );
  }
  const paid = snapshot.status === "SUCCEEDED" || order.state === "PAID";
  return {
    kind: "applied",
    result: merchantReturnResult.assert({
      orderId: order.id,
      state: paid ? "PAID" : "UNPAID",
      paidAt: paid ? (order.paidAt ?? now) : null,
      payment: snapshot,
    }),
  };
}

async function commitSnapshot({
  db,
  merchant,
  snapshot,
  beforeCommit,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  snapshot: typeof merchantPaymentSnapshot.infer;
  beforeCommit?: () => Promise<void>;
}) {
  return db.transaction(async (tx) => {
    const applied = await applyPaymentSnapshot({
      db,
      tx,
      receivingMerchantId: merchant.id,
      snapshot,
    });
    if (applied.kind === "unmatched")
      throw new MerchantError(404, "payment_not_found");
    if (applied.kind === "conflict")
      throw new MerchantError(502, "payment_binding_conflict");
    await beforeCommit?.();
    return applied.result;
  });
}

export async function lookupAndApplyPayment({
  db,
  merchant,
  id,
  paybridgeOrigin,
  beforeCommit,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
  paybridgeOrigin: string;
  beforeCommit?: () => Promise<void>;
}) {
  const snapshot = await lookupOrderPayment({
    db,
    merchant,
    id,
    paybridgeOrigin,
  });
  const common = merchantPaymentSnapshot({
    paymentIntentId: snapshot.id,
    merchantReference: snapshot.merchantReference,
    amount: snapshot.amount,
    currency: snapshot.currency,
    status: snapshot.status,
    revision: snapshot.revision,
  });
  if (common instanceof type.errors)
    throw new MerchantError(502, "invalid_paybridge_response");
  const result = await commitSnapshot({
    db,
    merchant,
    snapshot: common,
    ...(beforeCommit ? { beforeCommit } : {}),
  });
  return { snapshot, result };
}

export async function returnPayment({
  db,
  merchant,
  id,
  paybridgeOrigin,
  beforeCommit,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof paymentId.infer;
  paybridgeOrigin: string;
  beforeCommit?: () => Promise<void>;
}) {
  const payment = await db.orm.MerchantPayment.where({
    paymentIntentId: id,
    merchantId: merchant.id,
  }).first();
  if (!payment) throw new MerchantError(404, "payment_not_found");
  if (
    (payment.status === "SUCCEEDED" || payment.status === "CANCELLED") &&
    payment.snapshot !== null
  ) {
    return commitSnapshot({
      db,
      merchant,
      snapshot: merchantPaymentSnapshot.assert(parseJson(payment.snapshot)),
      ...(beforeCommit ? { beforeCommit } : {}),
    });
  }
  return (
    await lookupAndApplyPayment({
      db,
      merchant,
      id: orderId.assert(payment.orderId),
      paybridgeOrigin,
      ...(beforeCommit ? { beforeCommit } : {}),
    })
  ).result;
}
