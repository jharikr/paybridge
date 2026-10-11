import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, journey, lookup } from "../provider/support.ts";
import { records } from "../recovery/support.ts";
import {
  command,
  inspect,
  resolutionInput,
  unknownPayment,
} from "./support.ts";

test("trusted commands list and start an investigation without changing UNKNOWN or creating a financial event", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id, reconciliationId, identity } = await unknownPayment(
    app,
    files.paybridge,
  );
  const before = records(files.paybridge);
  const listed = await command({
    path: files.paybridge,
    directory: files.directory,
    input: { kind: "list" },
  });
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.body).toMatchObject({
    kind: "listed",
    cases: [
      {
        id: reconciliationId,
        status: "REQUIRED",
        paymentAttemptId: identity.payment_attempt_id,
        providerAccount: identity.provider_account_ref,
        tranId: identity.provider_transaction_id,
        invoice: identity.provider_invoice,
        amountMinor: 7500,
        currency: "XCD",
      },
    ],
  });
  const start = { kind: "start", reconciliationId, operator: "operator-a" };
  const started = await command({
    path: files.paybridge,
    directory: files.directory,
    input: start,
  });
  expect(started.code, started.stderr).toBe(0);
  expect(started.body).toMatchObject({
    kind: "started",
    case: {
      id: reconciliationId,
      status: "IN_PROGRESS",
      startedBy: "operator-a",
      startedAt: expect.any(String),
    },
  });
  const after = records(files.paybridge);
  expect(after.events.map((row) => row.type)).toEqual([
    "PAYMENT_CREATED",
    "ATTEMPT_CREATED",
    "PAYMENT_UNKNOWN",
    "RECONCILIATION_STARTED",
  ]);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.work).toEqual(before.work);
  expect(after.webhooks).toEqual(before.webhooks);
  expect(await lookup(app.url, id)).toMatchObject({
    status: "UNKNOWN",
    revision: 3,
  });
  expect(
    (
      await command({
        path: files.paybridge,
        directory: files.directory,
        input: start,
      })
    ).body,
  ).toEqual(started.body);
  expect(records(files.paybridge)).toEqual(after);
}, 20000);

test("strict evidence boundaries reject absent, mismatched, nonfinal and unsafe facts without any final mutation", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const payment = await unknownPayment(app, files.paybridge);
  const exported = type({ kind: "'recorded'", evidence: "object" }).assert(
    await inspect(
      files.mockFourcs,
      payment.identity.provider_account_ref,
      payment.identity.provider_transaction_id,
    ),
  );
  const input = resolutionInput(payment.reconciliationId, exported);
  const baseline = records(files.paybridge);
  const invalid = [
    {
      ...input,
      evidence: {
        kind: "absent",
        providerAccount: payment.identity.provider_account_ref,
        tranId: payment.identity.provider_transaction_id,
      },
    },
    { ...input, evidence: undefined },
    { ...input, resolution: "FAILED" },
    { ...input, operator: "" },
    { ...input, operator: " \n " },
    { ...input, reason: "  " },
    { ...input, evidenceReference: "\t" },
    { ...input, operator: "bad\u0000operator" },
    { ...input, reason: "\ud800" },
    { ...input, reason: "x".repeat(513) },
    { ...input, notes: "x".repeat(17000) },
    { ...input, evidenceReference: "" },
    { ...input, pan: "9900000000000008" },
    ...[
      { providerAccount: "mock-account-b" },
      { tranId: "OTHER1" },
      { invoice: "OTHER1" },
      { amountMinor: 1 },
      { currency: "USD" },
      { finalOutcome: "Pending" },
      { finalOutcome: "Timeout" },
      { effectCount: 0 },
      { approvalCode: null },
      { hostReference: "raw provider message" },
      { hostReference: "" },
      { requestFingerprint: "not-a-fingerprint" },
      { acceptedAt: "2026-02-30T10:00:00.000Z" },
      { rawResponse: "secret" },
    ].map((change) => ({
      ...input,
      evidence: { ...exported, evidence: { ...exported.evidence, ...change } },
    })),
  ];
  for (const rejected of invalid) {
    const result = await command({
      path: files.paybridge,
      directory: files.directory,
      input: rejected,
    });
    expect(result.code, JSON.stringify(rejected)).toBe(1);
    expect(result.body).toMatchObject({
      kind: "error",
      code: expect.stringMatching(/^(invalid_command|evidence_mismatch)$/),
    });
    expect(result.stderr).not.toMatch(
      /secret|9900000000000008|bad|raw provider/,
    );
    expect(records(files.paybridge)).toEqual(baseline);
  }
  expect(await lookup(app.url, payment.id)).toMatchObject({
    status: "UNKNOWN",
    revision: 3,
  });
  expect(
    (
      await confirm(app.url, payment.id, {
        key: "no-evidence-retry",
        revision: 3,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await command({
        path: files.paybridge,
        directory: files.directory,
        input,
      })
    ).code,
  ).toBe(0);
  expect(await lookup(app.url, payment.id)).toMatchObject({
    status: "SUCCEEDED",
    revision: 4,
  });
}, 30000);

test("matching exported approval resolves UNKNOWN atomically and identical decisions replay without new effects", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id, reconciliationId, identity } = await unknownPayment(
    app,
    files.paybridge,
    { merchant: "b" },
  );
  const evidence = await inspect(
    files.mockFourcs,
    identity.provider_account_ref,
    identity.provider_transaction_id,
  );
  const input = {
    kind: "resolve",
    reconciliationId,
    operator: "operator-a",
    resolution: "SUCCEEDED",
    reason: "Verified stored synthetic approval",
    notes: "Checked invoice and amount",
    evidenceReference: "mock-ledger/export-1",
    evidence,
  };
  const before = records(files.paybridge);
  const resolved = await command({
    path: files.paybridge,
    directory: files.directory,
    input,
  });
  expect(resolved.code, JSON.stringify(resolved.body)).toBe(0);
  expect(resolved.body).toMatchObject({
    kind: "resolved",
    case: {
      id: reconciliationId,
      status: "RESOLVED",
      resolution: "SUCCEEDED",
      resolvedBy: "operator-a",
      reason: input.reason,
      evidenceReference: input.evidenceReference,
      resolvedAt: expect.any(String),
    },
  });
  expect(await lookup(app.url, id, "b")).toMatchObject({
    status: "SUCCEEDED",
    revision: 4,
    latestAttempt: { id: identity.payment_attempt_id, status: "SUCCEEDED" },
  });
  const after = records(files.paybridge);
  expect(after.work).toEqual(before.work);
  expect(after.cases).toHaveLength(1);
  expect(after.cases).toMatchObject([
    {
      status: "RESOLVED",
      resolved_by: "operator-a",
      reason: input.reason,
      notes: input.notes,
    },
  ]);
  expect(after.attempts).toMatchObject([
    {
      status: "SUCCEEDED",
      failure_code: null,
      provider_financial_result: "Approved",
    },
  ]);
  expect(after.events.map((row) => row.type)).toEqual([
    "PAYMENT_CREATED",
    "ATTEMPT_CREATED",
    "PAYMENT_UNKNOWN",
    "RECONCILIATION_RESOLVED",
    "PAYMENT_SUCCEEDED",
  ]);
  expect(after.webhooks.map((row) => row.event_type).sort()).toEqual([
    "payment.succeeded",
    "payment.unknown",
  ]);
  const webhook = type({
    payload: "string",
    payment_event_id: "string",
    merchant_id: "string",
  }).assert(
    after.webhooks.find((row) => row.event_type === "payment.succeeded"),
  );
  expect(webhook.merchant_id).toBe("merchant-b");
  expect(JSON.parse(webhook.payload)).toEqual({
    id: webhook.payment_event_id,
    type: "payment.succeeded",
    createdAt: expect.stringMatching(/^\d{4}-/),
    data: {
      paymentIntentId: id,
      merchantReference: "Order <&> 😀",
      amount: 7500,
      currency: "XCD",
      status: "SUCCEEDED",
      revision: 4,
    },
  });
  expect(
    (
      await command({
        path: files.paybridge,
        directory: files.directory,
        input,
      })
    ).body,
  ).toEqual(resolved.body);
  expect(records(files.paybridge)).toEqual(after);
  expect(
    (
      await command({
        path: files.paybridge,
        directory: files.directory,
        input: { kind: "list" },
      })
    ).body,
  ).toEqual({ kind: "listed", cases: [] });
}, 20000);
