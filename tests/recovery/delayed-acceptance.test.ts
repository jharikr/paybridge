import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, create, journey, lookup } from "../provider/support.ts";
import { identity, ledger, mockGate, records } from "./support.ts";

test("a timed-out request can be accepted later; empty ledger evidence never permits another attempt", async () => {
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
  const worker = await app.startWorker({ timeout: 300, lease: 1000 });
  const gate = mockGate.assert(await app.mock.message());
  expect(gate).toMatchObject({
    kind: "before-acceptance",
    providerAccount: original.provider_account_ref,
    tranId: original.provider_transaction_id,
  });
  expect(ledger(files.mockFourcs)).toEqual([]);
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({
      status: "UNKNOWN",
      revision: 3,
      latestAttempt: { failureCode: "Timeout" },
    });
  const unknown = records(files.paybridge);
  const snapshot = await lookup(app.url, id);
  expect(ledger(files.mockFourcs)).toEqual([]);
  expect(unknown.cases).toMatchObject([
    { status: "REQUIRED", reason: "Timeout" },
  ]);
  expect(unknown.work).toMatchObject([
    {
      status: "COMPLETED",
      attempt_count: 1,
      claim_token: null,
      locked_by: null,
      lease_expires_at: null,
    },
  ]);
  expect(unknown.webhooks).toMatchObject([{ event_type: "payment.unknown" }]);
  const rejected = await confirm(app.url, id, {
    key: "empty-ledger-retry",
    revision: 3,
  });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({
    error: { code: "payment_not_confirmable" },
  });
  const inspect = () =>
    promisify(execFile)(process.execPath, [
      fileURLToPath(
        new URL("../../apps/mock-fourcs/inspect.ts", import.meta.url),
      ),
      files.mockFourcs,
      original.provider_account_ref,
      original.provider_transaction_id,
    ]);
  expect(JSON.parse((await inspect()).stdout)).toEqual({
    kind: "absent",
    providerAccount: original.provider_account_ref,
    tranId: original.provider_transaction_id,
  });
  app.mock.child.send({ kind: "release", gateId: gate.gateId });
  expect(await app.mock.message()).toEqual({
    kind: "after-acceptance",
    providerAccount: original.provider_account_ref,
    tranId: original.provider_transaction_id,
    gateId: null,
  });
  const evidence: unknown = JSON.parse((await inspect()).stdout);
  expect(evidence).toMatchObject({
    kind: "recorded",
    evidence: {
      providerAccount: original.provider_account_ref,
      tranId: original.provider_transaction_id,
      invoice: original.provider_invoice,
      amountMinor: 7500,
      currency: "XCD",
      finalOutcome: "Approved",
      effectCount: 1,
      hostReference: expect.stringMatching(/^[a-f0-9]{16}$/),
    },
  });
  expect(ledger(files.mockFourcs)).toMatchObject([
    { final_outcome: "Approved", effect_count: 1 },
  ]);
  expect(await lookup(app.url, id)).toEqual(snapshot);
  expect(records(files.paybridge)).toEqual(unknown);
  expect(
    (await confirm(app.url, id, { key: "accepted-later-retry", revision: 3 }))
      .status,
  ).toBe(409);
  expect(worker.output()).not.toMatch(
    /mock-provider-key|<MerchantKey>|9900000000000008/,
  );
  expect(JSON.stringify(unknown.events)).not.toMatch(
    /mock-provider-key|<MerchantKey>|9900000000000008/,
  );
}, 20000);
