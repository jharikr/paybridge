import { randomBytes } from "node:crypto";
import {
  paymentId,
  paymentSnapshot,
  type CreatePaymentInput,
} from "../../contracts/payments.ts";
import type { PaybridgeDatabase, PaybridgeTransaction } from "./database.ts";
import {
  commandHash,
  completeCommand,
  reserveCommand,
  type CommandAcknowledgment,
  type Reservation,
} from "./commands.ts";
import { hashSecret, type AuthenticatedMerchant } from "./merchants.ts";

export function validReturnUrl({
  input,
  merchant,
}: {
  input: CreatePaymentInput;
  merchant: AuthenticatedMerchant;
}) {
  if (/[\u0000-\u001F\u007F]/.test(input.returnUrl)) return false;
  const url = URL.parse(input.returnUrl);
  return (
    url !== null &&
    ["https:", "http:"].includes(url.protocol) &&
    url.origin === merchant.returnOrigin &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

async function availableInvoice(tx: PaybridgeTransaction) {
  for (let remaining = 5; remaining > 0; remaining--) {
    const invoice = randomBytes(8).toString("hex");
    if (
      !(await tx.orm.PaymentIntent.where({ providerInvoice: invoice }).first())
    )
      return invoice;
  }
  throw new Error("Could not allocate a unique provider invoice");
}

export async function createPayment({
  db,
  merchant,
  input,
  paybridgeOrigin,
  key,
  beforeCommit,
}: {
  db: PaybridgeDatabase;
  merchant: AuthenticatedMerchant;
  input: CreatePaymentInput;
  paybridgeOrigin: string;
  key: string;
  beforeCommit?: () => Promise<void>;
}): Promise<Exclude<Reservation, { kind: "new" }>> {
  const identity = {
    merchantId: merchant.id,
    key,
    operation: "create_payment",
    requestHash: commandHash({
      operation: "create_payment",
      method: "POST",
      target: "/v1/payment-intents",
      input,
    }),
  };
  return db.transaction(async (tx) => {
    const reservation = await reserveCommand({ db, tx, identity });
    if (reservation.kind !== "new") return reservation;
    const invoice = await availableInvoice(tx);
    const id = paymentId.assert(`pi_${randomBytes(16).toString("hex")}`);
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const record = await tx.orm.PaymentIntent.create({
      id,
      merchantId: merchant.id,
      merchantReference: input.merchantReference,
      amount: input.amount,
      currency: input.currency,
      description: input.description ?? null,
      returnUrl: input.returnUrl,
      providerInvoice: invoice,
      checkoutTokenHash: hashSecret(token),
      status: "PENDING",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await tx.orm.PaymentEvent.create({
      id: `evt_${randomBytes(16).toString("hex")}`,
      paymentIntentId: id,
      paymentAttemptId: null,
      type: "PAYMENT_CREATED",
      fromStatus: null,
      toStatus: "PENDING",
      intentRevision: 1,
      actorType: "MERCHANT",
      actorId: merchant.id,
      metadata: "{}",
      createdAt: now,
    });
    const response: CommandAcknowledgment = {
      status: 201,
      body: JSON.stringify({
        ...snapshot({ record }),
        checkoutUrl: `${paybridgeOrigin}/checkout/${id}?token=${token}`,
      }),
      headers: {
        location: `/v1/payment-intents/${id}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-type": "application/json; charset=utf-8",
      },
    };
    await completeCommand({ db, tx, identity, resourceId: id, response });
    await beforeCommit?.();
    return { kind: "completed", acknowledgment: response };
  });
}

type StoredPayment = Awaited<
  ReturnType<PaybridgeDatabase["orm"]["PaymentIntent"]["create"]>
>;
type StoredAttempt = Awaited<
  ReturnType<PaybridgeDatabase["orm"]["PaymentAttempt"]["create"]>
>;
export function snapshot({
  record,
  attempt = null,
}: {
  record: StoredPayment;
  attempt?: StoredAttempt | null;
}) {
  return paymentSnapshot.assert({
    id: record.id,
    merchantReference: record.merchantReference,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    latestAttempt: attempt
      ? {
          id: attempt.id,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          ...(attempt.failureCode === null
            ? {}
            : { failureCode: attempt.failureCode }),
        }
      : null,
  });
}
export async function lookupPayment({
  db,
  merchant,
  id,
}: {
  db: PaybridgeDatabase;
  merchant: AuthenticatedMerchant;
  id: typeof paymentId.infer;
}) {
  const found = await db.orm.PaymentIntent.where({
    id,
    merchantId: merchant.id,
  })
    .include("attempts", (attempts) =>
      attempts.orderBy((attempt) => attempt.attemptNumber.desc()).limit(1),
    )
    .first();
  return found
    ? snapshot({ record: found, attempt: found.attempts[0] ?? null })
    : null;
}
