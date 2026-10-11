import { randomBytes } from "node:crypto";
import {
  createOrderInput,
  orderId,
  orderView,
} from "../../contracts/merchant.ts";
import type { MerchantContext } from "./config.ts";
import type { MerchantDatabase } from "./database.ts";

export class MerchantError extends Error {
  readonly status: 404 | 409 | 502 | 503;
  readonly code: string;
  constructor(status: 404 | 409 | 502 | 503, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function seedContexts({
  db,
  origin,
}: {
  db: MerchantDatabase;
  origin: string;
}) {
  for (const id of ["merchant-a", "merchant-b"]) {
    await db.runtime().execute(
      db.raw.sql`
      INSERT INTO merchant_contexts (id, return_url, webhook_url, created_at)
      VALUES (${id}, ${`${origin}/${id}/payment-return`}, ${`${origin}/api/webhooks/paybridge/${id}`}, ${new Date().toISOString()})
      ON CONFLICT(id) DO NOTHING
    `
        .affectedCount()
        .build(),
    );
  }
}

export async function readOrder({
  db,
  merchant,
  id,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
}) {
  const order = await db.orm.Order.where({
    id,
    merchantId: merchant.id,
  }).first();
  if (!order) throw new MerchantError(404, "order_not_found");
  const payment = await db.orm.MerchantPayment.where({
    orderId: id,
    merchantId: merchant.id,
  }).first();
  return orderView.assert({
    id: order.id,
    merchantId: order.merchantId,
    businessReference: order.businessReference,
    amount: order.amount,
    currency: order.currency,
    ...(order.description === null ? {} : { description: order.description }),
    state: order.state,
    paidAt: order.paidAt,
    paymentIntentId: payment?.paymentIntentId ?? null,
  });
}

export async function createOrder({
  db,
  merchant,
  input,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  input: typeof createOrderInput.infer;
}) {
  const id = orderId.assert(`ord_${randomBytes(16).toString("hex")}`);
  const now = new Date().toISOString();
  const inserted = await db.runtime().execute(
    db.raw.sql`
    INSERT INTO orders (id, merchant_id, business_reference, amount, currency, description, state, paid_at, created_at, updated_at)
    VALUES (${id}, ${merchant.id}, ${input.businessReference}, ${input.amount}, ${input.currency}, CASE WHEN ${input.description === undefined ? 1 : 0} = 1 THEN NULL ELSE ${input.description ?? ""} END, 'UNPAID', NULL, ${now}, ${now})
    ON CONFLICT(merchant_id, business_reference) DO NOTHING
  `
      .affectedCount()
      .build(),
  );
  const stored = await db.orm.Order.where({
    merchantId: merchant.id,
    businessReference: input.businessReference,
  }).first();
  if (!stored) throw new Error("Created order could not be read");
  if (
    stored.amount !== input.amount ||
    stored.currency !== input.currency ||
    stored.description !== (input.description ?? null)
  )
    throw new MerchantError(409, "order_input_conflict");
  return {
    created: inserted.affectedRows === 1,
    order: await readOrder({ db, merchant, id: orderId.assert(stored.id) }),
  };
}
