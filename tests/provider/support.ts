import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect } from "vitest";
import { startNodeProcess } from "../support/process.ts";

export const ready = type({ kind: "'ready'", url: "string" });
export const workerReady = type({ kind: "'ready'", workerId: "string" });
export const serverEntry = fileURLToPath(
  new URL("../../apps/paybridge/server.ts", import.meta.url),
);
export const mockEntry = fileURLToPath(
  new URL("../../apps/mock-fourcs/main.ts", import.meta.url),
);
export const workerEntry = fileURLToPath(
  new URL("../../apps/paybridge/worker.ts", import.meta.url),
);
export function headers(merchant = "a") {
  return {
    authorization: `Bearer mock-paybridge-key-${merchant}`,
    "content-type": "application/json",
  };
}
export function rows(path: string, sql: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
export async function expireClaim(
  worker: ReturnType<typeof startNodeProcess>,
  path: string,
) {
  const claim = type({ lease_expires_at: "string" }).assert(
    rows(
      path,
      "SELECT lease_expires_at FROM provider_outbox WHERE status = 'PROCESSING'",
    )[0],
  );
  worker.child.send({
    kind: "advance",
    epochMs: Date.parse(claim.lease_expires_at) + 1,
  });
  expect(await worker.message()).toEqual({ kind: "advanced" });
}
export function create(
  url: string,
  { key = "create-1", merchant = "a", amount = 7500 } = {},
) {
  return fetch(`${url}/v1/payment-intents`, {
    method: "POST",
    headers: { ...headers(merchant), "idempotency-key": key },
    body: JSON.stringify({
      merchantReference: "Order <&> 😀",
      description: "Inert </request><MerchantKey>other</MerchantKey>",
      amount,
      currency: "XCD",
      returnUrl: "http://127.0.0.1:3101/payment-return",
    }),
  });
}
export function confirm(
  url: string,
  id: string,
  {
    key = "confirm-1",
    merchant = "a",
    fixture = "pm_mock_approved",
    revision = 1,
  } = {},
) {
  return fetch(`${url}/v1/payment-intents/${id}/confirm`, {
    method: "POST",
    headers: { ...headers(merchant), "idempotency-key": key },
    body: JSON.stringify({
      mockPaymentMethodRef: fixture,
      expectedRevision: revision,
    }),
  });
}
export async function lookup(url: string, id: string, merchant = "a") {
  const response = await fetch(`${url}/v1/payment-intents/${id}`, {
    headers: headers(merchant),
  });
  expect(response.status).toBe(200);
  return response.json();
}
export async function journey(files: {
  paybridge: string;
  mockFourcs: string;
}) {
  const server = startNodeProcess({
    entrypoint: serverEntry,
    args: [files.paybridge, "0"],
  });
  const mock = startNodeProcess({
    entrypoint: mockEntry,
    args: [files.mockFourcs, "0", "--test-control"],
  });
  const workers: ReturnType<typeof startNodeProcess>[] = [];
  try {
    const { url } = ready.assert(await server.message());
    const mockUrl = ready.assert(await mock.message()).url;
    return {
      url,
      mockUrl,
      mock,
      server,
      async startWorker({
        entrypoint = workerEntry,
        origin = mockUrl,
        timeout = 500,
        lease = 3000,
      }: {
        entrypoint?: string;
        origin?: string;
        timeout?: number;
        lease?: number;
      } = {}) {
        const worker = startNodeProcess({
          entrypoint,
          args: [files.paybridge, origin, String(timeout), String(lease), "20"],
        });
        workers.push(worker);
        workerReady.assert(await worker.message());
        return worker;
      },
      async [Symbol.asyncDispose]() {
        await Promise.all(
          [...workers, server, mock].map((process) => process.stop()),
        );
      },
    };
  } catch (error) {
    await Promise.all([server.stop(), mock.stop()]);
    throw error;
  }
}
