#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/5124c0135cca8451f39c2883931e44372af72eae8562378e2b8e15607d3e44ad/contract.d.ts';
import endContract from '../../snapshots/5124c0135cca8451f39c2883931e44372af72eae8562378e2b8e15607d3e44ad/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-sqlite/migration';

function operation({ name, objectType, sql }: { name: string; objectType: "table" | "index" | "trigger"; sql: string }) {
  return rawSql({
    id: `${objectType}.${name}`, label: `Create ${name}`, operationClass: "additive",
    target: objectType === "trigger" ? { id: "sqlite" } : { id: "sqlite", details: { schema: "main", objectType, name } },
    precheck: [], execute: [{ description: `Create ${name}`, sql, params: [] }],
    postcheck: [{ description: `Verify ${name}`, sql: "SELECT COUNT(*) = 1 AS result FROM sqlite_master WHERE type = ? AND name = ?", params: [objectType, name] }],
  });
}

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;
  override get operations() {
    return [
      operation({ name: "merchant_commands", objectType: "table", sql: `CREATE TABLE "merchant_commands" (
  "command_number" INTEGER NOT NULL,
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "request_body" TEXT NOT NULL,
  "response_body" TEXT,
  "response_headers" TEXT,
  "response_status" INTEGER,
  "status" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("merchant_id", "idempotency_key"),
  UNIQUE ("merchant_id", "order_id", "operation", "command_number"),
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id"),
  FOREIGN KEY (order_id, merchant_id) REFERENCES orders(id, merchant_id),
  CHECK (typeof(command_number) = 'integer' AND command_number BETWEEN 1 AND 9007199254740991),
  CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CHECK (json_valid(request_body)),
  CHECK ((operation = 'create' AND command_number = 1 AND target = '/v1/payment-intents') OR (operation = 'confirm' AND target GLOB '/v1/payment-intents/pi_*/confirm')),
  CHECK ((status = 'PREPARED' AND response_status IS NULL AND response_body IS NULL AND response_headers IS NULL AND completed_at IS NULL) OR (status = 'COMPLETED' AND typeof(response_status) = 'integer' AND response_status BETWEEN 200 AND 499 AND response_body IS NOT NULL AND response_headers IS NOT NULL AND json_valid(response_headers) AND completed_at IS NOT NULL))
)` }),
      operation({ name: "merchant_contexts", objectType: "table", sql: `CREATE TABLE "merchant_contexts" (
  "created_at" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "return_url" TEXT NOT NULL,
  "webhook_url" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (id IN ('merchant-a', 'merchant-b'))
)` }),
      operation({ name: "merchant_payments", objectType: "table", sql: `CREATE TABLE "merchant_payments" (
  "created_at" TEXT NOT NULL,
  "last_applied_revision" INTEGER NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "payment_intent_id" TEXT NOT NULL,
  "snapshot" TEXT,
  "status" TEXT,
  "updated_at" TEXT NOT NULL,
  PRIMARY KEY ("payment_intent_id"),
  UNIQUE ("order_id"),
  UNIQUE ("payment_intent_id", "merchant_id", "order_id"),
  FOREIGN KEY ("order_id") REFERENCES "orders" ("id"),
  FOREIGN KEY (order_id, merchant_id) REFERENCES orders(id, merchant_id),
  CHECK (typeof(last_applied_revision) = 'integer' AND last_applied_revision BETWEEN 0 AND 9007199254740991),
  CHECK ((last_applied_revision = 0 AND status IS NULL AND snapshot IS NULL) OR (last_applied_revision > 0 AND status IS NOT NULL AND status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED') AND snapshot IS NOT NULL AND json_valid(snapshot)))
)` }),
      operation({ name: "orders", objectType: "table", sql: `CREATE TABLE "orders" (
  "amount" INTEGER NOT NULL,
  "business_reference" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "description" TEXT,
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "paid_at" TEXT,
  "state" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("merchant_id", "business_reference"),
  UNIQUE ("id", "merchant_id"),
  FOREIGN KEY ("merchant_id") REFERENCES "merchant_contexts" ("id"),
  CHECK (typeof(amount) = 'integer' AND amount BETWEEN 1 AND 9999999999),
  CHECK (currency = 'XCD'),
  CHECK (length(business_reference) BETWEEN 1 AND 128),
  CHECK (description IS NULL OR length(description) <= 256),
  CHECK ((state = 'UNPAID' AND paid_at IS NULL) OR (state = 'PAID' AND paid_at IS NOT NULL))
)` }),
      operation({ name: "merchant_commands_order_id_idx_39ad19ad", objectType: "index", sql: `CREATE INDEX "merchant_commands_order_id_idx_39ad19ad" ON "merchant_commands" ("order_id")` }),
      operation({ name: "orders_merchant_id_idx_92be5ce7", objectType: "index", sql: `CREATE INDEX "orders_merchant_id_idx_92be5ce7" ON "orders" ("merchant_id")` }),
      operation({ name: "one_prepared_command", objectType: "index", sql: `CREATE UNIQUE INDEX one_prepared_command ON merchant_commands(merchant_id, order_id, operation) WHERE status = 'PREPARED'` }),
      operation({ name: "merchant_context_fixed", objectType: "trigger", sql: `CREATE TRIGGER merchant_context_fixed BEFORE UPDATE ON merchant_contexts BEGIN SELECT RAISE(ABORT, 'merchant_context_fixed'); END` }),
      operation({ name: "order_identity_fixed", objectType: "trigger", sql: `CREATE TRIGGER order_identity_fixed BEFORE UPDATE ON orders WHEN NEW.id IS NOT OLD.id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.business_reference IS NOT OLD.business_reference OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.description IS NOT OLD.description OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'order_identity_fixed'); END` }),
      operation({ name: "paid_order_retained", objectType: "trigger", sql: `CREATE TRIGGER paid_order_retained BEFORE UPDATE ON orders WHEN OLD.state = 'PAID' AND (NEW.state != 'PAID' OR NEW.paid_at IS NOT OLD.paid_at) BEGIN SELECT RAISE(ABORT, 'paid_order_retained'); END` }),
      operation({ name: "payment_binding_fixed", objectType: "trigger", sql: `CREATE TRIGGER payment_binding_fixed BEFORE UPDATE ON merchant_payments WHEN NEW.payment_intent_id IS NOT OLD.payment_intent_id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.order_id IS NOT OLD.order_id OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'payment_binding_fixed'); END` }),
      operation({ name: "payment_view_revision_monotonic", objectType: "trigger", sql: `CREATE TRIGGER payment_view_revision_monotonic BEFORE UPDATE ON merchant_payments WHEN NEW.last_applied_revision < OLD.last_applied_revision OR (NEW.last_applied_revision = OLD.last_applied_revision AND (NEW.status IS NOT OLD.status OR NEW.snapshot IS NOT OLD.snapshot)) BEGIN SELECT RAISE(ABORT, 'payment_view_revision_monotonic'); END` }),
      operation({ name: "merchant_command_identity_fixed", objectType: "trigger", sql: `CREATE TRIGGER merchant_command_identity_fixed BEFORE UPDATE ON merchant_commands WHEN NEW.id IS NOT OLD.id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.order_id IS NOT OLD.order_id OR NEW.operation IS NOT OLD.operation OR NEW.command_number IS NOT OLD.command_number OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.target IS NOT OLD.target OR NEW.request_body IS NOT OLD.request_body OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'merchant_command_identity_fixed'); END` }),
      operation({ name: "merchant_command_completed_fixed", objectType: "trigger", sql: `CREATE TRIGGER merchant_command_completed_fixed BEFORE UPDATE ON merchant_commands WHEN OLD.status = 'COMPLETED' BEGIN SELECT RAISE(ABORT, 'merchant_command_completed_fixed'); END` }),
      operation({ name: "confirmation_requires_owned_binding", objectType: "trigger", sql: `CREATE TRIGGER confirmation_requires_owned_binding BEFORE INSERT ON merchant_commands WHEN NEW.operation = 'confirm' AND NOT EXISTS (SELECT 1 FROM merchant_payments WHERE merchant_id = NEW.merchant_id AND order_id = NEW.order_id AND NEW.target = '/v1/payment-intents/' || payment_intent_id || '/confirm') BEGIN SELECT RAISE(ABORT, 'confirmation_requires_owned_binding'); END` }),
      operation({ name: "binding_requires_completed_creation", objectType: "trigger", sql: `CREATE TRIGGER binding_requires_completed_creation BEFORE INSERT ON merchant_payments WHEN NOT EXISTS (SELECT 1 FROM merchant_commands WHERE merchant_id = NEW.merchant_id AND order_id = NEW.order_id AND operation = 'create' AND status = 'COMPLETED' AND response_status = 201 AND json_extract(response_body, '$.id') = NEW.payment_intent_id) BEGIN SELECT RAISE(ABORT, 'binding_requires_completed_creation'); END` }),
      operation({ name: "merchant_contexts_retained", objectType: "trigger", sql: `CREATE TRIGGER merchant_contexts_retained BEFORE DELETE ON merchant_contexts BEGIN SELECT RAISE(ABORT, 'merchant_contexts_retained'); END` }),
      operation({ name: "orders_retained", objectType: "trigger", sql: `CREATE TRIGGER orders_retained BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders_retained'); END` }),
      operation({ name: "merchant_payments_retained", objectType: "trigger", sql: `CREATE TRIGGER merchant_payments_retained BEFORE DELETE ON merchant_payments BEGIN SELECT RAISE(ABORT, 'merchant_payments_retained'); END` }),
      operation({ name: "merchant_commands_retained", objectType: "trigger", sql: `CREATE TRIGGER merchant_commands_retained BEFORE DELETE ON merchant_commands BEGIN SELECT RAISE(ABORT, 'merchant_commands_retained'); END` }),
    ];
  }
}
MigrationCLI.run(import.meta.url, M);
