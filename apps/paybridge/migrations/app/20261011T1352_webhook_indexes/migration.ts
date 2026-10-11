#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/9fbd3da4a17aaa43793ef7162f950da73dae1a48622c73cdf1385c6b1baf95e1/contract.d.ts';
import startContract from '../../snapshots/9fbd3da4a17aaa43793ef7162f950da73dae1a48622c73cdf1385c6b1baf95e1/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d5ae02ff34d91917746b2e5234ed309301094356de0c4b79b857da2b3d90e0d8/contract.d.ts';
import endContract from '../../snapshots/d5ae02ff34d91917746b2e5234ed309301094356de0c4b79b857da2b3d90e0d8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createIndex({
        table: 'webhook_outbox',
        index: 'webhook_outbox_merchant_id_created_at_idx_515bf5d4',
        columns: ['merchant_id', 'created_at'],
      }),
      this.createIndex({
        table: 'webhook_outbox',
        index: 'webhook_outbox_status_lease_expires_at_idx_7b34d2bd',
        columns: ['status', 'lease_expires_at'],
      }),
      this.createIndex({
        table: 'webhook_outbox',
        index: 'webhook_outbox_status_next_attempt_at_idx_139f8e47',
        columns: ['status', 'next_attempt_at'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
