import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { rows } from "../provider/support.ts";
import { advance, cancelled, startApi, startDelivery } from "./system.ts";

test.each([200, 202, 204, 299])(
  "HTTP %i completes delivery after capped retries with fresh signatures over the original bytes",
  async (status) => {
    await using files = await isolatedDatabases();
    const attempts: {
      body: string;
      timestamp: string;
      signature: string;
      eventId: string;
    }[] = [];
    const endpoint = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      attempts.push({
        body: Buffer.concat(chunks).toString("utf8"),
        timestamp: type("string").assert(req.headers["paybridge-timestamp"]),
        signature: type("string").assert(req.headers["paybridge-signature"]),
        eventId: type("string").assert(req.headers["paybridge-event-id"]),
      });
      res.writeHead(attempts.length < 4 ? 503 : status);
      res.end();
    });
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    );
    const { port } = type({ port: "number" }).assert(endpoint.address());
    const origin = `http://127.0.0.1:${port}`;
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: origin,
    });
    let worker: Awaited<ReturnType<typeof startDelivery>> | undefined;
    try {
      await cancelled({ url: api.url, merchantOrigin: origin });
      const original = type({
        payment_event_id: "string",
        payload: "string",
      }).assert(
        rows({
          path: files.paybridge,
          sql: "SELECT payment_event_id,payload FROM webhook_outbox",
        })[0],
      );
      const clock = Math.ceil(Date.now() / 1000) * 1000;
      worker = await startDelivery({
        path: files.paybridge,
        options: { base: 2000, cap: 3000 },
      });
      await advance({ worker, epochMs: clock });
      await worker.start();
      for (const [index, increment] of [2000, 5000, 8000].entries()) {
        await expect
          .poll(() =>
            rows({
              path: files.paybridge,
              sql: "SELECT status,attempt_count,last_error FROM webhook_outbox",
            }),
          )
          .toEqual([
            {
              status: "PENDING",
              attempt_count: index + 1,
              last_error: "webhook_http_503",
            },
          ]);
        const due = type({ next_attempt_at: "string" }).assert(
          rows({
            path: files.paybridge,
            sql: "SELECT next_attempt_at FROM webhook_outbox",
          })[0],
        );
        const expected = clock + increment;
        expect(Date.parse(due.next_attempt_at)).toBe(expected);
        await advance({ worker, epochMs: expected });
      }
      await expect
        .poll(() =>
          rows({
            path: files.paybridge,
            sql: "SELECT status,attempt_count,claim_token,last_error FROM webhook_outbox",
          }),
        )
        .toEqual([
          {
            status: "DELIVERED",
            attempt_count: 4,
            claim_token: null,
            last_error: null,
          },
        ]);
      expect(attempts).toHaveLength(4);
      expect(new Set(attempts.map((attempt) => attempt.timestamp)).size).toBe(
        4,
      );
      for (const attempt of attempts) {
        expect(attempt.body).toBe(original.payload);
        expect(attempt.eventId).toBe(original.payment_event_id);
        expect(attempt.signature).toBe(
          `v1=${createHmac("sha256", "mock-webhook-secret-a")
            .update(attempt.timestamp + "." + original.payload)
            .digest("hex")}`,
        );
      }
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
