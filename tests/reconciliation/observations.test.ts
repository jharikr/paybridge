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
} from "../recovery/support.ts";
import { command, inspect, providerProxy, resolutionInput } from "./support.ts";

test("absent ledger evidence cannot resolve failure; delayed acceptance can later support operator-verified success", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url)).json(),
  );
  expect(
    (await confirm(app.url, id, { fixture: "pm_mock_held_before_acceptance" }))
      .status,
  ).toBe(202);
  const original = identity(files.paybridge);
  await app.startWorker({ timeout: 300, lease: 1000 });
  const gate = mockGate.assert(await app.mock.message());
  expect(gate.kind).toBe("before-acceptance");
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({ status: "UNKNOWN", revision: 3 });
  const { id: reconciliationId } = type({ id: "string" }).assert(
    rows(files.paybridge, "SELECT id FROM reconciliations")[0],
  );
  const started = await command({
    path: files.paybridge,
    directory: files.directory,
    input: { kind: "start", reconciliationId, operator: "operator-a" },
  });
  expect(started.code).toBe(0);
  const before = records(files.paybridge);
  const absent = await inspect(
    files.mockFourcs,
    original.provider_account_ref,
    original.provider_transaction_id,
  );
  expect(absent).toMatchObject({ kind: "absent" });
  const rejected = await command({
    path: files.paybridge,
    directory: files.directory,
    input: resolutionInput(reconciliationId, absent, "FAILED"),
  });
  expect(rejected.body).toEqual({ kind: "error", code: "invalid_command" });
  expect(records(files.paybridge)).toEqual(before);
  expect(ledger(files.mockFourcs)).toEqual([]);
  expect(
    (await confirm(app.url, id, { key: "absent-retry", revision: 3 })).status,
  ).toBe(409);
  app.mock.child.send({ kind: "release", gateId: gate.gateId });
  expect(await app.mock.message()).toMatchObject({
    kind: "after-acceptance",
    tranId: original.provider_transaction_id,
  });
  const evidence = await inspect(
    files.mockFourcs,
    original.provider_account_ref,
    original.provider_transaction_id,
  );
  expect(evidence).toMatchObject({
    kind: "recorded",
    evidence: { finalOutcome: "Approved", effectCount: 1 },
  });
  expect(records(files.paybridge)).toEqual(before);
  const resolved = await command({
    path: files.paybridge,
    directory: files.directory,
    input: resolutionInput(reconciliationId, evidence),
  });
  expect(resolved.code).toBe(0);
  expect(await lookup(app.url, id)).toMatchObject({
    status: "SUCCEEDED",
    revision: 4,
  });
  expect(records(files.paybridge).events.map((row) => row.type)).toEqual([
    "PAYMENT_CREATED",
    "ATTEMPT_CREATED",
    "PAYMENT_UNKNOWN",
    "RECONCILIATION_STARTED",
    "RECONCILIATION_RESOLVED",
    "PAYMENT_SUCCEEDED",
  ]);
  expect(
    (await confirm(app.url, id, { key: "resolved-success-retry", revision: 4 }))
      .status,
  ).toBe(409);
}, 20000);

test.each([false, true])(
  "an actually received old response after FAILED resolution and a new success preserves both attempts, contradiction = %s",
  async (contradictory) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    const accepted = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    await using proxy = await providerProxy({
      upstream: app.mockUrl,
      reply: async (xml, response) => {
        accepted.resolve(xml);
        await release.promise;
        response.end(
          contradictory
            ? xml.replace(
                "<FinancialResultCode>Declined</FinancialResultCode>",
                "<FinancialResultCode>Approved</FinancialResultCode>",
              )
            : xml,
        );
      },
    });
    await using a = await recoveryWorker({
      path: files.paybridge,
      origin: proxy.origin,
    });
    await using b = await recoveryWorker({
      path: files.paybridge,
      origin: app.mockUrl,
    });
    const { id } = type({ id: "string" }).assert(
      await (await create(app.url)).json(),
    );
    expect(
      (await confirm(app.url, id, { fixture: "pm_mock_declined" })).status,
    ).toBe(202);
    const original = identity(files.paybridge);
    await a.start();
    await claimed(a);
    expect(await accepted.promise).toContain(
      "<FinancialResultCode>Declined</FinancialResultCode>",
    );
    const originalLedger = ledger(files.mockFourcs);
    expect(originalLedger).toMatchObject([
      { final_outcome: "Declined", effect_count: 0 },
    ]);
    const epoch = Date.parse(claim(files.paybridge).lease_expires_at) + 1;
    await a.advance(epoch);
    await b.advance(epoch);
    await b.start();
    await claimed(b);
    await expect
      .poll(() => lookup(app.url, id))
      .toMatchObject({ status: "UNKNOWN", revision: 3 });
    const { id: reconciliationId } = type({ id: "string" }).assert(
      rows(files.paybridge, "SELECT id FROM reconciliations")[0],
    );
    const evidence = await inspect(
      files.mockFourcs,
      original.provider_account_ref,
      original.provider_transaction_id,
    );
    expect(
      (
        await command({
          path: files.paybridge,
          directory: files.directory,
          input: resolutionInput(reconciliationId, evidence, "FAILED"),
        })
      ).code,
    ).toBe(0);
    expect(await lookup(app.url, id)).toMatchObject({
      status: "FAILED",
      revision: 4,
    });
    expect(
      (
        await confirm(app.url, id, {
          key: "deliberate-new-attempt",
          revision: 4,
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(() => lookup(app.url, id))
      .toMatchObject({
        status: "SUCCEEDED",
        revision: 6,
        latestAttempt: { attemptNumber: 2 },
      });
    const before = records(files.paybridge);
    const snapshot = await lookup(app.url, id);
    release.resolve();
    expect(await a.message()).toEqual({
      code: contradictory
        ? "provider_observation_conflicts"
        : "provider_response_observed",
      workerId: a.workerId,
      paymentAttemptId: original.payment_attempt_id,
    });
    const after = records(files.paybridge);
    expect({ ...after, events: before.events }).toEqual(before);
    expect(after.events.slice(0, -1)).toEqual(before.events);
    const event = type({
      payment_attempt_id: "string",
      intent_revision: "number",
      metadata: "string",
      from_status: "null",
      to_status: "null",
    }).assert(after.events.at(-1));
    expect(event).toMatchObject({
      payment_attempt_id: original.payment_attempt_id,
      intent_revision: 6,
    });
    expect(JSON.parse(event.metadata)).toMatchObject({
      providerAccount: original.provider_account_ref,
      providerTransactionId: original.provider_transaction_id,
      classification: contradictory ? "succeeded" : "failed",
      contradictory,
      observedAt: expect.stringMatching(/^\d{4}-/),
      evidence: {
        hostReference: type({ host_reference: "string" }).assert(
          originalLedger[0],
        ).host_reference,
      },
    });
    expect(await lookup(app.url, id)).toEqual(snapshot);
    expect(after.cases).toMatchObject([
      { status: "RESOLVED", resolution: "FAILED" },
    ]);
    expect(after.webhooks).toHaveLength(3);
    expect(ledger(files.mockFourcs)).toHaveLength(2);
    expect(ledger(files.mockFourcs)).toEqual(
      expect.arrayContaining(originalLedger),
    );
    expect(JSON.stringify(event)).not.toMatch(
      /mock-provider-key|9900000000000008|<MerchantKey>/,
    );
  },
  20000,
);
