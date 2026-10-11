import { snapshot } from "./payments.ts";
import { randomBytes } from "node:crypto";
import {
  paymentAttemptId,
  paymentId,
  confirmationAcknowledgment,
} from "../../contracts/payments.ts";
import type { ConfirmPaymentInput } from "../../contracts/payments.ts";
import type { PaybridgeDatabase, PaybridgeTransaction } from "./database.ts";
import type { AuthenticatedMerchant } from "./merchants.ts";
import { commandHash, completeCommand, reserveCommand } from "./commands.ts";
import type { Reservation, CommandAcknowledgment } from "./commands.ts";

export type ConfirmationResult =
  | Exclude<Reservation, { kind: "new" }>
  | { kind: "not_found" | "revision_conflict" | "not_confirmable" };
class CommandRejected extends Error {
  readonly kind: "not_found" | "revision_conflict" | "not_confirmable";
  constructor(kind: CommandRejected["kind"]) {
    super(kind);
    this.kind = kind;
  }
}
async function availableTransactionId(tx: PaybridgeTransaction) {
  for (let remaining = 5; remaining > 0; remaining--) {
    const id = randomBytes(8).toString("hex");
    if (
      !(await tx.orm.PaymentAttempt.where({
        provider: "4cs",
        providerTransactionId: id,
      }).first())
    )
      return id;
  }
  throw new Error("Could not allocate a unique provider transaction ID");
}
export async function confirmPayment({
  db,
  merchant,
  id,
  input,
  key,
  paybridgeOrigin,
  beforeCommit,
}: {
  db: PaybridgeDatabase;
  merchant: AuthenticatedMerchant;
  id: typeof paymentId.infer;
  input: ConfirmPaymentInput;
  key: string;
  paybridgeOrigin: string;
  beforeCommit?: () => Promise<void>;
}): Promise<ConfirmationResult> {
  const identity = {
    merchantId: merchant.id,
    key,
    operation: "confirm_payment",
    requestHash: commandHash({
      operation: "confirm_payment",
      method: "POST",
      target: `/v1/payment-intents/${id}/confirm`,
      input,
    }),
  };
  try {
    return await db.transaction(async (tx) => {
      const reserved = await reserveCommand({ db, tx, identity });
      if (reserved.kind !== "new") return reserved;
      const payment = await tx.orm.PaymentIntent.where({
        id,
        merchantId: merchant.id,
      }).first();
      if (!payment) throw new CommandRejected("not_found");
      if (payment.revision !== input.expectedRevision)
        throw new CommandRejected("revision_conflict");
      const now = new Date().toISOString();
      const changed = await tx.execute(
        db.raw.sql`
        UPDATE payment_intents SET status = 'PROCESSING', revision = revision + 1, updated_at = ${now}
        WHERE id = ${id} AND merchant_id = ${merchant.id} AND revision = ${input.expectedRevision}
          AND status IN ('PENDING', 'FAILED')
          AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE payment_intent_id = ${id} AND status IN ('PROCESSING', 'UNKNOWN'))
      `
          .affectedCount()
          .build(),
      );
      if (changed.affectedRows !== 1)
        throw new CommandRejected("not_confirmable");
      const previous = await tx.orm.PaymentAttempt.where({
        paymentIntentId: id,
      })
        .orderBy((attempt) => attempt.attemptNumber.desc())
        .first();
      const attemptNumber = (previous?.attemptNumber ?? 0) + 1;
      const attemptId = paymentAttemptId.assert(
        `pa_${randomBytes(16).toString("hex")}`,
      );
      const providerTransactionId = await availableTransactionId(tx);
      await tx.orm.PaymentAttempt.create({
        id: attemptId,
        paymentIntentId: id,
        attemptNumber,
        provider: "4cs",
        providerAccountRef: merchant.providerAccountRef,
        providerTransactionId,
        providerHostReference: null,
        status: "PROCESSING",
        providerOperationResult: null,
        providerServiceResult: null,
        providerFinancialResult: null,
        mockPaymentMethodRef: input.mockPaymentMethodRef,
        failureCode: null,
        failureMessage: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.orm.PaymentEvent.create({
        id: `evt_${randomBytes(16).toString("hex")}`,
        paymentIntentId: id,
        paymentAttemptId: attemptId,
        type: "ATTEMPT_CREATED",
        fromStatus: payment.status,
        toStatus: "PROCESSING",
        intentRevision: payment.revision + 1,
        actorType: "MERCHANT",
        actorId: merchant.id,
        metadata: "{}",
        createdAt: now,
      });
      await tx.orm.ProviderOutbox.create({
        id: `pwo_${randomBytes(16).toString("hex")}`,
        paymentAttemptId: attemptId,
        status: "PENDING",
        attemptCount: 0,
        nextAttemptAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        claimToken: null,
        lockedBy: null,
        leaseExpiresAt: null,
      });
      const response: CommandAcknowledgment = {
        status: 202,
        body: JSON.stringify(
          confirmationAcknowledgment.assert({
            paymentIntentId: id,
            paymentAttemptId: attemptId,
            attemptNumber,
            status: "PROCESSING",
            revision: payment.revision + 1,
            statusUrl: `${paybridgeOrigin}/v1/payment-intents/${id}`,
          }),
        ),
        headers: {
          location: `/v1/payment-intents/${id}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-type": "application/json; charset=utf-8",
        },
      };
      await completeCommand({
        db,
        tx,
        identity,
        resourceId: id,
        attemptId,
        response,
      });
      await beforeCommit?.();
      return { kind: "completed", acknowledgment: response };
    });
  } catch (error) {
    if (error instanceof CommandRejected) return { kind: error.kind };
    throw error;
  }
}

export async function cancelPayment({
  db,
  merchant,
  id,
  beforeCommit,
}: {
  db: PaybridgeDatabase;
  merchant: AuthenticatedMerchant;
  id: typeof paymentId.infer;
  beforeCommit?: () => Promise<void>;
}) {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const changed = await tx.execute(
      db.raw.sql`
      UPDATE payment_intents SET status = 'CANCELLED', revision = revision + 1, updated_at = ${now}
      WHERE id = ${id} AND merchant_id = ${merchant.id} AND status = 'PENDING'
    `
        .affectedCount()
        .build(),
    );
    const payment = await tx.orm.PaymentIntent.where({
      id,
      merchantId: merchant.id,
    }).first();
    if (!payment) return { kind: "not_found" } as const;
    if (payment.status !== "CANCELLED")
      return { kind: "not_cancellable" } as const;
    if (changed.affectedRows === 1) {
      const eventId = `evt_${randomBytes(16).toString("hex")}`;
      await tx.orm.PaymentEvent.create({
        id: eventId,
        paymentIntentId: id,
        paymentAttemptId: null,
        type: "PAYMENT_CANCELLED",
        fromStatus: "PENDING",
        toStatus: "CANCELLED",
        intentRevision: payment.revision,
        actorType: "MERCHANT",
        actorId: merchant.id,
        metadata: "{}",
        createdAt: now,
      });
      await tx.orm.WebhookOutbox.create({
        id: `who_${randomBytes(16).toString("hex")}`,
        paymentEventId: eventId,
        merchantId: merchant.id,
        paymentIntentId: id,
        eventType: "payment.cancelled",
        payload: JSON.stringify({
          id: eventId,
          type: "payment.cancelled",
          createdAt: now,
          data: {
            paymentIntentId: id,
            merchantReference: payment.merchantReference,
            amount: payment.amount,
            currency: payment.currency,
            status: "CANCELLED",
            revision: payment.revision,
          },
        }),
        status: "PENDING",
        attemptCount: 0,
        nextAttemptAt: now,
        lastError: null,
        createdAt: now,
        deliveredAt: null,
        claimToken: null,
        lockedBy: null,
        leaseExpiresAt: null,
      });
      await beforeCommit?.();
    }
    return {
      kind: "cancelled" as const,
      payment: snapshot({ record: payment }),
    };
  });
}
