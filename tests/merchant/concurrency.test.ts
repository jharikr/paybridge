import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, rows } from "../provider/support.ts";
import {
  checkpoint,
  launchMerchant,
  orderBody,
  orderIdentity,
  post,
  verifyResponseHeaders,
} from "./support.ts";

test("two sample processes converge on one order, creation command, binding, and confirmation", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const first = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  const second = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const origins = [first.url, second.url];
    const orders = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const response = await post(
          origins[index % 2] ?? first.url,
          "/merchant-a/orders",
          orderBody,
        );
        expect([200, 201]).toContain(response.status);
        return orderIdentity.assert(await response.json());
      }),
    );
    expect(new Set(orders.map((order) => order.id)).size).toBe(1);
    const id = orders[0]?.id;
    const path = `/merchant-a/orders/${id}`;
    const creations = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const response = await post(
          origins[index % 2] ?? first.url,
          `${path}/payment`,
        );
        expect(response.status).toBe(201);
        return response.text();
      }),
    );
    expect(new Set(creations).size).toBe(1);
    const confirmations = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const response = await post(
          origins[index % 2] ?? first.url,
          `${path}/confirm`,
          {
            commandNumber: 1,
            mockPaymentMethodRef: "pm_mock_approved",
            expectedRevision: 1,
          },
        );
        expect(response.status).toBe(202);
        return response.text();
      }),
    );
    expect(new Set(confirmations).size).toBe(1);
    expect(rows(files.merchant, "SELECT id FROM orders")).toHaveLength(1);
    expect(
      rows(files.merchant, "SELECT payment_intent_id FROM merchant_payments"),
    ).toHaveLength(1);
    expect(
      rows(
        files.merchant,
        "SELECT operation, command_number, status FROM merchant_commands ORDER BY operation",
      ),
    ).toEqual([
      { operation: "confirm", command_number: 1, status: "COMPLETED" },
      { operation: "create", command_number: 1, status: "COMPLETED" },
    ]);
    expect(
      rows(files.paybridge, "SELECT id FROM payment_intents"),
    ).toHaveLength(1);
    expect(
      rows(files.paybridge, "SELECT id FROM payment_attempts"),
    ).toHaveLength(1);
  } finally {
    await first.stop();
    await second.stop();
  }
});

test(
  "local writer contention returns a bounded retry response and preserves the original command",
  { timeout: 15_000 },
  async () => {
    await using files = await isolatedDatabases();
    await using services = await journey(files);
    const first = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
      fault: "before-completion-commit",
    });
    const second = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.url,
    });
    try {
      const order = orderIdentity.assert(
        await (await post(first.url, "/merchant-a/orders", orderBody)).json(),
      );
      const path = `/merchant-a/orders/${order.id}/payment`;
      const pending = post(first.url, path).catch(() => null);
      const phase = checkpoint.assert(await first.message());
      expect(phase.kind).toBe("before-completion-commit");
      const started = performance.now();
      const contended = await post(second.url, path);
      expect(contended.status).toBe(503);
      expect(contended.headers.get("retry-after")).toBe("1");
      expect(performance.now() - started).toBeLessThan(8000);
      const document = type({
        paths: { "[string]": { "[string]": "unknown" } },
      }).assert(await (await fetch(`${second.url}/openapi.json`)).json());
      const operation = type({ responses: { "[string]": "unknown" } }).assert(
        document.paths["/{merchantFixture}/orders/{orderId}/payment"]?.["post"],
      );
      verifyResponseHeaders({
        documented: operation.responses["503"],
        response: contended,
        names: ["retry-after", "cache-control", "x-content-type-options"],
      });
      await first.stop();
      expect(await pending).toBeNull();
      const recovered = await post(second.url, path);
      expect(recovered.status).toBe(201);
      expect(recovered.headers.get("x-merchant-command-id")).toBe(
        phase.commandId,
      );
      expect(
        rows(files.paybridge, "SELECT id FROM payment_intents"),
      ).toHaveLength(1);
      expect(rows(files.merchant, "SELECT id FROM merchant_commands")).toEqual([
        { id: phase.commandId },
      ]);
    } finally {
      await first.stop();
      await second.stop();
    }
  },
);

test("a prepared confirmation must be recovered before a new command number is accepted", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const setup = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  let path: string;
  try {
    const order = orderIdentity.assert(
      await (await post(setup.url, "/merchant-a/orders", orderBody)).json(),
    );
    path = `/merchant-a/orders/${order.id}`;
    expect(
      (
        await post(setup.url, `${path}/confirm`, {
          commandNumber: 1,
          expectedRevision: 1,
          mockPaymentMethodRef: "pm_mock_approved",
        })
      ).status,
    ).toBe(409);
    expect((await post(setup.url, `${path}/payment`)).status).toBe(201);
  } finally {
    await setup.stop();
  }
  const first = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
    fault: "prepared",
  });
  const second = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const pending = post(first.url, `${path}/confirm`, {
      commandNumber: 1,
      expectedRevision: 1,
      mockPaymentMethodRef: "pm_mock_approved",
    }).catch(() => null);
    const phase = checkpoint.assert(await first.message());
    const rejected = await post(second.url, `${path}/confirm`, {
      commandNumber: 2,
      expectedRevision: 1,
      mockPaymentMethodRef: "pm_mock_approved",
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: "command_recovery_required" },
    });
    expect(rows(files.paybridge, "SELECT id FROM payment_attempts")).toEqual(
      [],
    );
    await first.stop();
    expect(await pending).toBeNull();
    expect(
      (await post(second.url, `${path}/commands/${phase.commandId}/recover`))
        .status,
    ).toBe(202);
    expect(
      rows(files.paybridge, "SELECT id FROM payment_attempts"),
    ).toHaveLength(1);
  } finally {
    await first.stop();
    await second.stop();
  }
});
