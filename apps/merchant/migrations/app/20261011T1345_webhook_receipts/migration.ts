#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1032b12551e45942d46663a44528d8c8b63d2198aeee523eeea330c6af95a54e/contract.d.ts';
import endContract from '../../snapshots/1032b12551e45942d46663a44528d8c8b63d2198aeee523eeea330c6af95a54e/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/5124c0135cca8451f39c2883931e44372af72eae8562378e2b8e15607d3e44ad/contract.d.ts';
import startContract from '../../snapshots/5124c0135cca8451f39c2883931e44372af72eae8562378e2b8e15607d3e44ad/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma/orm-sqlite/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({id:'table.webhook_inbox',label:'Create webhook inbox',operationClass:'additive',target:{id:'sqlite',details:{schema:'main',objectType:'table',name:'webhook_inbox'}},precheck:[],execute:[{description:'Create authenticated receipt storage',params:[],sql:`CREATE TABLE webhook_inbox (
        event_id TEXT PRIMARY KEY NOT NULL,
        receiving_merchant_id TEXT NOT NULL REFERENCES merchant_contexts(id),
        payment_intent_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('payment.succeeded','payment.failed','payment.unknown','payment.cancelled')),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 16384),
        payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
        status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','PROCESSED')),
        attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count>=0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT CHECK(last_error IS NULL OR length(last_error)<=128),
        received_at TEXT NOT NULL,
        processed_at TEXT,
        claim_token TEXT,
        locked_by TEXT,
        lease_expires_at TEXT,
        CHECK ((status='PROCESSING' AND claim_token IS NOT NULL AND locked_by IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status!='PROCESSING' AND claim_token IS NULL AND locked_by IS NULL AND lease_expires_at IS NULL)),
        CHECK ((status='PROCESSED' AND processed_at IS NOT NULL) OR (status!='PROCESSED' AND processed_at IS NULL)),
        CHECK (json_extract(payload,'$.id') IS event_id AND json_extract(payload,'$.data.paymentIntentId') IS payment_intent_id AND json_extract(payload,'$.type') IS event_type AND json_extract(payload,'$.data.revision') IS revision)
      )`}],postcheck:[{description:'Verify receipt table',sql:"SELECT COUNT(*)=1 AS result FROM sqlite_master WHERE type='table' AND name='webhook_inbox'",params:[]}]}),
      this.createIndex({
        table: 'webhook_inbox',
        index: 'webhook_inbox_receiving_merchant_id_idx_0e4c83ef',
        columns: ['receiving_merchant_id'],
      }),
      this.createIndex({
        table: 'webhook_inbox',
        index: 'webhook_inbox_status_lease_expires_at_idx_7b34d2bd',
        columns: ['status', 'lease_expires_at'],
      }),
      this.createIndex({
        table: 'webhook_inbox',
        index: 'webhook_inbox_status_next_attempt_at_idx_139f8e47',
        columns: ['status', 'next_attempt_at'],
      }),
      ...[
        {name:'webhook_receipt_fixed',sql:"BEFORE UPDATE ON webhook_inbox WHEN NEW.event_id IS NOT OLD.event_id OR NEW.receiving_merchant_id IS NOT OLD.receiving_merchant_id OR NEW.payment_intent_id IS NOT OLD.payment_intent_id OR NEW.event_type IS NOT OLD.event_type OR NEW.revision IS NOT OLD.revision OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.received_at IS NOT OLD.received_at"},
        {name:'webhook_receipt_retained',sql:"BEFORE DELETE ON webhook_inbox"},
        {name:'webhook_processed_fixed',sql:"BEFORE UPDATE ON webhook_inbox WHEN OLD.status='PROCESSED'"},
        {name:'webhook_receipt_attempts_monotonic',sql:"BEFORE UPDATE ON webhook_inbox WHEN NEW.attempt_count<OLD.attempt_count"},
      ].map(({name,sql})=>rawSql({id:`trigger.${name}`,label:`Create ${name}`,operationClass:'additive',target:{id:'sqlite'},precheck:[],execute:[{description:`Create ${name}`,sql:`CREATE TRIGGER ${name} ${sql} BEGIN SELECT RAISE(ABORT,'${name}'); END`,params:[]}],postcheck:[{description:`Verify ${name}`,sql:"SELECT COUNT(*)=1 AS result FROM sqlite_master WHERE type='trigger' AND name=?",params:[name]}]})),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
