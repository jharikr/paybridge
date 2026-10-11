import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, lookup, rows } from "../provider/support.ts";
import { launchMerchant, post } from "../merchant/support.ts";
import {
  command,
  inspect,
  resolutionInput,
} from "../reconciliation/support.ts";
import {
  boundOrder,
  controlledInbox,
  deliver,
  events,
  merchantRecords,
  startInbox,
} from "./support.ts";

for (const original of ["FAILED", "UNKNOWN"]) {
  test(`a delayed ${original} receipt completes after newer success without undoing concurrent lookup or repeating the paid effect`, async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    let oldWorker: Awaited<ReturnType<typeof controlledInbox>> | undefined;
    let newWorker: Awaited<ReturnType<typeof startInbox>> | undefined;
    try {
      const { payment, path } = await boundOrder(merchant.url);
      await post(merchant.url, `${path}/confirm`, {
        commandNumber: 1,
        expectedRevision: 1,
        mockPaymentMethodRef:
          original === "FAILED" ? "pm_mock_declined" : "pm_mock_lost_response",
      });
      const provider = await services.startWorker();
      await expect
        .poll(async () => (await lookup(services.url, payment.id)).status)
        .toBe(original);
      await provider.stop();
      const [older] = events(files.paybridge);
      if (!older) throw new Error("Expected original event");
      if (original === "FAILED") {
        expect((await deliver(merchant.url, older.payload)).status).toBe(204);
        oldWorker = await controlledInbox(files.merchant, "after-inbox-claim", {
          lease: 10000,
        });
        await oldWorker.start();
        expect(await oldWorker.message()).toEqual({
          kind: "after-inbox-claim",
          eventId: older.payment_event_id,
        });
        expect(
          await (await fetch(`${merchant.url}${path}/payment`)).json(),
        ).toMatchObject({ status: "FAILED", revision: 3 });
        expect(
          (
            await post(merchant.url, `${path}/confirm`, {
              commandNumber: 2,
              expectedRevision: 3,
              mockPaymentMethodRef: "pm_mock_approved",
            })
          ).status,
        ).toBe(202);
        expect(
          await (await fetch(`${merchant.url}${path}/payment`)).json(),
        ).toMatchObject({ status: "PROCESSING", revision: 4 });
        expect(
          rows(
            files.merchant,
            "SELECT status,last_applied_revision FROM merchant_payments",
          ),
        ).toEqual([{ status: "PROCESSING", last_applied_revision: 4 }]);
        await services.startWorker();
      } else {
        const identity = type({
          id: "string",
          provider_account_ref: "string",
          provider_transaction_id: "string",
        }).assert(
          rows(
            files.paybridge,
            "SELECT r.id,a.provider_account_ref,a.provider_transaction_id FROM reconciliations r JOIN payment_attempts a ON a.id=r.payment_attempt_id",
          )[0],
        );
        const evidence = await inspect(
          files.mockFourcs,
          identity.provider_account_ref,
          identity.provider_transaction_id,
        );
        expect(
          (
            await command({
              path: files.paybridge,
              directory: files.directory,
              input: resolutionInput(identity.id, evidence),
            })
          ).code,
        ).toBe(0);
      }
      await expect
        .poll(async () => (await lookup(services.url, payment.id)).status)
        .toBe("SUCCEEDED");
      const newer = events(files.paybridge).find(
        (event) => event.event_type === "payment.succeeded",
      );
      if (!newer) throw new Error("Expected success event");
      expect((await deliver(merchant.url, newer.payload)).status).toBe(204);
      newWorker = await startInbox(files.merchant);
      const racing = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          fetch(
            `${merchant.url}${index % 2 ? `${path}/payment` : `/merchant-a/payment-return?paymentId=${payment.id}`}`,
          ),
        ),
      );
      expect(racing.map((response) => response.status)).toEqual(
        Array(12).fill(200),
      );
      await expect
        .poll(() =>
          rows(
            files.merchant,
            `SELECT status FROM webhook_inbox WHERE event_id='${newer.payment_event_id}'`,
          ),
        )
        .toEqual([{ status: "PROCESSED" }]);
      const applied = merchantRecords(files.merchant);
      expect(applied.orders).toMatchObject([
        { state: "PAID", paid_at: expect.any(String) },
      ]);
      expect(applied.payments).toMatchObject([
        {
          status: "SUCCEEDED",
          last_applied_revision: original === "FAILED" ? 5 : 4,
        },
      ]);
      if (oldWorker) oldWorker.child.send({ kind: "release" });
      else
        expect((await deliver(merchant.url, older.payload)).status).toBe(204);
      await expect
        .poll(() => rows(files.merchant, "SELECT status FROM webhook_inbox"))
        .toEqual([{ status: "PROCESSED" }, { status: "PROCESSED" }]);
      expect(merchantRecords(files.merchant).orders).toEqual(applied.orders);
      expect(merchantRecords(files.merchant).payments).toEqual(
        applied.payments,
      );
      const completed = merchantRecords(files.merchant);
      const duplicates = await Promise.all(
        [older, newer, newer, older].map((event) =>
          deliver(merchant.url, event.payload),
        ),
      );
      expect(duplicates.map((response) => response.status)).toEqual(
        Array(4).fill(204),
      );
      expect(merchantRecords(files.merchant)).toEqual(completed);
      expect(
        rows(
          files.mockFourcs,
          "SELECT sum(effect_count) AS count FROM mock_transactions",
        ),
      ).toEqual([{ count: 1 }]);
    } finally {
      await oldWorker?.stop();
      await newWorker?.stop();
      await merchant.stop();
    }
  });
}
