import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import {
  buildFourcsRequest,
  soapAction,
  soapPath,
} from "../../contracts/fourcs.ts";
import { isolatedDatabases } from "../support/databases.ts";
import {
  confirm,
  create,
  expireClaim,
  journey,
  lookup,
  rows,
} from "./support.ts";

test("a matching duplicate is unknown and records one case without submitting a new transaction identity", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  expect((await confirm(app.url, id)).status).toBe(202);
  const stored = type({
    provider_transaction_id: "string",
    provider_invoice: "string",
    amount: "number",
  }).assert(
    rows(
      files.paybridge,
      "SELECT a.provider_transaction_id, p.provider_invoice, p.amount FROM payment_attempts a JOIN payment_intents p ON p.id = a.payment_intent_id",
    )[0],
  );
  const accepted = await fetch(`${app.mockUrl}${soapPath}`, {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      soapaction: soapAction,
    },
    body: buildFourcsRequest({
      merchantKey: "mock-provider-key-a",
      tranId: stored.provider_transaction_id,
      invoice: stored.provider_invoice,
      amountMinor: stored.amount,
      currency: "XCD",
      mockPaymentMethodRef: "pm_mock_approved",
    }),
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.text()).toContain(
    "<FinancialResultCode>Approved</FinancialResultCode>",
  );
  await app.startWorker();
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({
      status: "UNKNOWN",
      revision: 3,
      latestAttempt: { failureCode: "DuplicateTransaction" },
    });
  expect(
    rows(files.paybridge, "SELECT status, reason FROM reconciliations"),
  ).toEqual([{ status: "REQUIRED", reason: "DuplicateTransaction" }]);
  expect(
    rows(
      files.mockFourcs,
      "SELECT effect_count, tran_id FROM mock_transactions",
    ),
  ).toEqual([{ effect_count: 1, tran_id: stored.provider_transaction_id }]);
});

test("a received approval after lease expiry is retained as an observation without a financial mutation", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  const { paymentAttemptId } = type({ paymentAttemptId: "string" }).assert(
    await (
      await confirm(app.url, id, { fixture: "pm_mock_delayed_response" })
    ).json(),
  );
  const worker = await app.startWorker({
    entrypoint: fileURLToPath(
      new URL("./fixtures/expired-worker.ts", import.meta.url),
    ),
    timeout: 3000,
    lease: 5000,
  });
  const gate = type({ kind: "'after-acceptance'", gateId: "string" }).assert(
    await app.mock.message(),
  );
  await expireClaim(worker, files.paybridge);
  app.mock.child.send({ kind: "release", gateId: gate.gateId });
  expect(await worker.message()).toMatchObject({
    code: "provider_response_observed",
    paymentAttemptId,
  });
  expect(await lookup(app.url, id)).toMatchObject({
    status: "PROCESSING",
    revision: 2,
  });
  expect(
    rows(
      files.paybridge,
      "SELECT status, completed_at, locked_by FROM provider_outbox",
    ),
  ).toEqual([
    {
      status: "PROCESSING",
      completed_at: null,
      locked_by: "test-expired-worker",
    },
  ]);
  expect(rows(files.paybridge, "SELECT id FROM reconciliations")).toEqual([]);
  expect(rows(files.paybridge, "SELECT id FROM webhook_outbox")).toEqual([]);
  const observation = type({
    metadata: "string",
    payment_attempt_id: "string",
    from_status: "null",
    to_status: "null",
    intent_revision: "number",
  }).assert(
    rows(
      files.paybridge,
      "SELECT metadata, payment_attempt_id, from_status, to_status, intent_revision FROM payment_events WHERE type = 'PROVIDER_RESPONSE_OBSERVED'",
    )[0],
  );
  expect(observation).toMatchObject({
    payment_attempt_id: paymentAttemptId,
    from_status: null,
    to_status: null,
    intent_revision: 2,
  });
  expect(JSON.parse(observation.metadata)).toMatchObject({
    providerAccount: "mock-account-a",
    providerTransactionId: expect.stringMatching(/^[a-f0-9]{16}$/),
    classification: "succeeded",
    observedAt: expect.any(String),
    evidence: {
      operation: "OK",
      service: "OK",
      financial: "Approved",
      hostReference: expect.stringMatching(/^[a-f0-9]{16}$/),
    },
    contradictory: false,
  });
  expect(
    rows(files.mockFourcs, "SELECT effect_count FROM mock_transactions"),
  ).toEqual([{ effect_count: 1 }]);
});

test.each(["pm_mock_approved", "pm_mock_malformed"])(
  "a result transaction failure rolls back financial state, event, reconciliation, and webhook for %s",
  async (fixture) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    const { id } = type({ id: "string" }).assert(
      await (await create(app.url)).json(),
    );
    expect((await confirm(app.url, id, { fixture })).status).toBe(202);
    const worker = await app.startWorker({
      entrypoint: fileURLToPath(
        new URL("./fixtures/worker.ts", import.meta.url),
      ),
    });
    expect(await worker.message()).toEqual({ kind: "result-rolled-back" });
    expect(await lookup(app.url, id)).toMatchObject({
      status: "PROCESSING",
      revision: 2,
      latestAttempt: { status: "PROCESSING" },
    });
    expect(
      rows(
        files.paybridge,
        "SELECT status, provider_operation_result, provider_host_reference FROM payment_attempts",
      ),
    ).toEqual([
      {
        status: "PROCESSING",
        provider_operation_result: null,
        provider_host_reference: null,
      },
    ]);
    expect(
      rows(
        files.paybridge,
        "SELECT status, attempt_count, completed_at FROM provider_outbox",
      ),
    ).toEqual([{ status: "PROCESSING", attempt_count: 1, completed_at: null }]);
    expect(
      rows(
        files.paybridge,
        "SELECT type FROM payment_events ORDER BY intent_revision",
      ),
    ).toEqual([{ type: "PAYMENT_CREATED" }, { type: "ATTEMPT_CREATED" }]);
    expect(rows(files.paybridge, "SELECT id FROM reconciliations")).toEqual([]);
    expect(rows(files.paybridge, "SELECT id FROM webhook_outbox")).toEqual([]);
    expect(
      rows(files.mockFourcs, "SELECT effect_count FROM mock_transactions"),
    ).toEqual([{ effect_count: 1 }]);
  },
);

test("reconciliation constraints retain one matched unknown case and reject invalid states or erased history", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  const other = type({ id: "string" }).assert(
    await (await create(app.url, { key: "other", merchant: "b" })).json(),
  ).id;
  expect(
    (await confirm(app.url, id, { fixture: "pm_mock_malformed" })).status,
  ).toBe(202);
  const worker = await app.startWorker();
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "UNKNOWN" });
  await worker.stop();
  const db = new DatabaseSync(files.paybridge);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    expect(() =>
      db.prepare("UPDATE reconciliations SET payment_intent_id = ?").run(other),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE reconciliations SET status = 'OTHER'"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE reconciliations SET status = 'RESOLVED'"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE reconciliations SET resolution = 'FAILED'"),
    ).toThrow();
    expect(() => db.exec("DELETE FROM reconciliations")).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO reconciliations (id, payment_intent_id, payment_attempt_id, status, reason, created_at) SELECT 'rec_duplicate', payment_intent_id, payment_attempt_id, status, reason, created_at FROM reconciliations",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "UPDATE payment_attempts SET provider_account_ref = 'mock-account-b'",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "UPDATE payment_attempts SET provider_transaction_id = 'substituted'",
      ),
    ).toThrow();
    expect(() => db.exec("UPDATE webhook_outbox SET payload = '{}'")).toThrow();
    expect(() =>
      db.exec("UPDATE payment_events SET metadata = '{}'"),
    ).toThrow();
  } finally {
    db.close();
  }
  expect(await lookup(app.url, id)).toMatchObject({
    status: "UNKNOWN",
    revision: 3,
  });
});
