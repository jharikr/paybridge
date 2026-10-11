import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { rows } from "../provider/support.ts";
import { cancelled, startApi } from "./system.ts";

test.each(["failure", "exit", "startup"])(
  "an unexpected webhook thread %s stops the provider loop with a failed process",
  async (mode) => {
    await using files = await isolatedDatabases();
    const worker = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL("./fixtures/thread-failure.ts", import.meta.url),
      ),
      args: [
        files.paybridge,
        "http://127.0.0.1:3102",
        "300",
        "1000",
        "10",
        mode,
      ],
    });
    try {
      if (mode !== "startup") {
        expect(
          type({ kind: "string" }).assert(await worker.message()).kind,
        ).toBe("ready");
        worker.child.send({ kind: "fail" });
      }
      expect(await worker.message()).toEqual({ kind: "failed" });
      await expect.poll(() => worker.child.exitCode).toBe(1);
      expect(worker.output()).not.toMatch(/mock-webhook-secret/);
    } finally {
      await worker.stop();
    }
  },
);

test("SIGTERM stops both loops after a bounded in-flight webhook and preserves retry work", async () => {
  await using files = await isolatedDatabases();
  let received: (() => void) | undefined;
  const request = new Promise<void>((resolve) => {
    received = resolve;
  });
  const endpoint = createServer(() => received?.());
  await new Promise<void>((resolve) =>
    endpoint.listen(0, "127.0.0.1", resolve),
  );
  const { port } = type({ port: "number" }).assert(endpoint.address());
  const origin = `http://127.0.0.1:${port}`;
  const api = await startApi(files.paybridge, origin);
  let worker: ReturnType<typeof startNodeProcess> | undefined;
  try {
    await cancelled(api.url, origin);
    worker = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL("../../apps/paybridge/worker.ts", import.meta.url),
      ),
      args: [files.paybridge, "http://127.0.0.1:3102", "300", "2000", "10"],
    });
    await worker.message();
    await request;
    worker.child.kill("SIGTERM");
    const process = worker;
    await expect.poll(() => process.child.exitCode, { timeout: 1500 }).toBe(0);
    expect(
      rows(
        files.paybridge,
        "SELECT status,last_error,claim_token FROM webhook_outbox",
      ),
    ).toEqual([
      { status: "PENDING", last_error: "webhook_timeout", claim_token: null },
    ]);
  } finally {
    await worker?.stop();
    await api.stop();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});
