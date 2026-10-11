import { open } from "node:fs/promises";
import { type } from "arktype";
import { reconciliationCommand } from "../../contracts/reconciliation.ts";
import { openPaybridgeDatabase } from "./database.ts";
import { reconcile, ReconciliationError } from "./reconciliation.ts";

export async function runReconciliationCli({
  args,
  beforeCommit,
}: {
  args: string[];
  beforeCommit?: () => Promise<void>;
}) {
  try {
    const input = type(["string > 0", "string > 0"])(args);
    if (input instanceof type.errors)
      throw new ReconciliationError("invalid_command");
    const [path, commandPath] = input;
    const command = await readCommand(commandPath);
    const db = await openPaybridgeDatabase({ path });
    try {
      const result = await reconcile({
        db,
        command,
        ...(beforeCommit ? { beforeCommit } : {}),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await db.close();
    }
  } catch (cause) {
    const code =
      cause instanceof ReconciliationError
        ? cause.code
        : cause instanceof Error &&
            "transient" in cause &&
            cause.transient === true
          ? "temporarily_unavailable"
          : "reconciliation_failed";
    process.stdout.write(`${JSON.stringify({ kind: "error", code })}\n`);
    process.exitCode = 1;
  }
}

async function readCommand(path: string) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16385);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 16384) throw new ReconciliationError("invalid_command");
    const input: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
    const command = reconciliationCommand(input);
    if (command instanceof type.errors)
      throw new ReconciliationError("invalid_command");
    return command;
  } catch {
    throw new ReconciliationError("invalid_command");
  } finally {
    await file.close();
  }
}
