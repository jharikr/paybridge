import { runReconciliationCli } from "../../../apps/paybridge/reconciliation-cli.ts";

await runReconciliationCli({
  args: process.argv.slice(2),
  beforeCommit: async () => {
    throw new Error("Injected reconciliation rollback");
  },
});
