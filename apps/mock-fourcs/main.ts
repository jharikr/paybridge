import { failureDetails, safeFailure } from "../../contracts/diagnostics.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { createMockFourcs } from "./server.ts";
import type { MockCheckpoint } from "./server.ts";

const releaseCommand = type({
  kind: "'release'",
  gateId: "string",
  "+": "reject",
});
const portSchema = type("number.integer >= 0").atMost(65535);
const gates = new Map<string, () => void>();
async function controlledCheckpoint(event: MockCheckpoint) {
  const gateId = event.held ? randomUUID() : null;
  const wait =
    gateId === null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          gates.set(gateId, resolve);
        });
  process.send?.({
    kind: event.kind,
    providerAccount: event.providerAccount,
    tranId: event.tranId,
    gateId,
  });
  await wait;
}

try {
  const path = process.argv[2] ?? ".data/mock-fourcs.db";
  const port = portSchema.assert(Number(process.argv[3] ?? "3102"));
  const controlled = process.argv[4] === "--test-control";
  if (controlled && !process.send)
    throw new Error("Test control requires parent IPC");
  await mkdir(dirname(path), { recursive: true });
  if (controlled)
    process.on("message", (message: unknown) => {
      const command = releaseCommand(message);
      if (command instanceof type.errors) return;
      gates.get(command.gateId)?.();
      gates.delete(command.gateId);
    });
  const app = await createMockFourcs({
    databasePath: path,
    ...(controlled ? { checkpoint: controlledCheckpoint } : {}),
  });
  const url = await app.listen({ host: "127.0.0.1", port });
  process.send?.({ kind: "ready", url });
  process.stdout.write(
    `${JSON.stringify({ event: "mock-fourcs-listening", url })}\n`,
  );
  const stop = async () => {
    for (const release of gates.values()) release();
    gates.clear();
    await app.close();
    process.disconnect?.();
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
} catch (cause) {
  const failure =
    cause instanceof Error && failureDetails.allows(cause.cause)
      ? cause.cause
      : safeFailure({ operation: "mock_start", cause });
  process.stderr.write(
    `${JSON.stringify({ event: "mock-fourcs-start-failed", failure })}\n`,
  );
  process.exitCode = 1;
}
