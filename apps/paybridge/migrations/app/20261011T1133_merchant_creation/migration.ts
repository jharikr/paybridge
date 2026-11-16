#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/4f8c8ff366a53054d16a2ef113d26f49096154023650a816fb53500d285aaec8/contract.d.ts';
import endContract from '../../snapshots/4f8c8ff366a53054d16a2ef113d26f49096154023650a816fb53500d285aaec8/contract.json' with { type: 'json' };
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
      operation({ name: "idempotency_keys", objectType: "table", sql: `CREATE TABLE "idempotency_keys" (
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "payment_attempt_id" TEXT,
  "request_hash" TEXT NOT NULL,
  "resource_id" TEXT,
  "response_body" TEXT,
  "response_headers" TEXT,
  "response_status" INTEGER,
  "status" TEXT NOT NULL,
  PRIMARY KEY ("merchant_id", "key"),
  FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id"),
  FOREIGN KEY (resource_id, merchant_id) REFERENCES payment_intents(id, merchant_id),
  CHECK (length(key) BETWEEN 1 AND 128),
  CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  CHECK ((status = 'IN_PROGRESS' AND resource_id IS NULL AND response_status IS NULL AND response_body IS NULL AND response_headers IS NULL AND completed_at IS NULL) OR (status = 'COMPLETED' AND resource_id IS NOT NULL AND typeof(response_status) = 'integer' AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL AND response_headers IS NOT NULL AND completed_at IS NOT NULL))
)` }),
      operation({ name: "merchants", objectType: "table", sql: `CREATE TABLE "merchants" (
  "api_key_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "is_active" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "provider_account_ref" TEXT NOT NULL,
  "return_origin" TEXT NOT NULL,
  "webhook_secret" TEXT NOT NULL,
  "webhook_url" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("provider_account_ref"),
  UNIQUE ("api_key_hash"),
  CHECK (is_active IN (0, 1))
)` }),
      operation({ name: "payment_events", objectType: "table", sql: `CREATE TABLE "payment_events" (
  "actor_id" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "from_status" TEXT,
  "id" TEXT NOT NULL,
  "intent_revision" INTEGER NOT NULL,
  "metadata" TEXT NOT NULL,
  "payment_attempt_id" TEXT,
  "payment_intent_id" TEXT NOT NULL,
  "to_status" TEXT,
  "type" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents" ("id"),
  CHECK (typeof(intent_revision) = 'integer' AND intent_revision >= 1)
)` }),
      operation({ name: "payment_intents", objectType: "table", sql: `CREATE TABLE "payment_intents" (
  "amount" INTEGER NOT NULL,
  "checkout_token_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "description" TEXT,
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "merchant_reference" TEXT NOT NULL,
  "provider_invoice" TEXT NOT NULL,
  "return_url" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("provider_invoice"),
  UNIQUE ("id", "merchant_id"),
  FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id"),
  CHECK (typeof(amount) = 'integer' AND amount BETWEEN 1 AND 9999999999),
  CHECK (currency = 'XCD'),
  CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')),
  CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  CHECK (length(merchant_reference) BETWEEN 1 AND 128),
  CHECK (description IS NULL OR length(description) <= 256),
  CHECK (length(provider_invoice) BETWEEN 1 AND 16 AND provider_invoice NOT GLOB '*[^A-Za-z0-9]*')
)` }),
      operation({ name: "idempotency_keys_merchant_id_idx_92be5ce7", objectType: "index", sql: `CREATE INDEX "idempotency_keys_merchant_id_idx_92be5ce7" ON "idempotency_keys" ("merchant_id")` }),
      operation({ name: "payment_events_payment_intent_id_idx_2dc6a9d2", objectType: "index", sql: `CREATE INDEX "payment_events_payment_intent_id_idx_2dc6a9d2" ON "payment_events" ("payment_intent_id")` }),
      operation({ name: "payment_intents_merchant_id_idx_92be5ce7", objectType: "index", sql: `CREATE INDEX "payment_intents_merchant_id_idx_92be5ce7" ON "payment_intents" ("merchant_id")` }),
      operation({ name: "merchant_provider_fixed", objectType: "trigger", sql: `CREATE TRIGGER merchant_provider_fixed BEFORE UPDATE OF provider_account_ref ON merchants WHEN NEW.provider_account_ref IS NOT OLD.provider_account_ref BEGIN SELECT RAISE(ABORT, 'merchant_provider_fixed'); END` }),
      operation({ name: "payment_inputs_fixed", objectType: "trigger", sql: `CREATE TRIGGER payment_inputs_fixed BEFORE UPDATE ON payment_intents WHEN NEW.id IS NOT OLD.id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.merchant_reference IS NOT OLD.merchant_reference OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.description IS NOT OLD.description OR NEW.return_url IS NOT OLD.return_url OR NEW.provider_invoice IS NOT OLD.provider_invoice OR NEW.checkout_token_hash IS NOT OLD.checkout_token_hash OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'payment_inputs_fixed'); END` }),
      operation({ name: "payment_revision_tracks_status", objectType: "trigger", sql: `CREATE TRIGGER payment_revision_tracks_status BEFORE UPDATE ON payment_intents WHEN (NEW.status IS NOT OLD.status AND NEW.revision != OLD.revision + 1) OR (NEW.status IS OLD.status AND NEW.revision != OLD.revision) BEGIN SELECT RAISE(ABORT, 'payment_revision_tracks_status'); END` }),
      operation({ name: "completed_command_fixed", objectType: "trigger", sql: `CREATE TRIGGER completed_command_fixed BEFORE UPDATE ON idempotency_keys WHEN OLD.status = 'COMPLETED' BEGIN SELECT RAISE(ABORT, 'completed_command_fixed'); END` }),
      operation({ name: "command_identity_fixed", objectType: "trigger", sql: `CREATE TRIGGER command_identity_fixed BEFORE UPDATE ON idempotency_keys WHEN NEW.merchant_id IS NOT OLD.merchant_id OR NEW.key IS NOT OLD.key OR NEW.request_hash IS NOT OLD.request_hash OR NEW.operation IS NOT OLD.operation OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'command_identity_fixed'); END` }),
      operation({ name: "payment_events_append_only", objectType: "trigger", sql: `CREATE TRIGGER payment_events_append_only BEFORE UPDATE ON payment_events BEGIN SELECT RAISE(ABORT, 'payment_events_append_only'); END` }),
      operation({ name: "merchants_retained", objectType: "trigger", sql: `CREATE TRIGGER merchants_retained BEFORE DELETE ON merchants BEGIN SELECT RAISE(ABORT, 'merchants_retained'); END` }),
      operation({ name: "payment_intents_retained", objectType: "trigger", sql: `CREATE TRIGGER payment_intents_retained BEFORE DELETE ON payment_intents BEGIN SELECT RAISE(ABORT, 'payment_intents_retained'); END` }),
      operation({ name: "payment_events_retained", objectType: "trigger", sql: `CREATE TRIGGER payment_events_retained BEFORE DELETE ON payment_events BEGIN SELECT RAISE(ABORT, 'payment_events_retained'); END` }),
      operation({ name: "idempotency_keys_retained", objectType: "trigger", sql: `CREATE TRIGGER idempotency_keys_retained BEFORE DELETE ON idempotency_keys BEGIN SELECT RAISE(ABORT, 'idempotency_keys_retained'); END` }),
    ];
  }
}
MigrationCLI.run(import.meta.url, M);
