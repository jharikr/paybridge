import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect } from "vitest";
import { startNodeProcess } from "../support/process.ts";
import { rows, workerReady } from "../provider/support.ts";

export async function recoveryWorker({
  path,
  origin,
  hold = "none",
}: {
  path: string;
  origin: string;
  hold?: "none" | "after-claim" | "before-result-commit";
}) {
  const worker = startNodeProcess({
    entrypoint: fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url)),
    args: [path, origin, "5000", "10000", "20", hold],
  });
  try {
    const { workerId } = workerReady.assert(await worker.message());
    return {
      ...worker,
      workerId,
      async start() {
        worker.child.send({ kind: "start" });
        expect(await worker.message()).toEqual({ kind: "loop-started" });
      },
      async advance(epochMs: number) {
        worker.child.send({ kind: "advance", epochMs });
        expect(await worker.message()).toEqual({ kind: "advanced" });
      },
      release() {
        worker.child.send({ kind: "release" });
      },
      async [Symbol.asyncDispose]() {
        await worker.stop();
      },
    };
  } catch (error) {
    await worker.stop();
    throw error;
  }
}
export function claim(path: string) {
  return type({
    claim_token: "string",
    locked_by: "string",
    lease_expires_at: "string",
    attempt_count: "number",
    status: "'PROCESSING'",
  }).assert(rows(path, "SELECT * FROM provider_outbox")[0]);
}
export function identity(path: string) {
  return type({
    payment_intent_id: "string",
    payment_attempt_id: "string",
    provider_account_ref: "string",
    provider_transaction_id: "string",
    provider_invoice: "string",
    amount: "number",
    currency: "string",
    mock_payment_method_ref: "string",
  }).assert(
    rows(
      path,
      `SELECT p.id AS payment_intent_id, a.id AS payment_attempt_id,
    a.provider_account_ref, a.provider_transaction_id, p.provider_invoice,
    p.amount, p.currency, a.mock_payment_method_ref
    FROM payment_intents p JOIN payment_attempts a ON a.payment_intent_id = p.id`,
    )[0],
  );
}
export function ledger(path: string) {
  return rows(path, "SELECT * FROM mock_transactions ORDER BY id");
}
export function records(path: string) {
  return {
    attempts: rows(path, "SELECT * FROM payment_attempts ORDER BY id"),
    work: rows(path, "SELECT * FROM provider_outbox ORDER BY id"),
    cases: rows(path, "SELECT * FROM reconciliations ORDER BY id"),
    events: rows(path, "SELECT * FROM payment_events ORDER BY rowid"),
    // Delivery bookkeeping can advance while the combined worker preserves these financial facts.
    webhooks: rows(
      path,
      "SELECT id,payment_event_id,merchant_id,payment_intent_id,event_type,payload,created_at FROM webhook_outbox ORDER BY id",
    ),
  };
}
export const mockGate = type({
  kind: "'before-acceptance' | 'after-acceptance'",
  gateId: "string",
  providerAccount: "string",
  tranId: "string",
});
export async function claimed(
  worker: Awaited<ReturnType<typeof recoveryWorker>>,
) {
  expect(await worker.message()).toEqual({
    kind: "after-claim",
    workerId: worker.workerId,
  });
}
