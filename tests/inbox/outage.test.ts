import { once } from "node:events";
import { createServer } from "node:net";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { merchantEntry, post } from "../merchant/support.ts";
import {
  mockEntry,
  ready,
  rows,
  workerEntry,
  workerReady,
} from "../provider/support.ts";
import { startApi } from "../webhooks/system.ts";
import { boundOrder, startInbox } from "./support.ts";

test(
  "provider completion during receiver outage converges through durable delivery and inbox application after real process restarts",
  { timeout: 15000 },
  async () => {
    await using files = await isolatedDatabases();
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const { port } = type({ port: "number" }).assert(reservation.address());
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const origin = `http://127.0.0.1:${port}`;
    const api = await startApi({
      path: files.paybridge,
      merchantOrigin: origin,
    });
    const mock = startNodeProcess({
      entrypoint: mockEntry,
      args: [files.mockFourcs, "0"],
    });
    const startMerchant = () =>
      startNodeProcess({
        entrypoint: merchantEntry,
        args: [files.merchant, String(port), api.url, origin],
      });
    let merchant = startMerchant();
    let worker: ReturnType<typeof startNodeProcess> | undefined;
    let inbox: Awaited<ReturnType<typeof startInbox>> | undefined;
    try {
      expect(ready.assert(await merchant.message()).url).toBe(origin);
      const mockUrl = ready.assert(await mock.message()).url;
      const orders: { path: string; paid: boolean }[] = [];
      for (const fixture of [
        "cancel",
        "pm_mock_approved",
        "pm_mock_declined",
        "pm_mock_lost_response",
      ]) {
        const { payment, path } = await boundOrder({
          url: origin,
          merchant: "a",
          reference: fixture,
        });
        orders.push({ path, paid: fixture === "pm_mock_approved" });
        if (fixture === "cancel") {
          expect(
            (
              await fetch(
                `${api.url}/v1/payment-intents/${payment.id}/cancel`,
                {
                  method: "POST",
                  headers: { authorization: "Bearer mock-paybridge-key-a" },
                },
              )
            ).status,
          ).toBe(200);
        } else {
          expect(
            (
              await post({
                url: origin,
                path: `${path}/confirm`,
                body: {
                  commandNumber: 1,
                  expectedRevision: 1,
                  mockPaymentMethodRef: fixture,
                },
              })
            ).status,
          ).toBe(202);
        }
      }
      await merchant.stop();
      const startWorker = () =>
        startNodeProcess({
          entrypoint: workerEntry,
          args: [files.paybridge, mockUrl, "500", "3000", "10", "50", "200"],
        });
      worker = startWorker();
      workerReady.assert(await worker.message());
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
      const financialFacts = () => ({
        intents: rows({
          path: files.paybridge,
          sql: "SELECT * FROM payment_intents ORDER BY id",
        }),
        attempts: rows({
          path: files.paybridge,
          sql: "SELECT * FROM payment_attempts ORDER BY id",
        }),
        events: rows({
          path: files.paybridge,
          sql: "SELECT * FROM payment_events ORDER BY id",
        }),
        ledger: rows({
          path: files.mockFourcs,
          sql: "SELECT * FROM mock_transactions ORDER BY id",
        }),
      });
      const completed = financialFacts();
      const notifications = rows({
        path: files.paybridge,
        sql: "SELECT payment_event_id,event_type,payload,merchant_id FROM webhook_outbox ORDER BY event_type",
      });
      expect(
        rows({
          path: files.merchant,
          sql: "SELECT event_id FROM webhook_inbox",
        }),
      ).toEqual([]);
      expect(
        rows({ path: files.merchant, sql: "SELECT state FROM orders" }),
      ).toEqual(Array(4).fill({ state: "UNPAID" }));
      await worker.stop();
      merchant = startMerchant();
      expect(ready.assert(await merchant.message()).url).toBe(origin);
      worker = startWorker();
      workerReady.assert(await worker.message());
      inbox = await startInbox(files.merchant);
      await expect
        .poll(
          () =>
            rows({
              path: files.merchant,
              sql: "SELECT status FROM webhook_inbox",
            }),
          {
            timeout: 7000,
          },
        )
        .toEqual(Array(4).fill({ status: "PROCESSED" }));
      await expect
        .poll(() =>
          rows({
            path: files.paybridge,
            sql: "SELECT status FROM webhook_outbox",
          }),
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
          sql: "SELECT status,last_applied_revision FROM merchant_payments ORDER BY status",
        }),
      ).toEqual([
        { status: "CANCELLED", last_applied_revision: 2 },
        { status: "FAILED", last_applied_revision: 3 },
        { status: "SUCCEEDED", last_applied_revision: 3 },
        { status: "UNKNOWN", last_applied_revision: 3 },
      ]);
      for (const order of orders) {
        // The local order route cannot fetch or apply a Paybridge snapshot.
        expect(
          await (await fetch(`${origin}${order.path}`)).json(),
        ).toMatchObject({
          state: order.paid ? "PAID" : "UNPAID",
          paidAt: order.paid ? expect.any(String) : null,
        });
      }
      expect(financialFacts()).toEqual(completed);
      expect(
        rows({
          path: files.mockFourcs,
          sql: "SELECT sum(effect_count) AS count FROM mock_transactions",
        }),
      ).toEqual([{ count: 2 }]);
      expect(inbox.output() + worker.output()).not.toMatch(
        /mock-webhook-secret|mock-paybridge-key|v1=[a-f0-9]{64}/,
      );
    } finally {
      await inbox?.stop();
      await worker?.stop();
      await merchant.stop();
      await api.stop();
      await mock.stop();
    }
  },
);
