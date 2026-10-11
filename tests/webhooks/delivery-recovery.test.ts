import { expect, test } from "vitest";
import { createServer } from "node:http";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { launchMerchant } from "../merchant/support.ts";
import { rows } from "../provider/support.ts";
import { cancelled, startApi, startDelivery } from "./system.ts";

test.each([
  "after-webhook-claim",
  "after-webhook-response",
  "before-webhook-completion-commit",
])(
  "delivery recovers the original event after a real SIGKILL %s",
  async (held) => {
    await using files = await isolatedDatabases();
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: "http://127.0.0.1:3100",
    });
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: merchant.url,
    });
    let first: Awaited<ReturnType<typeof startDelivery>> | undefined;
    let second: Awaited<ReturnType<typeof startDelivery>> | undefined;
    try {
      await cancelled({ url: api.url, merchantOrigin: merchant.url });
      const original = rows({
        path: files.paybridge,
        sql: "SELECT payment_event_id,payload FROM webhook_outbox",
      });
      first = await startDelivery({ path: files.paybridge, options: { held } });
      await first.start();
      expect(type({ kind: "string" }).assert(await first.message()).kind).toBe(
        held,
      );
      const claim = type({ lease_expires_at: "string" }).assert(
        rows({
          path: files.paybridge,
          sql: "SELECT lease_expires_at FROM webhook_outbox",
        })[0],
      );
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT event_id FROM webhook_inbox",
        }),
      ).toHaveLength(held === "after-webhook-claim" ? 0 : 1);
      await first.stop();
      second = await startDelivery({ path: files.paybridge });
      second.child.send({
        kind: "advance",
        epochMs: Date.parse(claim.lease_expires_at) + 1,
      });
      expect(await second.message()).toEqual({ kind: "advanced" });
      await second.start();
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
          path: files.merchant,
          sql: "SELECT payload,status FROM webhook_inbox",
        }),
      ).toEqual([{ payload: original[0]?.payload, status: "PENDING" }]);
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT status,revision FROM payment_intents",
        }),
      ).toEqual([{ status: "CANCELLED", revision: 2 }]);
    } finally {
      await first?.stop();
      await second?.stop();
      await api.stop();
      await merchant.stop();
    }
  },
);

test.each(["success", "failure"])(
  "a stale %s cannot alter another sender's unexpired claim",
  async (outcome) => {
    await using files = await isolatedDatabases();
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: "http://127.0.0.1:3100",
    });
    let requests = 0;
    const endpoint = createServer((_request, response) => {
      response.writeHead(++requests === 1 ? 503 : 204).end();
    });
    await new Promise<void>((resolve) =>
      endpoint.listen(0, "127.0.0.1", resolve),
    );
    const { port } = type({ port: "number" }).assert(endpoint.address());
    const origin =
      outcome === "success" ? merchant.url : `http://127.0.0.1:${port}`;
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: origin,
    });
    let a: Awaited<ReturnType<typeof startDelivery>> | undefined;
    let b: Awaited<ReturnType<typeof startDelivery>> | undefined;
    try {
      await cancelled({ url: api.url, merchantOrigin: origin });
      a = await startDelivery({
        path: files.paybridge,
        options: {
          held: "after-webhook-response",
        },
      });
      await a.start();
      await a.message();
      const old = type({
        lease_expires_at: "string",
        claim_token: "string",
      }).assert(
        rows({
          path: files.paybridge,
          sql: "SELECT lease_expires_at,claim_token FROM webhook_outbox",
        })[0],
      );
      b = await startDelivery({
        path: files.paybridge,
        options: {
          held: "after-webhook-response",
        },
      });
      b.child.send({
        kind: "advance",
        epochMs: Date.parse(old.lease_expires_at) + 1,
      });
      await b.message();
      await b.start();
      await b.message();
      const current = rows({
        path: files.paybridge,
        sql: "SELECT status,claim_token,locked_by,lease_expires_at,attempt_count FROM webhook_outbox",
      });
      expect(current[0]?.status).toBe("PROCESSING");
      expect(current[0]?.claim_token).not.toBe(old.claim_token);
      a.child.send({ kind: "release" });
      expect(await a.message()).toEqual({ kind: "released" });
      expect(type({ code: "string" }).assert(await a.message()).code).toBe(
        "webhook_stale_completion",
      );
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT status,claim_token,locked_by,lease_expires_at,attempt_count FROM webhook_outbox",
        }),
      ).toEqual(current);
      b.child.send({ kind: "release" });
      await b.message();
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
          path: files.merchant,
          sql: "SELECT event_id FROM webhook_inbox",
        }),
      ).toHaveLength(outcome === "success" ? 1 : 0);
    } finally {
      await a?.stop();
      await b?.stop();
      await api.stop();
      await merchant.stop();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  },
);
