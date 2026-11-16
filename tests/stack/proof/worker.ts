import { type } from "arktype";
import { openProofDatabase, writeProofRecord } from "./database.ts";

const command = type(
  {
    kind: "'claim'",
    id: "string",
    token: "string",
    now: "number.integer",
    "+": "reject",
  },
  "|",
  { kind: "'complete'", id: "string", token: "string", "+": "reject" },
)
  .or({ kind: "'hold'", "+": "reject" })
  .or({ kind: "'read'", id: "string", "+": "reject" });
const path = type("string > 0").assert(process.argv[2]);
const db = await openProofDatabase({ path });

async function run(value: unknown) {
  const input = command.assert(value);
  switch (input.kind) {
    case "claim": {
      const result = await db.runtime().execute(
        db.raw.sql`
        UPDATE proof_work SET status = 'CLAIMED', claim_token = ${input.token}, lease_until = ${input.now + 10}
        WHERE id = ${input.id} AND (status = 'PENDING' OR (status = 'CLAIMED' AND lease_until <= ${input.now}))
      `
          .affectedCount()
          .build(),
      );
      process.send?.({ kind: "changed", count: result.affectedRows });
      return;
    }
    case "complete": {
      const result = await db.runtime().execute(
        db.raw.sql`
        UPDATE proof_work SET status = 'COMPLETED', claim_token = NULL, lease_until = NULL
        WHERE id = ${input.id} AND status = 'CLAIMED' AND claim_token = ${input.token}
      `
          .affectedCount()
          .build(),
      );
      process.send?.({ kind: "changed", count: result.affectedRows });
      return;
    }
    case "hold":
      await writeProofRecord({
        db,
        record: { id: "interrupted", label: "Never commit", amount: 9900 },
        afterWrites: () =>
          new Promise<void>(() => {
            process.send?.({ kind: "writes-held" });
          }),
      });
      return;
    case "read":
      process.send?.({
        kind: "record",
        record: await db.orm.ProofRecord.where({ id: input.id }).first(),
      });
      return;
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

process.on("message", (value: unknown) => {
  void run(value).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "transient" in error &&
      error.transient === true
    ) {
      process.send?.({ kind: "busy" });
      return;
    }
    process.send?.({
      kind: "error",
      message: error instanceof Error ? error.message : "Worker failed",
    });
    process.exitCode = 1;
    process.disconnect?.();
  });
});
process.send?.({ kind: "ready" });
