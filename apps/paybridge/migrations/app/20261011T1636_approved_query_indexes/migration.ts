#!/usr/bin/env -S node
import type { Contract as End } from "../../snapshots/90bb09ae6a605504ed3bdf17e5137c2ad2d4aa3b7891ac0f7d7d546b4e88355b/contract.d.ts";
import endContract from "../../snapshots/90bb09ae6a605504ed3bdf17e5137c2ad2d4aa3b7891ac0f7d7d546b4e88355b/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/d5ae02ff34d91917746b2e5234ed309301094356de0c4b79b857da2b3d90e0d8/contract.d.ts";
import startContract from "../../snapshots/d5ae02ff34d91917746b2e5234ed309301094356de0c4b79b857da2b3d90e0d8/contract.json" with { type: "json" };
import { Migration, MigrationCLI } from "@prisma/orm-sqlite/migration";

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createIndex({
        table: "payment_events",
        index: "payment_events_payment_intent_id_created_at_idx_e9f35b8e",
        columns: ["payment_intent_id", "created_at"],
      }),
      this.createIndex({
        table: "payment_intents",
        index: "payment_intents_created_at_idx_225d8c0f",
        columns: ["created_at"],
      }),
      this.createIndex({
        table: "payment_intents",
        index: "payment_intents_merchant_id_merchant_reference_idx_560fb5c7",
        columns: ["merchant_id", "merchant_reference"],
      }),
      this.createIndex({
        table: "payment_intents",
        index: "payment_intents_merchant_id_status_idx_06a43d97",
        columns: ["merchant_id", "status"],
      }),
      this.dropIndex({
        table: "idempotency_keys",
        index: "idempotency_keys_merchant_id_idx_92be5ce7",
      }),
      this.dropIndex({
        table: "payment_attempts",
        index: "payment_attempts_payment_intent_id_idx_2dc6a9d2",
      }),
      this.dropIndex({
        table: "payment_events",
        index: "payment_events_payment_intent_id_idx_2dc6a9d2",
      }),
      this.dropIndex({
        table: "payment_intents",
        index: "payment_intents_merchant_id_idx_92be5ce7",
      }),
      this.dropIndex({
        table: "webhook_outbox",
        index: "webhook_outbox_merchant_id_idx_92be5ce7",
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
