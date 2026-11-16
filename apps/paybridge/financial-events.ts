import { randomUUID } from "node:crypto";
import type { PaybridgeDatabase, PaybridgeTransaction } from "./database.ts";

type Payment = Pick<
  Awaited<ReturnType<PaybridgeDatabase["orm"]["PaymentIntent"]["create"]>>,
  "id" | "merchantId" | "merchantReference" | "amount" | "currency" | "revision"
>;
const eventTypes = {
  SUCCEEDED: "payment.succeeded",
  FAILED: "payment.failed",
  UNKNOWN: "payment.unknown",
  CANCELLED: "payment.cancelled",
};

export async function appendFinancialEvent({
  tx,
  payment,
  paymentAttemptId,
  fromStatus,
  status,
  actorType,
  actorId,
  metadata,
  at,
}: {
  tx: PaybridgeTransaction;
  payment: Payment;
  paymentAttemptId: string | null;
  fromStatus: "PENDING" | "PROCESSING" | "UNKNOWN";
  status: keyof typeof eventTypes;
  actorType: string;
  actorId: string;
  metadata: string;
  at: string;
}) {
  const id = `evt_${randomUUID().replaceAll("-", "")}`;
  const eventType = eventTypes[status];
  await tx.orm.PaymentEvent.create({
    id,
    paymentIntentId: payment.id,
    paymentAttemptId,
    type: `PAYMENT_${status}`,
    fromStatus,
    toStatus: status,
    intentRevision: payment.revision,
    actorType,
    actorId,
    metadata,
    createdAt: at,
  });
  await tx.orm.WebhookOutbox.create({
    id: `who_${randomUUID().replaceAll("-", "")}`,
    paymentEventId: id,
    merchantId: payment.merchantId,
    paymentIntentId: payment.id,
    eventType,
    payload: JSON.stringify({
      id,
      type: eventType,
      createdAt: at,
      data: {
        paymentIntentId: payment.id,
        merchantReference: payment.merchantReference,
        amount: payment.amount,
        currency: payment.currency,
        status,
        revision: payment.revision,
      },
    }),
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: at,
    lastError: null,
    createdAt: at,
    deliveredAt: null,
    claimToken: null,
    lockedBy: null,
    leaseExpiresAt: null,
  });
}
