import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { startNodeProcess } from "../support/process.ts";
import { signed } from "../webhooks/support.ts";
import { rows } from "../provider/support.ts";
import {
  orderBody,
  orderIdentity,
  paymentIdentity,
  post,
} from "../merchant/support.ts";

export async function startInbox(path: string) {
  const worker = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("../../apps/merchant/worker.ts", import.meta.url),
    ),
    args: [path, "1000", "10", "50", "200"],
  });
  try {
    type({ kind: "'ready'", workerId: "string" }).assert(
      await worker.message(),
    );
    return worker;
  } catch (error) {
    await worker.stop();
    throw error;
  }
}

export async function boundOrder({
  url,
  merchant = "a",
  reference = "ORDER-1",
}: {
  url: string;
  merchant?: string;
  reference?: string;
}) {
  const order = orderIdentity.assert(
    await (
      await post({
        url,
        path: `/merchant-${merchant}/orders`,
        body: {
          ...orderBody,
          businessReference: reference,
        },
      })
    ).json(),
  );
  const path = `/merchant-${merchant}/orders/${order.id}`;
  const payment = paymentIdentity.assert(
    await (await post({ url, path: `${path}/payment` })).json(),
  );
  return { order, payment, path };
}

export function events(path: string) {
  return type({
    payment_event_id: "string",
    payload: "string",
    event_type: "string",
    merchant_id: "string",
  })
    .array()
    .assert(
      rows({
        path,
        sql: "SELECT payment_event_id,payload,event_type,merchant_id FROM webhook_outbox ORDER BY rowid",
      }),
    );
}

export function deliver({
  url,
  body,
  merchant = "a",
}: {
  url: string;
  body: string;
  merchant?: string;
}) {
  const { id } = type({ id: "string" }).assert(JSON.parse(body));
  return fetch(`${url}/api/webhooks/paybridge/merchant-${merchant}`, {
    method: "POST",
    body,
    headers: signed({
      body,
      options: {
        id,
        secret: `mock-webhook-secret-${merchant}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    }),
  });
}

export function merchantRecords(path: string) {
  return {
    orders: rows({ path, sql: "SELECT * FROM orders ORDER BY id" }),
    payments: rows({
      path,
      sql: "SELECT * FROM merchant_payments ORDER BY payment_intent_id",
    }),
    inbox: rows({ path, sql: "SELECT * FROM webhook_inbox ORDER BY event_id" }),
  };
}

export async function controlledInbox({
  path,
  held = "none",
  options: { lease = 1000, base = 50, cap = 200 } = {},
}: {
  path: string;
  held?: string;
  options?: { lease?: number; base?: number; cap?: number };
}) {
  const worker = startNodeProcess({
    entrypoint: fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url)),
    args: [path, held, String(lease), "10", String(base), String(cap)],
  });
  try {
    const { workerId } = type({ kind: "'ready'", workerId: "string" }).assert(
      await worker.message(),
    );
    return {
      ...worker,
      workerId,
      async start() {
        worker.child.send({ kind: "start" });
        type({ kind: "'loop-started'" }).assert(await worker.message());
      },
    };
  } catch (error) {
    await worker.stop();
    throw error;
  }
}
