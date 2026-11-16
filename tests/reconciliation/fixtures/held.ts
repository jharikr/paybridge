import { runReconciliationCli } from "../../../apps/paybridge/reconciliation-cli.ts";

await runReconciliationCli({
  args: process.argv.slice(2),
  beforeCommit: async () => {
    process.send?.({ kind: "resolution-writes-held" });
    await new Promise<void>(() => {});
  },
});
