#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/5ed58edae76b2e463e1b3e5fb904250a3121c0223ab8f4b311e1fb185f561199/contract.d.ts';
import endContract from '../../snapshots/5ed58edae76b2e463e1b3e5fb904250a3121c0223ab8f4b311e1fb185f561199/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/6c6e774db4686c0e2c496ce9d6194075f18719805f72debbec9dde8befa83511/contract.d.ts';
import startContract from '../../snapshots/6c6e774db4686c0e2c496ce9d6194075f18719805f72debbec9dde8befa83511/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: 'proof_work',
        columns: [
          col('claim_token', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('lease_until', 'INTEGER', { codecRef: { codecId: 'sqlite/integer@1' } }),
          col('status', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
