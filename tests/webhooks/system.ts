import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { startNodeProcess } from "../support/process.ts";
import { ready } from "./support.ts";
export async function startApi({
  path,
  merchantOrigin,
}: {
  path: string;
  merchantOrigin: string;
}) {
  const api = startNodeProcess({
    entrypoint: fileURLToPath(new URL("./fixtures/api.ts", import.meta.url)),
    args: [path, merchantOrigin],
  });
  try {
    return { ...api, url: ready.assert(await api.message()).url };
  } catch (error) {
    await api.stop();
    throw error;
  }
}
export async function startDelivery({
  path,
  options: {
    held = "none",
    timeout = 500,
    lease = 5000,
    poll = 10,
    base = 50,
    cap = 200,
  } = {},
}: {
  path: string;
  options?: {
    held?: string;
    timeout?: number;
    lease?: number;
    poll?: number;
    base?: number;
    cap?: number;
  };
}) {
  const worker = startNodeProcess({
    entrypoint: fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url)),
    args: [
      path,
      held,
      String(timeout),
      String(lease),
      String(poll),
      String(base),
      String(cap),
    ],
  });
  try {
    const identity = type({ kind: "'ready'", workerId: "string" }).assert(
      await worker.message(),
    );
    return {
      ...worker,
      workerId: identity.workerId,
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
export async function cancelled({
  url,
  merchantOrigin,
  key = "cancelled",
}: {
  url: string;
  merchantOrigin: string;
  key?: string;
}) {
  const response = await fetch(`${url}/v1/payment-intents`, {
    method: "POST",
    headers: {
      authorization: "Bearer mock-paybridge-key-a",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      merchantReference: key,
      amount: 7500,
      currency: "XCD",
      returnUrl: `${merchantOrigin}/payment-return`,
    }),
  });
  if (response.status !== 201)
    throw new Error("Expected creation acknowledgment");
  const { id } = type({ id: "string" }).assert(await response.json());
  const cancellation = await fetch(`${url}/v1/payment-intents/${id}/cancel`, {
    method: "POST",
    headers: { authorization: "Bearer mock-paybridge-key-a" },
  });
  if (cancellation.status !== 200) throw new Error("Expected cancellation");
  return id;
}

export async function advance({
  worker,
  epochMs,
}: {
  worker: ReturnType<typeof startNodeProcess>;
  epochMs: number;
}) {
  worker.child.send({ kind: "advance", epochMs });
  for (;;) {
    if (type({ kind: "'advanced'" }).allows(await worker.message())) return;
  }
}
