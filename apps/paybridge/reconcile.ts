import { runReconciliationCli } from "./reconciliation-cli.ts";

await runReconciliationCli({ args: process.argv.slice(2) });
