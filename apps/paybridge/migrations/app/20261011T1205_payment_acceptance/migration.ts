#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/4f8c8ff366a53054d16a2ef113d26f49096154023650a816fb53500d285aaec8/contract.d.ts';
import startContract from '../../snapshots/4f8c8ff366a53054d16a2ef113d26f49096154023650a816fb53500d285aaec8/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/668fba7bd586d6ca897717a237ca3168f1a4d85aeace6872024ae7d849d6564c/contract.d.ts';
import endContract from '../../snapshots/668fba7bd586d6ca897717a237ca3168f1a4d85aeace6872024ae7d849d6564c/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  foreignKey,
  primaryKey,
  unique,
  rawSql,
} from '@prisma/orm-sqlite/migration';


function constraint({ name, sql, objectType = "trigger" }: { name: string; sql: string; objectType?: "index" | "trigger" }) {
  return rawSql({
    id: `${objectType}.${name}`, label: `Create ${name}`, operationClass: "additive",
    target: { id: "sqlite" }, precheck: [],
    execute: [{ description: `Create ${name}`, sql, params: [] }],
    postcheck: [{ description: `Verify ${name}`, sql: "SELECT COUNT(*) = 1 AS result FROM sqlite_master WHERE type = ? AND name = ?", params: [objectType, name] }],
  });
}

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: 'payment_attempts',
        columns: [
          col('attempt_number', 'INTEGER', {
            notNull: true,
            codecRef: { codecId: 'sqlite/integer@1' },
          }),
          col('created_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('failure_code', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('failure_message', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('mock_payment_method_ref', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('payment_intent_id', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('provider', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('provider_account_ref', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('provider_financial_result', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('provider_host_reference', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('provider_operation_result', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('provider_service_result', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('provider_transaction_id', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('status', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('updated_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          unique(['payment_intent_id', 'attempt_number']),
          unique(['provider', 'provider_transaction_id']),
          foreignKey(['payment_intent_id'], 'payment_intents', ['id']),
        ],
      }),
      this.createTable({
        table: 'provider_outbox',
        columns: [
          col('attempt_count', 'INTEGER', {
            notNull: true,
            codecRef: { codecId: 'sqlite/integer@1' },
          }),
          col('claim_token', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('completed_at', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('created_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('last_error', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('lease_expires_at', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('locked_by', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('next_attempt_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('payment_attempt_id', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('status', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('updated_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          unique(['payment_attempt_id']),
          foreignKey(['payment_attempt_id'], 'payment_attempts', ['id']),
        ],
      }),
      this.createTable({
        table: 'webhook_outbox',
        columns: [
          col('attempt_count', 'INTEGER', {
            notNull: true,
            codecRef: { codecId: 'sqlite/integer@1' },
          }),
          col('claim_token', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('created_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('delivered_at', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('event_type', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('last_error', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('lease_expires_at', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('locked_by', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('merchant_id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('next_attempt_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('payload', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('payment_event_id', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('payment_intent_id', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('status', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          unique(['payment_event_id']),
          foreignKey(['merchant_id'], 'merchants', ['id']),
          foreignKey(['payment_intent_id'], 'payment_intents', ['id']),
          foreignKey(['payment_event_id'], 'payment_events', ['id']),
        ],
      }),
      this.createIndex({
        table: 'payment_attempts',
        index: 'payment_attempts_payment_intent_id_idx_2dc6a9d2',
        columns: ['payment_intent_id'],
      }),
      this.createIndex({
        table: 'webhook_outbox',
        index: 'webhook_outbox_merchant_id_idx_92be5ce7',
        columns: ['merchant_id'],
      }),
      this.createIndex({
        table: 'webhook_outbox',
        index: 'webhook_outbox_payment_intent_id_idx_2dc6a9d2',
        columns: ['payment_intent_id'],
      }),
      constraint({ name: "one_unresolved_attempt", objectType: "index", sql: `CREATE UNIQUE INDEX one_unresolved_attempt ON payment_attempts(payment_intent_id) WHERE status IN ('PROCESSING', 'UNKNOWN')` }),
      constraint({ name: "attempt_identity_fixed", sql: `CREATE TRIGGER attempt_identity_fixed BEFORE UPDATE ON payment_attempts WHEN NEW.id IS NOT OLD.id OR NEW.payment_intent_id IS NOT OLD.payment_intent_id OR NEW.attempt_number IS NOT OLD.attempt_number OR NEW.provider IS NOT OLD.provider OR NEW.provider_account_ref IS NOT OLD.provider_account_ref OR NEW.provider_transaction_id IS NOT OLD.provider_transaction_id OR NEW.mock_payment_method_ref IS NOT OLD.mock_payment_method_ref OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'attempt_identity_fixed'); END` }),
      constraint({ name: "attempt_input_valid", sql: `CREATE TRIGGER attempt_input_valid BEFORE INSERT ON payment_attempts WHEN NEW.provider <> '4cs' OR typeof(NEW.attempt_number) <> 'integer' OR NEW.attempt_number < 1 OR length(NEW.provider_transaction_id) NOT BETWEEN 1 AND 16 OR NEW.provider_transaction_id GLOB '*[^A-Za-z0-9]*' OR NOT EXISTS (SELECT 1 FROM payment_intents p JOIN merchants m ON m.id = p.merchant_id WHERE p.id = NEW.payment_intent_id AND m.provider_account_ref = NEW.provider_account_ref) BEGIN SELECT RAISE(ABORT, 'attempt_input_valid'); END` }),
      constraint({ name: "attempt_status_insert", sql: `CREATE TRIGGER attempt_status_insert BEFORE INSERT ON payment_attempts WHEN NEW.status NOT IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN') BEGIN SELECT RAISE(ABORT, 'attempt_status_insert'); END` }),
      constraint({ name: "attempt_status_update", sql: `CREATE TRIGGER attempt_status_update BEFORE UPDATE ON payment_attempts WHEN NEW.status NOT IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN') BEGIN SELECT RAISE(ABORT, 'attempt_status_update'); END` }),
      constraint({ name: "attempt_transition", sql: `CREATE TRIGGER attempt_transition BEFORE UPDATE ON payment_attempts WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN')) OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED'))) BEGIN SELECT RAISE(ABORT, 'attempt_transition'); END` }),
      constraint({ name: "payment_transition", sql: `CREATE TRIGGER payment_transition BEFORE UPDATE ON payment_intents WHEN NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'CANCELLED')) OR (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN')) OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED')) OR (OLD.status = 'FAILED' AND NEW.status = 'PROCESSING')) BEGIN SELECT RAISE(ABORT, 'payment_transition'); END` }),
      constraint({ name: "command_attempt_matches", sql: `CREATE TRIGGER command_attempt_matches BEFORE UPDATE ON idempotency_keys WHEN NEW.payment_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE id = NEW.payment_attempt_id AND payment_intent_id = NEW.resource_id) BEGIN SELECT RAISE(ABORT, 'command_attempt_matches'); END` }),
      constraint({ name: "event_attempt_matches", sql: `CREATE TRIGGER event_attempt_matches BEFORE INSERT ON payment_events WHEN NEW.payment_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE id = NEW.payment_attempt_id AND payment_intent_id = NEW.payment_intent_id) BEGIN SELECT RAISE(ABORT, 'event_attempt_matches'); END` }),
      constraint({ name: "provider_work_identity_fixed", sql: `CREATE TRIGGER provider_work_identity_fixed BEFORE UPDATE ON provider_outbox WHEN NEW.id IS NOT OLD.id OR NEW.payment_attempt_id IS NOT OLD.payment_attempt_id OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'provider_work_identity_fixed'); END` }),
      constraint({ name: "webhook_identity_fixed", sql: `CREATE TRIGGER webhook_identity_fixed BEFORE UPDATE ON webhook_outbox WHEN NEW.id IS NOT OLD.id OR NEW.payment_event_id IS NOT OLD.payment_event_id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.payment_intent_id IS NOT OLD.payment_intent_id OR NEW.event_type IS NOT OLD.event_type OR NEW.payload IS NOT OLD.payload OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'webhook_identity_fixed'); END` }),
      constraint({ name: "webhook_owner_matches", sql: `CREATE TRIGGER webhook_owner_matches BEFORE INSERT ON webhook_outbox WHEN NOT EXISTS (SELECT 1 FROM payment_events e JOIN payment_intents p ON p.id = e.payment_intent_id WHERE e.id = NEW.payment_event_id AND e.payment_intent_id = NEW.payment_intent_id AND p.merchant_id = NEW.merchant_id) BEGIN SELECT RAISE(ABORT, 'webhook_owner_matches'); END` }),
      constraint({ name: "provider_outbox_state_insert", sql: `CREATE TRIGGER provider_outbox_state_insert BEFORE INSERT ON provider_outbox WHEN NEW.status NOT IN ('PENDING', 'PROCESSING', 'COMPLETED') OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR (NEW.status = 'PROCESSING' AND (NEW.claim_token IS NULL OR NEW.locked_by IS NULL OR NEW.lease_expires_at IS NULL)) OR (NEW.status <> 'PROCESSING' AND (NEW.claim_token IS NOT NULL OR NEW.locked_by IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) OR (NEW.status = 'COMPLETED' AND NEW.completed_at IS NULL) OR (NEW.status <> 'COMPLETED' AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'provider_outbox_state_insert'); END` }),
      constraint({ name: "provider_outbox_state_update", sql: `CREATE TRIGGER provider_outbox_state_update BEFORE UPDATE ON provider_outbox WHEN NEW.status NOT IN ('PENDING', 'PROCESSING', 'COMPLETED') OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR (NEW.status = 'PROCESSING' AND (NEW.claim_token IS NULL OR NEW.locked_by IS NULL OR NEW.lease_expires_at IS NULL)) OR (NEW.status <> 'PROCESSING' AND (NEW.claim_token IS NOT NULL OR NEW.locked_by IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) OR (NEW.status = 'COMPLETED' AND NEW.completed_at IS NULL) OR (NEW.status <> 'COMPLETED' AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'provider_outbox_state_update'); END` }),
      constraint({ name: "webhook_outbox_state_insert", sql: `CREATE TRIGGER webhook_outbox_state_insert BEFORE INSERT ON webhook_outbox WHEN NEW.status NOT IN ('PENDING', 'PROCESSING', 'DELIVERED') OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR (NEW.status = 'PROCESSING' AND (NEW.claim_token IS NULL OR NEW.locked_by IS NULL OR NEW.lease_expires_at IS NULL)) OR (NEW.status <> 'PROCESSING' AND (NEW.claim_token IS NOT NULL OR NEW.locked_by IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) OR (NEW.status = 'DELIVERED' AND NEW.delivered_at IS NULL) OR (NEW.status <> 'DELIVERED' AND NEW.delivered_at IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'webhook_outbox_state_insert'); END` }),
      constraint({ name: "webhook_outbox_state_update", sql: `CREATE TRIGGER webhook_outbox_state_update BEFORE UPDATE ON webhook_outbox WHEN NEW.status NOT IN ('PENDING', 'PROCESSING', 'DELIVERED') OR typeof(NEW.attempt_count) <> 'integer' OR NEW.attempt_count < 0 OR (NEW.status = 'PROCESSING' AND (NEW.claim_token IS NULL OR NEW.locked_by IS NULL OR NEW.lease_expires_at IS NULL)) OR (NEW.status <> 'PROCESSING' AND (NEW.claim_token IS NOT NULL OR NEW.locked_by IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) OR (NEW.status = 'DELIVERED' AND NEW.delivered_at IS NULL) OR (NEW.status <> 'DELIVERED' AND NEW.delivered_at IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'webhook_outbox_state_update'); END` }),
      constraint({ name: "payment_attempts_retained", sql: `CREATE TRIGGER payment_attempts_retained BEFORE DELETE ON payment_attempts  BEGIN SELECT RAISE(ABORT, 'payment_attempts_retained'); END` }),
      constraint({ name: "provider_outbox_retained", sql: `CREATE TRIGGER provider_outbox_retained BEFORE DELETE ON provider_outbox  BEGIN SELECT RAISE(ABORT, 'provider_outbox_retained'); END` }),
      constraint({ name: "webhook_outbox_retained", sql: `CREATE TRIGGER webhook_outbox_retained BEFORE DELETE ON webhook_outbox  BEGIN SELECT RAISE(ABORT, 'webhook_outbox_retained'); END` }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
