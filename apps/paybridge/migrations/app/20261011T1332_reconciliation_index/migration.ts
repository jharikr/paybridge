#!/usr/bin/env -S node
import type { Contract as End } from "../../snapshots/9fbd3da4a17aaa43793ef7162f950da73dae1a48622c73cdf1385c6b1baf95e1/contract.d.ts";
import endContract from "../../snapshots/9fbd3da4a17aaa43793ef7162f950da73dae1a48622c73cdf1385c6b1baf95e1/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/b81791e37db9f73e826b73c7def36cc02f1057bb1ba5ead750406228108cbb06/contract.d.ts";
import startContract from "../../snapshots/b81791e37db9f73e826b73c7def36cc02f1057bb1ba5ead750406228108cbb06/contract.json" with { type: "json" };
import { Migration, MigrationCLI } from "@prisma/orm-sqlite/migration";

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createIndex({
        table: "reconciliations",
        index: "reconciliations_status_created_at_idx_1bbe8adf",
        columns: ["status", "created_at"],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
