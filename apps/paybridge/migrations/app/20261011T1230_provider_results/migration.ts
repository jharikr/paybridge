#!/usr/bin/env -S node
import type { Contract as End } from "../../snapshots/b81791e37db9f73e826b73c7def36cc02f1057bb1ba5ead750406228108cbb06/contract.d.ts";
import endContract from "../../snapshots/b81791e37db9f73e826b73c7def36cc02f1057bb1ba5ead750406228108cbb06/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/668fba7bd586d6ca897717a237ca3168f1a4d85aeace6872024ae7d849d6564c/contract.d.ts";
import startContract from "../../snapshots/668fba7bd586d6ca897717a237ca3168f1a4d85aeace6872024ae7d849d6564c/contract.json" with { type: "json" };
import {
  Migration,
  MigrationCLI,
  col,
  foreignKey,
  primaryKey,
  unique,
  rawSql,
} from "@prisma/orm-sqlite/migration";

function constraint({ name, sql }: { name: string; sql: string }) {
  return rawSql({
    id: `trigger.${name}`,
    label: `Create ${name}`,
    operationClass: "additive",
    target: { id: "sqlite" },
    precheck: [],
    execute: [{ description: `Create ${name}`, sql, params: [] }],
    postcheck: [
      {
        description: `Verify ${name}`,
        sql: "SELECT COUNT(*) = 1 AS result FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        params: [name],
      },
    ],
  });
}
const invalidState = `NEW.status NOT IN ('REQUIRED', 'IN_PROGRESS', 'RESOLVED') OR
  (NEW.status = 'RESOLVED' AND (NEW.resolution IS NULL OR NEW.resolution NOT IN ('SUCCEEDED', 'FAILED') OR NEW.resolved_at IS NULL OR NEW.resolved_by IS NULL OR NEW.evidence_reference IS NULL OR NEW.evidence IS NULL OR NOT json_valid(NEW.evidence))) OR
  (NEW.status <> 'RESOLVED' AND (NEW.resolution IS NOT NULL OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by IS NOT NULL OR NEW.evidence_reference IS NOT NULL OR NEW.evidence IS NOT NULL)) OR
  (NEW.status = 'REQUIRED' AND (NEW.started_at IS NOT NULL OR NEW.started_by IS NOT NULL)) OR
  (NEW.status = 'IN_PROGRESS' AND (NEW.started_at IS NULL OR NEW.started_by IS NULL))`;

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: "reconciliations",
        columns: [
          col("created_at", "TEXT", {
            notNull: true,
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("evidence", "TEXT", { codecRef: { codecId: "sqlite/text@1" } }),
          col("evidence_reference", "TEXT", {
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("id", "TEXT", {
            notNull: true,
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("notes", "TEXT", { codecRef: { codecId: "sqlite/text@1" } }),
          col("payment_attempt_id", "TEXT", {
            notNull: true,
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("payment_intent_id", "TEXT", {
            notNull: true,
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("reason", "TEXT", {
            notNull: true,
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("resolution", "TEXT", { codecRef: { codecId: "sqlite/text@1" } }),
          col("resolved_at", "TEXT", {
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("resolved_by", "TEXT", {
            codecRef: { codecId: "sqlite/text@1" },
          }),
          col("started_at", "TEXT", { codecRef: { codecId: "sqlite/text@1" } }),
          col("started_by", "TEXT", { codecRef: { codecId: "sqlite/text@1" } }),
          col("status", "TEXT", {
            notNull: true,
            codecRef: { codecId: "sqlite/text@1" },
          }),
        ],
        constraints: [
          primaryKey(["id"]),
          unique(["payment_attempt_id"]),
          foreignKey(["payment_intent_id"], "payment_intents", ["id"]),
          foreignKey(["payment_attempt_id"], "payment_attempts", ["id"]),
        ],
      }),
      this.createIndex({
        table: "reconciliations",
        index: "reconciliations_payment_intent_id_idx_2dc6a9d2",
        columns: ["payment_intent_id"],
      }),
      this.createIndex({
        table: "provider_outbox",
        index: "provider_outbox_status_next_attempt_at_idx_139f8e47",
        columns: ["status", "next_attempt_at"],
      }),
      this.createIndex({
        table: "provider_outbox",
        index: "provider_outbox_status_lease_expires_at_idx_7b34d2bd",
        columns: ["status", "lease_expires_at"],
      }),
      constraint({
        name: "reconciliation_identity_fixed",
        sql: `CREATE TRIGGER reconciliation_identity_fixed BEFORE UPDATE ON reconciliations WHEN NEW.id IS NOT OLD.id OR NEW.payment_intent_id IS NOT OLD.payment_intent_id OR NEW.payment_attempt_id IS NOT OLD.payment_attempt_id OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT, 'reconciliation_identity_fixed'); END`,
      }),
      constraint({
        name: "reconciliation_attempt_matches",
        sql: `CREATE TRIGGER reconciliation_attempt_matches BEFORE INSERT ON reconciliations WHEN NEW.status <> 'REQUIRED' OR NOT EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_intents p ON p.id = a.payment_intent_id WHERE a.id = NEW.payment_attempt_id AND a.payment_intent_id = NEW.payment_intent_id AND a.status = 'UNKNOWN' AND p.status = 'UNKNOWN') BEGIN SELECT RAISE(ABORT, 'reconciliation_attempt_matches'); END`,
      }),
      constraint({
        name: "reconciliation_state_insert",
        sql: `CREATE TRIGGER reconciliation_state_insert BEFORE INSERT ON reconciliations WHEN ${invalidState} BEGIN SELECT RAISE(ABORT, 'reconciliation_state_insert'); END`,
      }),
      constraint({
        name: "reconciliation_state_update",
        sql: `CREATE TRIGGER reconciliation_state_update BEFORE UPDATE ON reconciliations WHEN ${invalidState} BEGIN SELECT RAISE(ABORT, 'reconciliation_state_update'); END`,
      }),
      constraint({
        name: "reconciliation_transition",
        sql: `CREATE TRIGGER reconciliation_transition BEFORE UPDATE ON reconciliations WHEN OLD.status = 'RESOLVED' OR (OLD.status = 'IN_PROGRESS' AND NEW.status = 'REQUIRED') BEGIN SELECT RAISE(ABORT, 'reconciliation_transition'); END`,
      }),
      constraint({
        name: "reconciliation_retained",
        sql: `CREATE TRIGGER reconciliation_retained BEFORE DELETE ON reconciliations BEGIN SELECT RAISE(ABORT, 'reconciliation_retained'); END`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
