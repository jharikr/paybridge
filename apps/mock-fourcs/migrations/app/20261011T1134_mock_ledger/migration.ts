#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/d6130d0e416289c70b3e182a77898b2b781aefecf3d50dc4a609bff8c0b5ed67/contract.d.ts';
import endContract from '../../snapshots/d6130d0e416289c70b3e182a77898b2b781aefecf3d50dc4a609bff8c0b5ed67/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey, unique, rawSql } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: 'mock_transactions',
        columns: [
          col('accepted_at', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('amount_minor', 'INTEGER', {
            notNull: true,
            codecRef: { codecId: 'sqlite/integer@1' },
          }),
          col('approval_code', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('currency', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('effect_count', 'INTEGER', {
            notNull: true,
            codecRef: { codecId: 'sqlite/integer@1' },
          }),
          col('final_outcome', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('host_reference', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('invoice', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('payment_method_ref', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('provider_account', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('request_fingerprint', 'TEXT', {
            notNull: true,
            codecRef: { codecId: 'sqlite/text@1' },
          }),
          col('tran_id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [primaryKey(['id']), unique(['provider_account', 'tran_id'])],
      }),
      rawSql({
        id: 'ledger.constraints',
        label: 'Enforce final synthetic ledger facts',
        operationClass: 'additive',
        target: { id: 'sqlite', details: { schema: 'main', objectType: 'table', name: 'mock_transactions' } },
        precheck: [],
        execute: [
          { description: 'Validate accepted facts', sql: `CREATE TRIGGER mock_transactions_validate BEFORE INSERT ON mock_transactions
            WHEN NEW.provider_account NOT IN ('mock-account-a', 'mock-account-b')
              OR typeof(NEW.amount_minor) <> 'integer' OR NEW.amount_minor NOT BETWEEN 1 AND 9999999999
              OR NEW.currency <> 'XCD' OR NEW.final_outcome NOT IN ('Approved', 'Declined', 'Incomplete')
              OR NEW.effect_count <> CASE WHEN NEW.final_outcome = 'Approved' THEN 1 ELSE 0 END
              OR length(NEW.tran_id) NOT BETWEEN 1 AND 16 OR NEW.tran_id GLOB '*[^A-Za-z0-9]*'
              OR length(NEW.invoice) NOT BETWEEN 1 AND 16 OR NEW.invoice GLOB '*[^A-Za-z0-9]*'
            BEGIN SELECT RAISE(ABORT, 'Invalid synthetic ledger facts'); END`, params: [] },
          { description: 'Retain original facts', sql: `CREATE TRIGGER mock_transactions_no_update BEFORE UPDATE ON mock_transactions
            BEGIN SELECT RAISE(ABORT, 'Mock ledger facts are immutable'); END`, params: [] },
          { description: 'Retain ledger history', sql: `CREATE TRIGGER mock_transactions_no_delete BEFORE DELETE ON mock_transactions
            BEGIN SELECT RAISE(ABORT, 'Mock ledger facts are immutable'); END`, params: [] },
        ],
        postcheck: [{ description: 'Verify ledger guards', sql: "SELECT COUNT(*) = 3 AS result FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mock_transactions'", params: [] }],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
