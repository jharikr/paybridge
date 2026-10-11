import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, create, journey, lookup, rows } from "../provider/support.ts";
import {
  claim,
  claimed,
  identity,
  ledger,
  mockGate,
  records,
  recoveryWorker,
} from "./support.ts";

test("two worker processes compete for one claim without creating another financial attempt", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using a = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  await using b = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  expect(
    (await confirm(app.url, id, { fixture: "pm_mock_delayed_response" }))
      .status,
  ).toBe(202);
  await Promise.all([a.start(), b.start()]);
  const gate = mockGate.assert(await app.mock.message());
  expect(gate.kind).toBe("after-acceptance");
  const owner = claim(files.paybridge);
  expect([a.workerId, b.workerId]).toContain(owner.locked_by);
  expect(owner.attempt_count).toBe(1);
  expect(await lookup(app.url, id)).toMatchObject({
    status: "PROCESSING",
    revision: 2,
  });
  expect(ledger(files.mockFourcs)).toMatchObject([
    { final_outcome: "Approved", effect_count: 1 },
  ]);
  app.mock.child.send({ kind: "release", gateId: gate.gateId });
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "SUCCEEDED", revision: 3 });
  const saved = records(files.paybridge);
  expect(saved.work).toMatchObject([
    {
      status: "COMPLETED",
      attempt_count: 1,
      claim_token: null,
      locked_by: null,
      lease_expires_at: null,
    },
  ]);
  expect(saved.attempts).toHaveLength(1);
  expect(saved.webhooks).toHaveLength(1);
  expect(saved.cases).toEqual([]);
}, 20000);

test("a delayed old request cannot overwrite a definite result committed by its replacement", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using a = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  await using b = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  expect(
    (await confirm(app.url, id, { fixture: "pm_mock_held_before_acceptance" }))
      .status,
  ).toBe(202);
  const original = identity(files.paybridge);
  await a.start();
  await claimed(a);
  const older = mockGate.assert(await app.mock.message());
  expect(older.kind).toBe("before-acceptance");
  expect(ledger(files.mockFourcs)).toEqual([]);
  const epoch = Date.parse(claim(files.paybridge).lease_expires_at) + 1;
  await a.advance(epoch);
  await b.advance(epoch);
  await b.start();
  await claimed(b);
  const newer = mockGate.assert(await app.mock.message());
  expect(newer).toMatchObject({
    kind: "before-acceptance",
    providerAccount: older.providerAccount,
    tranId: older.tranId,
  });
  expect(newer.gateId).not.toBe(older.gateId);
  app.mock.child.send({ kind: "release", gateId: newer.gateId });
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "SUCCEEDED", revision: 3 });
  const snapshot = await lookup(app.url, id);
  const saved = records(files.paybridge);
  const accepted = ledger(files.mockFourcs);
  expect(accepted).toMatchObject([
    { final_outcome: "Approved", effect_count: 1 },
  ]);
  expect(saved.work).toMatchObject([
    {
      status: "COMPLETED",
      attempt_count: 2,
      claim_token: null,
      locked_by: null,
      lease_expires_at: null,
    },
  ]);
  app.mock.child.send({ kind: "release", gateId: older.gateId });
  expect(await a.message()).toEqual({
    code: "provider_response_observed",
    workerId: a.workerId,
    paymentAttemptId: original.payment_attempt_id,
  });
  const after = records(files.paybridge);
  expect({ ...after, events: saved.events }).toEqual(saved);
  expect(after.events.slice(0, -1)).toEqual(saved.events);
  const observation = type({
    metadata: "string",
    payment_attempt_id: "string",
    intent_revision: "number",
  }).assert(after.events.at(-1));
  expect(observation).toMatchObject({
    payment_attempt_id: original.payment_attempt_id,
    intent_revision: 3,
  });
  expect(JSON.parse(observation.metadata)).toMatchObject({
    providerAccount: original.provider_account_ref,
    providerTransactionId: original.provider_transaction_id,
    classification: "unknown",
    failureCode: "DuplicateTransaction",
    contradictory: false,
  });
  expect(await lookup(app.url, id)).toEqual(snapshot);
  expect(after.cases).toEqual([]);
  expect(after.webhooks).toHaveLength(1);
  expect(ledger(files.mockFourcs)).toEqual(accepted);
}, 20000);

test("received approval after duplicate recovery preserves UNKNOWN and its financial records through later polling", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using a = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  await using b = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  const ack = await confirm(app.url, id, {
    fixture: "pm_mock_delayed_response",
  });
  expect(ack.status).toBe(202);
  const bytes = await ack.text();
  const original = identity(files.paybridge);
  await a.start();
  await claimed(a);
  const gate = mockGate.assert(await app.mock.message());
  expect(gate).toMatchObject({
    kind: "after-acceptance",
    providerAccount: original.provider_account_ref,
    tranId: original.provider_transaction_id,
  });
  const provider = ledger(files.mockFourcs);
  const epoch = Date.parse(claim(files.paybridge).lease_expires_at) + 1;
  await a.advance(epoch);
  await b.advance(epoch);
  await b.start();
  await claimed(b);
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "UNKNOWN", revision: 3 });
  const before = records(files.paybridge);
  const snapshot = await lookup(app.url, id);
  expect(before.cases).toHaveLength(1);
  expect(before.webhooks).toMatchObject([{ event_type: "payment.unknown" }]);
  app.mock.child.send({ kind: "release", gateId: gate.gateId });
  expect(await a.message()).toEqual({
    code: "provider_response_observed",
    workerId: a.workerId,
    paymentAttemptId: original.payment_attempt_id,
  });
  const after = records(files.paybridge);
  expect({ ...after, events: before.events }).toEqual(before);
  expect(after.events.slice(0, -1)).toEqual(before.events);
  const observation = type({
    type: "'PROVIDER_RESPONSE_OBSERVED'",
    payment_attempt_id: "string",
    intent_revision: "number",
    metadata: "string",
    from_status: "null",
    to_status: "null",
  }).assert(after.events.at(-1));
  expect(observation).toMatchObject({
    payment_attempt_id: original.payment_attempt_id,
    intent_revision: 3,
  });
  expect(JSON.parse(observation.metadata)).toMatchObject({
    providerAccount: original.provider_account_ref,
    providerTransactionId: original.provider_transaction_id,
    classification: "succeeded",
    failureCode: null,
    evidence: {
      financial: "Approved",
      hostReference: type({ host_reference: "string" }).assert(provider[0])
        .host_reference,
    },
    observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
  expect(await lookup(app.url, id)).toEqual(snapshot);
  expect(ledger(files.mockFourcs)).toEqual(provider);
  expect(
    await (
      await confirm(app.url, id, { fixture: "pm_mock_delayed_response" })
    ).text(),
  ).toBe(bytes);
  const rejected = await confirm(app.url, id, {
    key: "fresh-while-unknown",
    revision: 3,
  });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({
    error: { code: "payment_not_confirmable" },
  });
  await a.stop();
  await b.advance(epoch + 60000);
  const marker = type({ id: "string" }).assert(
    await (await create(app.url, { key: "poll-marker" })).json(),
  );
  expect(
    (await confirm(app.url, marker.id, { key: "marker-confirm" })).status,
  ).toBe(202);
  await expect
    .poll(() => lookup(app.url, marker.id))
    .toMatchObject({ status: "SUCCEEDED", revision: 3 });
  expect(await lookup(app.url, id)).toEqual(snapshot);
  const polled = records(files.paybridge);
  for (const key of [
    "attempts",
    "work",
    "cases",
    "events",
    "webhooks",
  ] satisfies (keyof typeof after)[]) {
    expect(polled[key]).toEqual(expect.arrayContaining(after[key]));
  }
  expect(polled.attempts).toHaveLength(2);
  expect(polled.work).toHaveLength(2);
  expect(polled.webhooks).toHaveLength(2);
  expect(polled.cases).toHaveLength(1);
  expect(ledger(files.mockFourcs)).toHaveLength(2);
  expect(ledger(files.mockFourcs)).toEqual(expect.arrayContaining(provider));
}, 20000);

test("a stale token cannot finish a replacement claim while the payment is PROCESSING and its new lease is live", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using a = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
  });
  await using b = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
    hold: "after-claim",
  });
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  expect(
    (await confirm(app.url, id, { fixture: "pm_mock_delayed_response" }))
      .status,
  ).toBe(202);
  const original = identity(files.paybridge);
  await a.start();
  await claimed(a);
  const gate = mockGate.assert(await app.mock.message());
  const old = claim(files.paybridge);
  const epoch = Date.parse(old.lease_expires_at) + 1;
  await a.advance(epoch);
  await b.advance(epoch);
  await b.start();
  await claimed(b);
  const replacement = claim(files.paybridge);
  expect(replacement.locked_by).toBe(b.workerId);
  expect(replacement.claim_token).not.toBe(old.claim_token);
  expect(replacement.attempt_count).toBe(2);
  expect(Date.parse(replacement.lease_expires_at)).toBeGreaterThan(
    epoch + 5000,
  );
  expect(await lookup(app.url, id)).toMatchObject({
    status: "PROCESSING",
    revision: 2,
  });

  app.mock.child.send({ kind: "release", gateId: gate.gateId });
  expect(await a.message()).toEqual({
    code: "provider_response_observed",
    workerId: a.workerId,
    paymentAttemptId: original.payment_attempt_id,
  });
  expect(claim(files.paybridge)).toEqual(replacement);
  expect(await lookup(app.url, id)).toMatchObject({
    status: "PROCESSING",
    revision: 2,
    latestAttempt: { status: "PROCESSING" },
  });
  const observed = records(files.paybridge);
  expect(observed.cases).toEqual([]);
  expect(observed.webhooks).toEqual([]);
  expect(observed.events.map((row) => row.type)).toEqual([
    "PAYMENT_CREATED",
    "ATTEMPT_CREATED",
    "PROVIDER_RESPONSE_OBSERVED",
  ]);
  const event = type({
    metadata: "string",
    payment_attempt_id: "string",
    intent_revision: "number",
    from_status: "null",
    to_status: "null",
  }).assert(observed.events[2]);
  expect(event).toMatchObject({
    payment_attempt_id: original.payment_attempt_id,
    intent_revision: 2,
  });
  const provider = type({ host_reference: "string" }).assert(
    ledger(files.mockFourcs)[0],
  );
  expect(JSON.parse(event.metadata)).toMatchObject({
    providerAccount: original.provider_account_ref,
    providerTransactionId: original.provider_transaction_id,
    classification: "succeeded",
    failureCode: null,
    contradictory: false,
    observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    evidence: { financial: "Approved", hostReference: provider.host_reference },
  });
  b.release();
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "UNKNOWN", revision: 3 });
  expect(identity(files.paybridge)).toEqual(original);
  const final = records(files.paybridge);
  expect(final.attempts).toMatchObject([
    { status: "UNKNOWN", failure_code: "DuplicateTransaction" },
  ]);
  expect(final.cases).toMatchObject([
    { status: "REQUIRED", reason: "DuplicateTransaction" },
  ]);
  expect(final.webhooks).toMatchObject([{ event_type: "payment.unknown" }]);
  expect(final.work).toMatchObject([
    {
      status: "COMPLETED",
      attempt_count: 2,
      locked_by: null,
      claim_token: null,
      lease_expires_at: null,
    },
  ]);
  expect(ledger(files.mockFourcs)).toMatchObject([{ effect_count: 1 }]);
  expect(rows(files.paybridge, "SELECT id FROM payment_attempts")).toHaveLength(
    1,
  );
}, 20000);
