import { createServer } from "node:http";
import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { advance, cancelled, startApi, startDelivery } from "./system.ts";

test.each([
  { failure: "disconnect", code: "webhook_transport_failure" },
  { failure: "timeout", code: "webhook_timeout" },
  { failure: "redirect", code: "webhook_transport_failure" },
])(
  "$failure retains retry work and a later acknowledgment completes the original event",
  async ({ failure, code }) => {
    await using files = await isolatedDatabases();
    let calls = 0;
    let origin = "";
    const endpoint = createServer((request, response) => {
      calls++;
      request.resume();
      if (calls > 1) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (failure === "disconnect") response.destroy();
      if (failure === "redirect") {
        response.writeHead(302, { location: `${origin}/must-not-follow` });
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${type({ port: "number" }).assert(endpoint.address()).port}`;
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: origin,
    });
    let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
    try {
      await cancelled({ url: api.url, merchantOrigin: origin });
      const original = rows({
        path: files.paybridge,
        sql: "SELECT payment_event_id,payload FROM webhook_outbox",
      });
      worker = await startDelivery({
        path: files.paybridge,
        options: {
          timeout: 200,
          lease: 2000,
        },
      });
      await advance({ worker, epochMs: Date.now() + 1000 });
      await worker.start();
      await expect
        .poll(() =>
          rows({
            path: files.paybridge,
            sql: "SELECT status,last_error,attempt_count FROM webhook_outbox",
          }),
        )
        .toEqual([{ status: "PENDING", last_error: code, attempt_count: 1 }]);
      expect(calls).toBe(1);
      const due = type({ next_attempt_at: "string" }).assert(
        rows({
          path: files.paybridge,
          sql: "SELECT next_attempt_at FROM webhook_outbox",
        })[0],
      );
      await advance({ worker, epochMs: Date.parse(due.next_attempt_at) });
      await expect
        .poll(() =>
          rows({
            path: files.paybridge,
            sql: "SELECT status,attempt_count FROM webhook_outbox",
          }),
        )
        .toEqual([{ status: "DELIVERED", attempt_count: 2 }]);
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT payment_event_id,payload FROM webhook_outbox",
        }),
      ).toEqual(original);
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT status,revision FROM payment_intents",
        }),
      ).toEqual([{ status: "CANCELLED", revision: 2 }]);
    } finally {
      await worker?.stop();
      await api.stop();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  },
);

test("successful headers acknowledge delivery without waiting for an unbounded response body", async () => {
  await using files = await isolatedDatabases();
  const endpoint = createServer((request, response) => {
    request.resume();
    response.writeHead(200);
    response.flushHeaders();
    response.write("ignored body");
  });
  await new Promise<void>((resolve) =>
    endpoint.listen(0, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${type({ port: "number" }).assert(endpoint.address()).port}`;
  const api = await startApi({ path: files.paybridge, merchantOrigin: origin });
  let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
  try {
    await cancelled({ url: api.url, merchantOrigin: origin });
    worker = await startDelivery({
      path: files.paybridge,
      options: {
        timeout: 200,
        lease: 2000,
      },
    });
    await worker.start();
    await expect
      .poll(
        () =>
          rows({
            path: files.paybridge,
            sql: "SELECT status,last_error FROM webhook_outbox",
          }),
        { timeout: 1000 },
      )
      .toEqual([{ status: "DELIVERED", last_error: null }]);
  } finally {
    await worker?.stop();
    await api.stop();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});
