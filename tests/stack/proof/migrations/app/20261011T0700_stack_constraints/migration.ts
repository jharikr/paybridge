#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/6c6e774db4686c0e2c496ce9d6194075f18719805f72debbec9dde8befa83511/contract.d.ts';
import endContract from '../../snapshots/6c6e774db4686c0e2c496ce9d6194075f18719805f72debbec9dde8befa83511/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b6686dc8b4ec4f96386bf5cb0b333f5c021830e22fb6ccd2ce52f23d3bcfdde2/contract.d.ts';
import startContract from '../../snapshots/b6686dc8b4ec4f96386bf5cb0b333f5c021830e22fb6ccd2ce52f23d3bcfdde2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'table.proof_attempts',
        label: 'Create constrained proof attempts',
        operationClass: 'additive',
        target: { id: 'sqlite', details: { schema: 'main', objectType: 'table', name: 'proof_attempts' } },
        precheck: [],
        execute: [{
          description: 'Create proof attempts with foreign key and state check',
          sql: `CREATE TABLE proof_attempts (
            id TEXT NOT NULL PRIMARY KEY,
            record_id TEXT NOT NULL REFERENCES proof_records(id),
            status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'UNKNOWN', 'FAILED', 'SUCCEEDED'))
          )`,
          params: [],
        }],
        postcheck: [{ description: 'Verify proof attempts', sql: "SELECT COUNT(*) = 1 AS result FROM sqlite_master WHERE type = 'table' AND name = 'proof_attempts'", params: [] }],
      }),
      this.createIndex({
        table: 'proof_attempts',
        index: 'proof_attempts_record_id_idx_ab8d411c',
        columns: ['record_id'],
      }),
      rawSql({
        id: 'index.proof_attempts.unresolved',
        label: 'Allow only one unresolved proof attempt',
        operationClass: 'additive',
        target: { id: 'sqlite', details: { schema: 'main', objectType: 'index', name: 'proof_attempts_one_unresolved' } },
        precheck: [],
        execute: [{ description: 'Create partial unique index', sql: "CREATE UNIQUE INDEX proof_attempts_one_unresolved ON proof_attempts(record_id) WHERE status IN ('PROCESSING', 'UNKNOWN')", params: [] }],
        postcheck: [{ description: 'Verify partial unique index', sql: "SELECT COUNT(*) = 1 AS result FROM sqlite_master WHERE type = 'index' AND name = 'proof_attempts_one_unresolved'", params: [] }],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
