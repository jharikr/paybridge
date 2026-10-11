import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { journey, rows } from "../provider/support.ts";

const ready = type({ kind: "'ready'", url: "string" });
const orderBody = {
  businessReference: "ORDER-1",
  amount: 7500,
  currency: "XCD",
};
const orderIdentity = type({ id: "string", merchantId: "string" });
const paymentIdentity = type({ id: "string", checkoutUrl: "string" });
const entrypoint = fileURLToPath(
  new URL("../../apps/merchant/server.ts", import.meta.url),
);
function post(url: string, path: string, body?: unknown) {
  return fetch(`${url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

test("the sample keeps one durable intent binding for each merchant-owned order", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = startNodeProcess({
    entrypoint,
    args: [files.merchant, "0", services.url],
  });
  try {
    const { url } = ready.assert(await merchant.message());
    const first = await post(url, "/merchant-a/orders", orderBody);
    expect(first.status).toBe(201);
    const order = orderIdentity.assert(await first.json());
    expect(order.merchantId).toBe("merchant-a");
    const repeatedOrder = await post(url, "/merchant-a/orders", orderBody);
    expect(repeatedOrder.status).toBe(200);
    expect(orderIdentity.assert(await repeatedOrder.json()).id).toBe(order.id);
    const creation = await post(url, `/merchant-a/orders/${order.id}/payment`);
    expect(creation.status).toBe(201);
    const original = await creation.text();
    const payment = paymentIdentity.assert(JSON.parse(original));
    expect(creation.headers.get("x-merchant-command-id")).toMatch(/^mc_/);
    const repeated = await post(url, `/merchant-a/orders/${order.id}/payment`);
    expect(await repeated.text()).toBe(original);
    expect(
      rows(
        files.merchant,
        "SELECT merchant_id, business_reference, state, paid_at FROM orders",
      ),
    ).toEqual([
      {
        merchant_id: "merchant-a",
        business_reference: "ORDER-1",
        state: "UNPAID",
        paid_at: null,
      },
    ]);
    expect(
      rows(
        files.merchant,
        "SELECT payment_intent_id, merchant_id, order_id, last_applied_revision FROM merchant_payments",
      ),
    ).toEqual([
      {
        payment_intent_id: payment.id,
        merchant_id: "merchant-a",
        order_id: order.id,
        last_applied_revision: 0,
      },
    ]);
    expect(
      rows(
        files.merchant,
        "SELECT operation, command_number, status, response_status, response_body FROM merchant_commands",
      ),
    ).toEqual([
      {
        operation: "create",
        command_number: 1,
        status: "COMPLETED",
        response_status: 201,
        response_body: original,
      },
    ]);
    expect(
      rows(
        files.paybridge,
        "SELECT merchant_id, return_url FROM payment_intents",
      ),
    ).toEqual([
      {
        merchant_id: "merchant-a",
        return_url: "http://127.0.0.1:3101/merchant-a/payment-return",
      },
    ]);
    const read = await fetch(`${url}/merchant-a/orders/${order.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: order.id,
      state: "UNPAID",
      paymentIntentId: payment.id,
    });
    expect(merchant.output()).not.toMatch(
      /mock-paybridge-key|checkout\/.+token=/,
    );
  } finally {
    await merchant.stop();
  }
});

test("a deliberate confirmation after decline uses a new command on the same intent and acknowledgments never pay the order", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = startNodeProcess({
    entrypoint,
    args: [files.merchant, "0", services.url],
  });
  try {
    const { url } = ready.assert(await merchant.message());
    const order = orderIdentity.assert(
      await (await post(url, "/merchant-a/orders", orderBody)).json(),
    );
    const path = `/merchant-a/orders/${order.id}`;
    const creation = await post(url, `${path}/payment`);
    const creationBody = await creation.text();
    const payment = paymentIdentity.assert(JSON.parse(creationBody));
    const initial = await fetch(`${url}${path}/payment`);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      id: payment.id,
      status: "PENDING",
      revision: 1,
    });
    const declinedCommand = {
      commandNumber: 1,
      mockPaymentMethodRef: "pm_mock_declined",
      expectedRevision: 1,
    };
    const accepted = await post(url, `${path}/confirm`, declinedCommand);
    expect(accepted.status).toBe(202);
    const firstAcknowledgment = await accepted.text();
    await services.startWorker();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${url}${path}/payment`)).json()).status,
      )
      .toBe("FAILED");
    const replay = await post(url, `${path}/confirm`, declinedCommand);
    expect(replay.status).toBe(202);
    expect(await replay.text()).toBe(firstAcknowledgment);
    const retry = await post(url, `${path}/confirm`, {
      commandNumber: 2,
      mockPaymentMethodRef: "pm_mock_approved",
      expectedRevision: 3,
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      paymentIntentId: payment.id,
      attemptNumber: 2,
      revision: 4,
    });
    await expect
      .poll(
        async () =>
          (await (await fetch(`${url}${path}/payment`)).json()).status,
      )
      .toBe("SUCCEEDED");
    expect(await (await post(url, `${path}/payment`)).text()).toBe(
      creationBody,
    );
    expect(await (await fetch(`${url}${path}`)).json()).toMatchObject({
      state: "UNPAID",
      paidAt: null,
      paymentIntentId: payment.id,
    });
    expect(
      rows(
        files.merchant,
        "SELECT last_applied_revision, status, snapshot FROM merchant_payments",
      ),
    ).toEqual([{ last_applied_revision: 0, status: null, snapshot: null }]);
    const commands = rows(
      files.merchant,
      "SELECT command_number, idempotency_key, status FROM merchant_commands WHERE operation = 'confirm' ORDER BY command_number",
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      command_number: 1,
      status: "COMPLETED",
    });
    expect(commands[1]).toMatchObject({
      command_number: 2,
      status: "COMPLETED",
    });
    expect(commands[0]?.idempotency_key).not.toBe(commands[1]?.idempotency_key);
    expect(rows(files.paybridge, "SELECT id FROM payment_intents")).toEqual([
      { id: payment.id },
    ]);
    expect(
      rows(
        files.mockFourcs,
        "SELECT final_outcome, effect_count FROM mock_transactions ORDER BY accepted_at",
      ),
    ).toEqual([
      { final_outcome: "Declined", effect_count: 0 },
      { final_outcome: "Approved", effect_count: 1 },
    ]);
  } finally {
    await merchant.stop();
  }
});
