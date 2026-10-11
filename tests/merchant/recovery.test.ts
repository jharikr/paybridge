import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { startNodeProcess } from "../support/process.ts";
import { isolatedDatabases } from "../support/databases.ts";
import { contractAt, compareResponse } from "../contracts/support.ts";
import { journey, rows } from "../provider/support.ts";
import {
  checkpoint,
  commandList,
  launchMerchant,
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
  ready,
} from "./support.ts";

test("a killed caller recovers the prepared creation key and request without a replacement intent", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const first = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
    fault: "prepared",
  });
  let id: string;
  let commandId: string;
  let requestBody: unknown;
  try {
    id = orderIdentity.assert(
      await (await post(first.url, "/merchant-a/orders", orderBody)).json(),
    ).id;
    const pending = post(first.url, `/merchant-a/orders/${id}/payment`).catch(
      () => null,
    );
    commandId = checkpoint.assert(await first.message()).commandId;
    const prepared = rows(
      files.merchant,
      "SELECT id, idempotency_key, status, request_body, target FROM merchant_commands",
    );
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      id: commandId,
      idempotency_key: commandId,
      status: "PREPARED",
      target: "/v1/payment-intents",
    });
    requestBody = prepared[0]?.request_body;
    expect(rows(files.paybridge, "SELECT id FROM payment_intents")).toEqual([]);
    await first.stop();
    expect(await pending).toBeNull();
  } finally {
    await first.stop();
  }
  const restarted = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const commands = await fetch(
      `${restarted.url}/merchant-a/orders/${id}/commands`,
    );
    expect(commands.status).toBe(200);
    expect(commandList.assert(await commands.json()).commands).toEqual([
      {
        id: commandId,
        operation: "create",
        commandNumber: 1,
        status: "PREPARED",
      },
    ]);
    const recovered = await post(
      restarted.url,
      `/merchant-a/orders/${id}/commands/${commandId}/recover`,
    );
    expect(recovered.status).toBe(201);
    const payment = paymentIdentity.assert(await recovered.json());
    expect(rows(files.paybridge, "SELECT id FROM payment_intents")).toEqual([
      { id: payment.id },
    ]);
    expect(
      rows(
        files.merchant,
        "SELECT id, idempotency_key, status, request_body FROM merchant_commands",
      ),
    ).toEqual([
      {
        id: commandId,
        idempotency_key: commandId,
        status: "COMPLETED",
        request_body: requestBody,
      },
    ]);
  } finally {
    await restarted.stop();
  }
});

for (const operation of ["create", "confirm"]) {
  for (const fault of ["prepared", "received", "before-completion-commit"]) {
    test(`${operation} survives SIGKILL at ${fault} with the original request, key, and exact remote acknowledgment`, async () => {
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
        if (operation === "confirm")
          expect((await post(setup.url, `${path}/payment`)).status).toBe(201);
      } finally {
        await setup.stop();
      }
      const first = await launchMerchant({
        path: files.merchant,
        paybridgeUrl: services.url,
        fault,
      });
      let commandId: string;
      let prepared: ReturnType<typeof rows>;
      try {
        const pending = post(
          first.url,
          `${path}/${operation === "create" ? "payment" : "confirm"}`,
          operation === "create"
            ? undefined
            : {
                commandNumber: 1,
                mockPaymentMethodRef: "pm_mock_declined",
                expectedRevision: 1,
              },
        ).catch(() => null);
        const phase = checkpoint.assert(await first.message());
        expect(phase.kind).toBe(fault);
        commandId = phase.commandId;
        prepared = rows(
          files.merchant,
          `SELECT id, idempotency_key, target, request_body FROM merchant_commands WHERE operation = '${operation}'`,
        );
        expect(prepared).toHaveLength(1);
        expect(
          rows(
            files.merchant,
            `SELECT status, response_body FROM merchant_commands WHERE operation = '${operation}'`,
          ),
        ).toEqual([{ status: "PREPARED", response_body: null }]);
        if (operation === "create")
          expect(
            rows(
              files.merchant,
              "SELECT payment_intent_id FROM merchant_payments",
            ),
          ).toEqual([]);
        expect(
          rows(
            files.paybridge,
            operation === "create"
              ? "SELECT id FROM payment_intents"
              : "SELECT id FROM payment_attempts",
          ),
        ).toHaveLength(fault === "prepared" ? 0 : 1);
        if (operation === "confirm" && fault !== "prepared") {
          await services.startWorker();
          await expect
            .poll(
              () =>
                rows(files.paybridge, "SELECT status FROM payment_intents")[0]
                  ?.status,
            )
            .toBe("FAILED");
        }
        await first.stop();
        expect(await pending).toBeNull();
      } finally {
        await first.stop();
      }
      const restarted = await launchMerchant({
        path: files.merchant,
        paybridgeUrl: services.url,
      });
      try {
        const recovered = await post(
          restarted.url,
          `${path}/commands/${commandId}/recover`,
        );
        expect(recovered.status).toBe(operation === "create" ? 201 : 202);
        const actual = await recovered.text();
        const remote = rows(
          files.paybridge,
          `SELECT response_body, response_headers FROM idempotency_keys WHERE key = '${commandId}'`,
        )[0];
        expect(actual).toBe(remote?.response_body);
        const remoteHeaders = type({ location: "string" }).assert(
          JSON.parse(String(remote?.response_headers)),
        );
        expect(recovered.headers.get("location")).toBe(remoteHeaders.location);
        expect(
          rows(
            files.merchant,
            `SELECT id, idempotency_key, target, request_body FROM merchant_commands WHERE operation = '${operation}'`,
          ),
        ).toEqual(prepared);
        expect(
          rows(
            files.merchant,
            `SELECT status, response_body FROM merchant_commands WHERE operation = '${operation}'`,
          ),
        ).toEqual([{ status: "COMPLETED", response_body: actual }]);
        expect(
          rows(files.merchant, "SELECT state, paid_at FROM orders"),
        ).toEqual([{ state: "UNPAID", paid_at: null }]);
        expect(
          rows(files.paybridge, "SELECT id FROM payment_intents"),
        ).toHaveLength(1);
        if (operation === "confirm")
          expect(
            rows(files.paybridge, "SELECT id FROM payment_attempts"),
          ).toHaveLength(1);
        expect(restarted.output()).not.toMatch(
          /mock-paybridge-key|checkout\/.+token=/,
        );
      } finally {
        await restarted.stop();
      }
    });
  }
}

test.each(["create", "confirm"])(
  "a lost %s response after remote commit replays exactly after both caller and API restart",
  async (operation) => {
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
      if (operation === "confirm")
        expect((await post(setup.url, `${path}/payment`)).status).toBe(201);
    } finally {
      await setup.stop();
    }
    const remote = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL(
          operation === "create"
            ? "../payments/fixtures/server.ts"
            : "../payments/fixtures/command-server.ts",
          import.meta.url,
        ),
      ),
      args:
        operation === "create"
          ? [files.paybridge, "after-commit"]
          : [files.paybridge, "confirm", "after-commit"],
    });
    const remoteUrl = ready.assert(await remote.message()).url;
    const first = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: remoteUrl,
    });
    let commandId: string;
    let original: string;
    try {
      const pending = post(
        first.url,
        `${path}/${operation === "create" ? "payment" : "confirm"}`,
        operation === "create"
          ? undefined
          : {
              commandNumber: 1,
              mockPaymentMethodRef: "pm_mock_approved",
              expectedRevision: 1,
            },
      ).catch(() => null);
      expect(await remote.message()).toEqual({ kind: "after-commit" });
      const command = type({ id: "string", status: "string" }).assert(
        rows(
          files.merchant,
          `SELECT id, status FROM merchant_commands WHERE operation = '${operation}'`,
        )[0],
      );
      commandId = command.id;
      expect(command.status).toBe("PREPARED");
      original = type({ response_body: "string" }).assert(
        rows(
          files.paybridge,
          `SELECT response_body FROM idempotency_keys WHERE key = '${commandId}'`,
        )[0],
      ).response_body;
      await first.stop();
      expect(await pending).toBeNull();
      await remote.stop();
      await services.server.stop();
    } finally {
      await first.stop();
      await remote.stop();
    }
    const restartedApi = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL("../../apps/paybridge/server.ts", import.meta.url),
      ),
      args: [files.paybridge, "0"],
    });
    const apiUrl = ready.assert(await restartedApi.message()).url;
    const restarted = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: apiUrl,
    });
    try {
      const response = await post(
        restarted.url,
        `${path}/commands/${commandId}/recover`,
      );
      expect(response.status).toBe(operation === "create" ? 201 : 202);
      expect(await response.text()).toBe(original);
      expect(
        rows(files.paybridge, "SELECT id FROM payment_intents"),
      ).toHaveLength(1);
      expect(
        rows(files.paybridge, "SELECT id FROM payment_attempts"),
      ).toHaveLength(operation === "confirm" ? 1 : 0);
      expect(
        rows(files.merchant, "SELECT payment_intent_id FROM merchant_payments"),
      ).toHaveLength(1);
    } finally {
      await restarted.stop();
      await restartedApi.stop();
    }
  },
);

test("local completion rollback retains a recoverable command and never commits a partial binding", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const first = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
    fault: "rollback",
  });
  let id: string;
  try {
    id = orderIdentity.assert(
      await (await post(first.url, "/merchant-a/orders", orderBody)).json(),
    ).id;
    const failed = await post(first.url, `/merchant-a/orders/${id}/payment`);
    expect(failed.status).toBe(500);
    await compareResponse({
      contract: await contractAt(first.url),
      path: "/{merchantFixture}/orders/{orderId}/payment",
      method: "post",
      response: failed,
      status: 500,
    });
    expect(
      rows(
        files.merchant,
        "SELECT status, response_body FROM merchant_commands",
      ),
    ).toEqual([{ status: "PREPARED", response_body: null }]);
    expect(
      rows(files.merchant, "SELECT payment_intent_id FROM merchant_payments"),
    ).toEqual([]);
    expect(
      rows(files.paybridge, "SELECT id FROM payment_intents"),
    ).toHaveLength(1);
  } finally {
    await first.stop();
  }
  const restarted = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const recovered = await post(
      restarted.url,
      `/merchant-a/orders/${id}/payment`,
    );
    expect(recovered.status).toBe(201);
    const payment = paymentIdentity.assert(await recovered.json());
    expect(
      rows(files.merchant, "SELECT payment_intent_id FROM merchant_payments"),
    ).toEqual([{ payment_intent_id: payment.id }]);
    expect(rows(files.paybridge, "SELECT id FROM payment_intents")).toEqual([
      { id: payment.id },
    ]);
  } finally {
    await restarted.stop();
  }
});
