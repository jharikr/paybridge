import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, rows } from "../provider/support.ts";
import {
  launchMerchant,
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
} from "../merchant/support.ts";
import { contractAt, compareResponse, compareParameters } from "./support.ts";

const ordersPath = "/{merchantFixture}/orders";
const orderPath = `${ordersPath}/{orderId}`;
const paymentPath = `${orderPath}/payment`;
const confirmPath = `${orderPath}/confirm`;
const commandsPath = `${orderPath}/commands`;
const recoverPath = `${commandsPath}/{commandId}/recover`;
const returnPath = "/{merchantFixture}/payment-return";
const acknowledgmentHeaders = [
  "cache-control",
  "x-content-type-options",
  "location",
  "x-merchant-command-id",
];

test("each merchant command, local view, lookup, recovery and return matches its own response contract", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const contract = await contractAt(merchant.url);
    const order = orderIdentity.assert(
      await compareResponse({
        contract,
        path: ordersPath,
        method: "post",
        response: await post(merchant.url, "/merchant-a/orders", orderBody),
        status: 201,
      }),
    );
    const localPath = `/merchant-a/orders/${order.id}`;
    expect(
      await compareResponse({
        contract,
        path: ordersPath,
        method: "post",
        response: await post(merchant.url, "/merchant-a/orders", orderBody),
        status: 200,
      }),
    ).toMatchObject({ id: order.id, state: "UNPAID" });
    expect(
      await compareResponse({
        contract,
        path: orderPath,
        method: "get",
        response: await fetch(merchant.url + localPath),
        status: 200,
      }),
    ).toMatchObject({ id: order.id, paymentIntentId: null });
    const creation = await post(merchant.url, `${localPath}/payment`);
    const creationCommand = type("string").assert(
      creation.headers.get("x-merchant-command-id"),
    );
    const payment = paymentIdentity.assert(
      await compareResponse({
        contract,
        path: paymentPath,
        method: "post",
        response: creation,
        status: 201,
        headers: acknowledgmentHeaders,
      }),
    );
    expect(
      await compareResponse({
        contract,
        path: recoverPath,
        method: "post",
        response: await post(
          merchant.url,
          `${localPath}/commands/${creationCommand}/recover`,
        ),
        status: 201,
        headers: acknowledgmentHeaders,
      }),
    ).toMatchObject(payment);
    expect(
      await compareResponse({
        contract,
        path: paymentPath,
        method: "get",
        response: await fetch(`${merchant.url}${localPath}/payment`),
        status: 200,
      }),
    ).toMatchObject({
      id: payment.id,
      status: "PENDING",
      revision: 1,
      latestAttempt: null,
    });
    const input = {
      commandNumber: 1,
      expectedRevision: 1,
      mockPaymentMethodRef: "pm_mock_approved",
    };
    const confirmation = await post(
      merchant.url,
      `${localPath}/confirm`,
      input,
    );
    const confirmationCommand = type("string").assert(
      confirmation.headers.get("x-merchant-command-id"),
    );
    for (const [path, method] of [
      [orderPath, "get"],
      [paymentPath, "post"],
      [paymentPath, "get"],
      [confirmPath, "post"],
      [commandsPath, "get"],
      [recoverPath, "post"],
    ] satisfies [string, string][]) {
      compareParameters({
        contract,
        path,
        method,
        values: {
          merchantFixture: "merchant-a",
          orderId: order.id,
          ...(path === recoverPath ? { commandId: confirmationCommand } : {}),
        },
      });
    }
    compareParameters({
      contract,
      path: returnPath,
      method: "get",
      values: { merchantFixture: "merchant-a", paymentId: payment.id },
    });
    for (const path of [paymentPath, recoverPath])
      expect(contract.paths[path]?.["post"]).not.toHaveProperty("requestBody");
    const accepted = await compareResponse({
      contract,
      path: confirmPath,
      method: "post",
      response: confirmation,
      status: 202,
      headers: acknowledgmentHeaders,
    });
    expect(
      await compareResponse({
        contract,
        path: recoverPath,
        method: "post",
        response: await post(
          merchant.url,
          `${localPath}/commands/${confirmationCommand}/recover`,
        ),
        status: 202,
        headers: acknowledgmentHeaders,
      }),
    ).toEqual(accepted);
    expect(
      await compareResponse({
        contract,
        path: commandsPath,
        method: "get",
        response: await fetch(`${merchant.url}${localPath}/commands`),
        status: 200,
      }),
    ).toMatchObject({
      commands: [
        { id: creationCommand, operation: "create", status: "COMPLETED" },
        { id: confirmationCommand, operation: "confirm", status: "COMPLETED" },
      ],
    });
    expect(
      await compareResponse({
        contract,
        path: paymentPath,
        method: "get",
        response: await fetch(`${merchant.url}${localPath}/payment`),
        status: 200,
      }),
    ).toMatchObject({
      status: "PROCESSING",
      revision: 2,
      latestAttempt: { status: "PROCESSING" },
    });
    expect(
      await compareResponse({
        contract,
        path: returnPath,
        method: "get",
        response: await fetch(
          `${merchant.url}/merchant-a/payment-return?paymentId=${payment.id}`,
        ),
        status: 200,
      }),
    ).toMatchObject({
      state: "UNPAID",
      payment: { status: "PROCESSING", revision: 2 },
    });

    const rejected = await post(merchant.url, `${localPath}/confirm`, {
      ...input,
      commandNumber: 2,
    });
    const rejectedCommand = type("string").assert(
      rejected.headers.get("x-merchant-command-id"),
    );
    const rejectedBody = await compareResponse({
      contract,
      path: confirmPath,
      method: "post",
      response: rejected,
      status: 409,
      headers: [
        "cache-control",
        "x-content-type-options",
        "x-merchant-command-id",
      ],
    });
    expect(rejectedBody).toMatchObject({
      error: { code: "payment_revision_conflict" },
    });
    expect(rejected.headers.get("retry-after")).toBeNull();
    expect(
      await compareResponse({
        contract,
        path: recoverPath,
        method: "post",
        response: await post(
          merchant.url,
          `${localPath}/commands/${rejectedCommand}/recover`,
        ),
        status: 409,
        headers: [
          "cache-control",
          "x-content-type-options",
          "x-merchant-command-id",
        ],
      }),
    ).toEqual(rejectedBody);

    for (const scenario of [
      {
        path: ordersPath,
        target: "/merchant-c/orders",
        method: "post",
        body: orderBody,
        status: 404,
      },
      {
        path: ordersPath,
        target: "/merchant-a/orders",
        method: "post",
        body: { ...orderBody, amount: 1 },
        status: 409,
      },
      {
        path: ordersPath,
        target: "/merchant-a/orders",
        method: "post",
        body: { ...orderBody, pan: "synthetic-forbidden" },
        status: 400,
      },
      {
        path: orderPath,
        target: `${localPath}?extra=1`,
        method: "get",
        status: 400,
      },
      {
        path: orderPath,
        target: "/merchant-a/orders/bad",
        method: "get",
        status: 400,
      },
      {
        path: orderPath,
        target: localPath.replace("merchant-a", "merchant-b"),
        method: "get",
        status: 404,
      },
      {
        path: paymentPath,
        target: `${localPath}/payment`,
        method: "post",
        body: {},
        status: 400,
      },
      {
        path: paymentPath,
        target: `${localPath}/payment?extra=1`,
        method: "get",
        status: 400,
      },
      {
        path: paymentPath,
        target: `${localPath.replace("merchant-a", "merchant-b")}/payment`,
        method: "get",
        status: 404,
      },
      {
        path: paymentPath,
        target: `${localPath.replace("merchant-a", "merchant-b")}/payment`,
        method: "post",
        status: 404,
      },
      {
        path: commandsPath,
        target: `${localPath}/commands?extra=1`,
        method: "get",
        status: 400,
      },
      {
        path: commandsPath,
        target: "/merchant-a/orders/bad/commands",
        method: "get",
        status: 400,
      },
      {
        path: commandsPath,
        target: `${localPath.replace("merchant-a", "merchant-b")}/commands`,
        method: "get",
        status: 404,
      },
      {
        path: recoverPath,
        target: `${localPath}/commands/${creationCommand}/recover`,
        method: "post",
        body: {},
        status: 400,
      },
      {
        path: recoverPath,
        target: `${localPath}/commands/${creationCommand}/recover?extra=1`,
        method: "post",
        status: 400,
      },
      {
        path: recoverPath,
        target: `${localPath}/commands/bad/recover`,
        method: "post",
        status: 400,
      },
      {
        path: recoverPath,
        target: `${localPath.replace("merchant-a", "merchant-b")}/commands/${creationCommand}/recover`,
        method: "post",
        status: 404,
      },
      {
        path: confirmPath,
        target: `${localPath}/confirm`,
        method: "post",
        body: { ...input, expectedRevision: 0 },
        status: 400,
      },
      {
        path: confirmPath,
        target: `${localPath.replace("merchant-a", "merchant-b")}/confirm`,
        method: "post",
        body: input,
        status: 404,
      },
      {
        path: returnPath,
        target: "/merchant-a/payment-return?paymentId=bad",
        method: "get",
        status: 400,
      },
      {
        path: returnPath,
        target: `/merchant-a/payment-return?paymentId=${payment.id}&extra=1`,
        method: "get",
        status: 400,
      },
      {
        path: returnPath,
        target: `/merchant-b/payment-return?paymentId=${payment.id}`,
        method: "get",
        status: 404,
      },
    ]) {
      const response =
        scenario.method === "post"
          ? await post(merchant.url, scenario.target, scenario.body)
          : await fetch(merchant.url + scenario.target);
      await compareResponse({ contract, ...scenario, response });
      expect(response.headers.get("x-merchant-command-id")).toBeNull();
    }
    expect(
      rows(files.paybridge, "SELECT count(*) AS count FROM payment_attempts"),
    ).toEqual([{ count: 1 }]);
    expect(rows(files.merchant, "SELECT state,paid_at FROM orders")).toEqual([
      { state: "UNPAID", paid_at: null },
    ]);
    await services.server.stop();
    for (const scenario of [
      { path: paymentPath, target: `${localPath}/payment` },
      {
        path: returnPath,
        target: `/merchant-a/payment-return?paymentId=${payment.id}`,
      },
    ]) {
      expect(
        await compareResponse({
          contract,
          ...scenario,
          method: "get",
          response: await fetch(merchant.url + scenario.target),
          status: 503,
          headers: ["cache-control", "x-content-type-options", "retry-after"],
        }),
      ).toMatchObject({ error: { code: "paybridge_unavailable" } });
    }
  } finally {
    await merchant.stop();
  }
});

test("a wrong local upstream produces documented 502 responses without replacing the binding or prepared command", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  let merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    const order = orderIdentity.assert(
      await (await post(merchant.url, "/merchant-a/orders", orderBody)).json(),
    );
    const target = `/merchant-a/orders/${order.id}`;
    const payment = paymentIdentity.assert(
      await (await post(merchant.url, `${target}/payment`)).json(),
    );
    await merchant.stop();
    // The real mock API is the wrong upstream and returns a different 404 envelope.
    merchant = await launchMerchant({
      path: files.merchant,
      paybridgeUrl: services.mockUrl,
    });
    const contract = await contractAt(merchant.url);
    for (const [path, requestPath] of [
      [paymentPath, `${target}/payment`],
      [returnPath, `/merchant-a/payment-return?paymentId=${payment.id}`],
    ] satisfies [string, string][]) {
      expect(
        await compareResponse({
          contract,
          path,
          method: "get",
          response: await fetch(merchant.url + requestPath),
          status: 502,
        }),
      ).toMatchObject({ error: { code: "invalid_paybridge_response" } });
    }
    const unbound = orderIdentity.assert(
      await (
        await post(merchant.url, "/merchant-a/orders", {
          ...orderBody,
          businessReference: "UNBOUND",
        })
      ).json(),
    );
    const unboundPath = `/merchant-a/orders/${unbound.id}`;
    expect(
      await compareResponse({
        contract,
        path: paymentPath,
        method: "post",
        response: await post(merchant.url, `${unboundPath}/payment`),
        status: 502,
      }),
    ).toMatchObject({ error: { code: "invalid_paybridge_response" } });
    const commands = type({
      commands: type({ id: "string", status: "'PREPARED'" }).array(),
    }).assert(
      await (await fetch(`${merchant.url}${unboundPath}/commands`)).json(),
    );
    const command = commands.commands[0];
    if (!command) throw new Error("Expected retained prepared command");
    expect(
      await compareResponse({
        contract,
        path: recoverPath,
        method: "post",
        response: await post(
          merchant.url,
          `${unboundPath}/commands/${command.id}/recover`,
        ),
        status: 502,
      }),
    ).toMatchObject({ error: { code: "invalid_paybridge_response" } });
    await services.mock.stop();
    await compareResponse({
      contract,
      path: recoverPath,
      method: "post",
      response: await post(
        merchant.url,
        `${unboundPath}/commands/${command.id}/recover`,
      ),
      status: 503,
      headers: ["cache-control", "x-content-type-options", "retry-after"],
    });
    expect(
      rows(
        files.merchant,
        "SELECT payment_intent_id,last_applied_revision FROM merchant_payments",
      ),
    ).toEqual([{ payment_intent_id: payment.id, last_applied_revision: 0 }]);
    expect(
      rows(files.paybridge, "SELECT count(*) AS count FROM payment_intents"),
    ).toEqual([{ count: 1 }]);
    expect(rows(files.merchant, "SELECT state,paid_at FROM orders")).toEqual([
      { state: "UNPAID", paid_at: null },
      { state: "UNPAID", paid_at: null },
    ]);
  } finally {
    await merchant.stop();
  }
});
