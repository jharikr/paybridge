import { randomBytes } from "node:crypto";
import { type } from "arktype";
import {
  creationAcknowledgment,
  confirmationAcknowledgment,
} from "../../contracts/payments.ts";
import {
  merchantCommandId,
  merchantCommandList,
  merchantConfirmationInput,
  orderId,
} from "../../contracts/merchant.ts";
import type { MerchantContext } from "./config.ts";
import type { MerchantDatabase } from "./database.ts";
import { MerchantError, readOrder } from "./orders.ts";
import {
  parseJson,
  paybridgeRequest,
  storedAcknowledgment,
} from "./paybridge.ts";

type StoredCommand = NonNullable<
  Awaited<ReturnType<MerchantDatabase["orm"]["MerchantCommand"]["first"]>>
>;
export type CommandCheckpoint = (event: {
  kind: "prepared" | "received" | "before-completion-commit";
  commandId: string;
}) => Promise<void>;

export async function listCommands({
  db,
  merchant,
  id,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
}) {
  await readOrder({ db, merchant, id });
  const commands = await db.orm.MerchantCommand.where({
    orderId: id,
    merchantId: merchant.id,
  })
    .orderBy((command) => command.createdAt.asc())
    .all();
  return merchantCommandList.assert({
    commands: commands.map((command) => ({
      id: command.id,
      operation: command.operation,
      commandNumber: command.commandNumber,
      status: command.status,
    })),
  });
}
export async function recoverCommand({
  db,
  merchant,
  id,
  commandId,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
  commandId: typeof merchantCommandId.infer;
}) {
  const command = await db.orm.MerchantCommand.where({
    id: commandId,
    orderId: id,
    merchantId: merchant.id,
  }).first();
  if (!command) throw new MerchantError(404, "command_not_found");
  return command;
}

export async function prepareCreation({
  db,
  merchant,
  id,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      db.raw
        .sql`UPDATE orders SET updated_at = updated_at WHERE id = ${id} AND merchant_id = ${merchant.id}`
        .affectedCount()
        .build(),
    );
    const order = await tx.orm.Order.where({
      id,
      merchantId: merchant.id,
    }).first();
    if (!order) throw new MerchantError(404, "order_not_found");
    const existing = await tx.orm.MerchantCommand.where({
      orderId: id,
      merchantId: merchant.id,
      operation: "create",
      commandNumber: 1,
    }).first();
    if (existing) return existing;
    const context = await tx.orm.MerchantContext.where({
      id: merchant.id,
    }).first();
    if (!context) throw new Error("Merchant context is missing");
    const input = {
      merchantReference: order.businessReference,
      amount: order.amount,
      currency: order.currency,
      ...(order.description === null ? {} : { description: order.description }),
      returnUrl: context.returnUrl,
    };
    const commandId = `mc_${randomBytes(16).toString("hex")}`;
    await tx.execute(
      db.raw.sql`
      INSERT INTO merchant_commands (id, merchant_id, order_id, operation, command_number, idempotency_key, target, request_body, status, created_at)
      VALUES (${commandId}, ${merchant.id}, ${id}, 'create', 1, ${commandId}, '/v1/payment-intents', ${JSON.stringify(input)}, 'PREPARED', ${new Date().toISOString()})
    `
        .affectedCount()
        .build(),
    );
    const created = await tx.orm.MerchantCommand.where({
      id: commandId,
    }).first();
    if (!created) throw new Error("Prepared command could not be read");
    return created;
  });
}

function acknowledgment(command: StoredCommand) {
  return storedAcknowledgment.assert({
    status: command.responseStatus,
    body: command.responseBody,
    headers: JSON.parse(command.responseHeaders ?? "null"),
  });
}

export async function prepareConfirmation({
  db,
  merchant,
  id,
  input,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  id: typeof orderId.infer;
  input: typeof merchantConfirmationInput.infer;
}) {
  const body = JSON.stringify({
    mockPaymentMethodRef: input.mockPaymentMethodRef,
    expectedRevision: input.expectedRevision,
  });
  return db.transaction(async (tx) => {
    await tx.execute(
      db.raw
        .sql`UPDATE orders SET updated_at = updated_at WHERE id = ${id} AND merchant_id = ${merchant.id}`
        .affectedCount()
        .build(),
    );
    const order = await tx.orm.Order.where({
      id,
      merchantId: merchant.id,
    }).first();
    if (!order) throw new MerchantError(404, "order_not_found");
    const existing = await tx.orm.MerchantCommand.where({
      orderId: id,
      merchantId: merchant.id,
      operation: "confirm",
      commandNumber: input.commandNumber,
    }).first();
    if (existing) {
      if (existing.requestBody !== body)
        throw new MerchantError(409, "command_input_conflict");
      return existing;
    }
    const payment = await tx.orm.MerchantPayment.where({
      orderId: id,
      merchantId: merchant.id,
    }).first();
    if (!payment) throw new MerchantError(409, "payment_not_created");
    const previous = await tx.orm.MerchantCommand.where({
      orderId: id,
      merchantId: merchant.id,
      operation: "confirm",
    })
      .orderBy((command) => command.commandNumber.desc())
      .first();
    if (previous?.status === "PREPARED")
      throw new MerchantError(409, "command_recovery_required");
    if (input.commandNumber !== (previous?.commandNumber ?? 0) + 1)
      throw new MerchantError(409, "command_number_conflict");
    const commandId = `mc_${randomBytes(16).toString("hex")}`;
    await tx.execute(
      db.raw.sql`
      INSERT INTO merchant_commands (id, merchant_id, order_id, operation, command_number, idempotency_key, target, request_body, status, created_at)
      VALUES (${commandId}, ${merchant.id}, ${id}, 'confirm', ${input.commandNumber}, ${commandId}, ${`/v1/payment-intents/${payment.paymentIntentId}/confirm`}, ${body}, 'PREPARED', ${new Date().toISOString()})
    `
        .affectedCount()
        .build(),
    );
    const created = await tx.orm.MerchantCommand.where({
      id: commandId,
    }).first();
    if (!created) throw new Error("Prepared command could not be read");
    return created;
  });
}

export async function executeCommand({
  db,
  merchant,
  command,
  paybridgeOrigin,
  checkpoint,
}: {
  db: MerchantDatabase;
  merchant: MerchantContext;
  command: StoredCommand;
  paybridgeOrigin: string;
  checkpoint?: CommandCheckpoint;
}) {
  if (command.status === "COMPLETED")
    return { commandId: command.id, acknowledgment: acknowledgment(command) };
  await checkpoint?.({ kind: "prepared", commandId: command.id });
  const response = await paybridgeRequest({
    origin: paybridgeOrigin,
    merchant,
    target: command.target,
    command: { key: command.idempotencyKey, body: command.requestBody },
  });
  const received = response.acknowledgment;
  const order = await readOrder({
    db,
    merchant,
    id: orderId.assert(command.orderId),
  });
  let createdId: string | null = null;
  if (received.status < 400) {
    if (command.operation === "create") {
      const created = creationAcknowledgment(response.value);
      if (
        received.status !== 201 ||
        created instanceof type.errors ||
        created.merchantReference !== order.businessReference ||
        created.amount !== order.amount ||
        created.currency !== order.currency ||
        created.status !== "PENDING" ||
        created.revision !== 1
      )
        throw new MerchantError(502, "invalid_paybridge_acknowledgment");
      createdId = created.id;
    } else {
      const accepted = confirmationAcknowledgment(response.value);
      const input = type({ expectedRevision: "number" }).assert(
        parseJson(command.requestBody),
      );
      if (
        received.status !== 202 ||
        accepted instanceof type.errors ||
        accepted.paymentIntentId !== order.paymentIntentId ||
        accepted.revision !== input.expectedRevision + 1
      )
        throw new MerchantError(502, "invalid_paybridge_acknowledgment");
    }
  }
  await checkpoint?.({ kind: "received", commandId: command.id });
  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      db.raw.sql`
      UPDATE merchant_commands SET status = 'COMPLETED', response_status = ${received.status}, response_body = ${received.body}, response_headers = ${JSON.stringify(received.headers)}, completed_at = ${new Date().toISOString()}
      WHERE id = ${command.id} AND merchant_id = ${merchant.id} AND status = 'PREPARED'
    `
        .affectedCount()
        .build(),
    );
    if (createdId !== null) {
      const now = new Date().toISOString();
      await tx.execute(
        db.raw.sql`
      INSERT INTO merchant_payments (payment_intent_id, merchant_id, order_id, status, last_applied_revision, snapshot, created_at, updated_at)
      VALUES (${createdId}, ${merchant.id}, ${command.orderId}, NULL, 0, NULL, ${now}, ${now})
      ON CONFLICT(payment_intent_id) DO NOTHING
    `
          .affectedCount()
          .build(),
      );
    }
    const completed = await tx.orm.MerchantCommand.where({
      id: command.id,
      merchantId: merchant.id,
    }).first();
    if (!completed) throw new Error("Completed command could not be read");
    await checkpoint?.({
      kind: "before-completion-commit",
      commandId: command.id,
    });
    return acknowledgment(completed);
  });
  return {
    commandId: merchantCommandId.assert(command.id),
    acknowledgment: saved,
  };
}
