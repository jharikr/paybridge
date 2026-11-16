import { type } from "arktype";
import {
  merchantFixture,
  merchantPaymentSnapshot,
} from "../../../contracts/merchant.ts";
import { openMerchantDatabase } from "../../../apps/merchant/database.ts";
import { applyPaymentSnapshot } from "../../../apps/merchant/snapshots.ts";

const db = await openMerchantDatabase({
  path: type("string > 0").assert(process.argv[2]),
});
const instruction = type({
  receivingMerchantId: merchantFixture,
  snapshot: "unknown",
});
process.on("message", (message: unknown) => {
  const command = instruction.assert(message);
  const snapshot = merchantPaymentSnapshot(command.snapshot);
  if (snapshot instanceof type.errors) {
    process.send?.({ kind: "invalid" });
    return;
  }
  void db
    .transaction((tx) =>
      applyPaymentSnapshot({
        db,
        tx,
        receivingMerchantId: command.receivingMerchantId,
        snapshot,
      }),
    )
    .then((result) => process.send?.(result));
});
process.send?.({ kind: "ready" });
