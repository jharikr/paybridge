import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { launchMerchant } from "../merchant/support.ts";
import { rows } from "../provider/support.ts";
import { ready } from "./support.ts";
import { cancelled, startApi } from "./system.ts";

test(
  "a merchant outage and real worker restart preserve four financial outcomes while delivery resumes",
  { timeout: 15000 },
  async () => {
    await using files = await isolatedDatabases();
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: "http://127.0.0.1:3100",
    });
    const origin = merchant.url;
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: origin,
    });
    const mock = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL("../../apps/mock-fourcs/main.ts", import.meta.url),
      ),
      args: [files.mockFourcs, "0"],
    });
    let worker: ReturnType<typeof startNodeProcess> | undefined;
    let restored: ReturnType<typeof startNodeProcess> | undefined;
    try {
      const mockUrl = ready.assert(await mock.message()).url;
      await cancelled({ url: api.url, merchantOrigin: origin });
      for (const fixture of [
        "pm_mock_approved",
        "pm_mock_declined",
        "pm_mock_lost_response",
      ]) {
        const created = await fetch(`${api.url}/v1/payment-intents`, {
          method: "POST",
          headers: {
            authorization: "Bearer mock-paybridge-key-a",
            "content-type": "application/json",
            "idempotency-key": fixture,
          },
          body: JSON.stringify({
            merchantReference: fixture,
            amount: 7500,
            currency: "XCD",
            returnUrl: `${origin}/payment-return`,
          }),
        });
        expect(created.status).toBe(201);
        const { id } = type({ id: "string" }).assert(await created.json());
        expect(
          (
            await fetch(`${api.url}/v1/payment-intents/${id}/confirm`, {
              method: "POST",
              headers: {
                authorization: "Bearer mock-paybridge-key-a",
                "content-type": "application/json",
                "idempotency-key": `confirm-${fixture}`,
              },
              body: JSON.stringify({
                mockPaymentMethodRef: fixture,
                expectedRevision: 1,
              }),
            })
          ).status,
        ).toBe(202);
      }
      await merchant.stop();
      const startWorker = () =>
        startNodeProcess({
          entrypoint: fileURLToPath(
            new URL("../../apps/paybridge/worker.ts", import.meta.url),
          ),
          args: [files.paybridge, mockUrl, "500", "3000", "10", "50", "200"],
        });
      worker = startWorker();
      await worker.message();
      await expect
        .poll(
          () =>
            rows({
              path: files.paybridge,
              sql: "SELECT status,revision FROM payment_intents ORDER BY status",
            }),
          { timeout: 3000 },
        )
        .toEqual([
          { status: "CANCELLED", revision: 2 },
          { status: "FAILED", revision: 3 },
          { status: "SUCCEEDED", revision: 3 },
          { status: "UNKNOWN", revision: 3 },
        ]);
      await expect
        .poll(
          () =>
            rows({
              path: files.paybridge,
              sql: "SELECT count(*) AS count FROM webhook_outbox WHERE attempt_count>0",
            })[0]?.count,
        )
        .toBe(4);
      const paymentFacts = rows({
        path: files.paybridge,
        sql: "SELECT * FROM payment_intents ORDER BY id",
      });
      const attemptFacts = rows({
        path: files.paybridge,
        sql: "SELECT * FROM payment_attempts ORDER BY id",
      });
      const eventFacts = rows({
        path: files.paybridge,
        sql: "SELECT * FROM payment_events ORDER BY id",
      });
      const providerFacts = rows({
        path: files.mockFourcs,
        sql: "SELECT * FROM mock_transactions ORDER BY id",
      });
      const notifications = rows({
        path: files.paybridge,
        sql: "SELECT payment_event_id,event_type,payload,merchant_id FROM webhook_outbox ORDER BY event_type",
      });
      expect(notifications.map((record) => record.event_type)).toEqual([
        "payment.cancelled",
        "payment.failed",
        "payment.succeeded",
        "payment.unknown",
      ]);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT event_id FROM webhook_inbox",
        }),
      ).toEqual([]);
      await worker.stop();
      restored = startNodeProcess({
        entrypoint: fileURLToPath(
          new URL("../../apps/merchant/server.ts", import.meta.url),
        ),
        args: [files.merchant, new URL(origin).port, api.url],
      });
      expect(ready.assert(await restored.message()).url).toBe(origin);
      worker = startWorker();
      await worker.message();
      await expect
        .poll(
          () =>
            rows({
              path: files.paybridge,
              sql: "SELECT status FROM webhook_outbox",
            }),
          { timeout: 7000 },
        )
        .toEqual(Array(4).fill({ status: "DELIVERED" }));
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT event_id AS payment_event_id,event_type,payload,receiving_merchant_id AS merchant_id FROM webhook_inbox ORDER BY event_type",
        }),
      ).toEqual(notifications);
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT status,attempt_count FROM webhook_inbox",
        }),
      ).toEqual(Array(4).fill({ status: "PENDING", attempt_count: 0 }));
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT * FROM payment_intents ORDER BY id",
        }),
      ).toEqual(paymentFacts);
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT * FROM payment_attempts ORDER BY id",
        }),
      ).toEqual(attemptFacts);
      expect(
        rows({
          path: files.paybridge,
          sql: "SELECT * FROM payment_events ORDER BY id",
        }),
      ).toEqual(eventFacts);
      expect(
        rows({
          path: files.mockFourcs,
          sql: "SELECT * FROM mock_transactions ORDER BY id",
        }),
      ).toEqual(providerFacts);
      expect(worker.output()).not.toMatch(
        /mock-webhook-secret|mock-paybridge-key|v1=[a-f0-9]{64}/,
      );
    } finally {
      await worker?.stop();
      await restored?.stop();
      await merchant.stop();
      await api.stop();
      await mock.stop();
    }
  },
);
