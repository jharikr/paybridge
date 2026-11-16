#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/b6686dc8b4ec4f96386bf5cb0b333f5c021830e22fb6ccd2ce52f23d3bcfdde2/contract.d.ts';
import endContract from '../../snapshots/b6686dc8b4ec4f96386bf5cb0b333f5c021830e22fb6ccd2ce52f23d3bcfdde2/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'table.proof_records',
        label: 'Create bounded proof records',
        operationClass: 'additive',
        target: { id: 'sqlite', details: { schema: 'main', objectType: 'table', name: 'proof_records' } },
        precheck: [],
        execute: [{
          description: 'Create proof records with a positive safe integer check',
          sql: `CREATE TABLE proof_records (
            id TEXT NOT NULL PRIMARY KEY,
            label TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount BETWEEN 1 AND 9007199254740991)
          )`,
          params: [],
        }],
        postcheck: [{ description: 'Verify proof records', sql: "SELECT COUNT(*) = 1 AS result FROM sqlite_master WHERE type = 'table' AND name = 'proof_records'", params: [] }],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
