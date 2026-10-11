import { type } from "arktype";
import { expect, test } from "vitest";
import {
  buildFourcsRequest,
  parseFourcsResponse,
  soapAction,
  soapPath,
} from "../../contracts/fourcs.ts";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import {
  confirm,
  create,
  journey,
  lookup,
  mockEntry,
  ready,
  serverEntry,
} from "../provider/support.ts";
import {
  claim,
  claimed,
  identity,
  ledger,
  mockGate,
  records,
  recoveryWorker,
} from "./support.ts";

test("API and worker SIGKILL before submission recovers the committed attempt and acknowledgment", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using first = await recoveryWorker({
    path: files.paybridge,
    origin: app.mockUrl,
    hold: "after-claim",
  });
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url, { merchant: "b", amount: 99 })).json(),
  );
  const ack = await confirm(app.url, id, { merchant: "b" });
  expect(ack.status).toBe(202);
  const bytes = await ack.text();
  const original = identity(files.paybridge);
  await app.server.stop();
  await first.start();
  expect(await first.message()).toEqual({
    kind: "after-claim",
    workerId: first.workerId,
  });
  const abandoned = claim(files.paybridge);
  expect(ledger(files.mockFourcs)).toEqual([]);
  await first.stop();

  const server = startNodeProcess({
    entrypoint: serverEntry,
    args: [files.paybridge, "0"],
  });
  try {
    const { url } = ready.assert(await server.message());
    expect(await (await confirm(url, id, { merchant: "b" })).text()).toBe(
      bytes,
    );
    await using second = await recoveryWorker({
      path: files.paybridge,
      origin: app.mockUrl,
    });
    await second.advance(Date.parse(abandoned.lease_expires_at) + 1);
    await second.start();
    await expect
      .poll(() => lookup(url, id, "b"))
      .toMatchObject({
        status: "SUCCEEDED",
        revision: 3,
        latestAttempt: { id: original.payment_attempt_id, attemptNumber: 1 },
      });
    expect(identity(files.paybridge)).toEqual(original);
    expect(ledger(files.mockFourcs)).toMatchObject([
      {
        provider_account: "mock-account-b",
        tran_id: original.provider_transaction_id,
        invoice: original.provider_invoice,
        amount_minor: 99,
        currency: "XCD",
        payment_method_ref: "pm_mock_approved",
        final_outcome: "Approved",
        effect_count: 1,
      },
    ]);
    const saved = records(files.paybridge);
    expect(saved.attempts).toHaveLength(1);
    expect(saved.work).toMatchObject([
      {
        status: "COMPLETED",
        attempt_count: 2,
        claim_token: null,
        locked_by: null,
        lease_expires_at: null,
      },
    ]);
    expect(saved.cases).toEqual([]);
    expect(saved.events.map((row) => row.type)).toEqual([
      "PAYMENT_CREATED",
      "ATTEMPT_CREATED",
      "PAYMENT_SUCCEEDED",
    ]);
    expect(saved.webhooks).toHaveLength(1);
    expect(await (await confirm(url, id, { merchant: "b" })).text()).toBe(
      bytes,
    );
  } finally {
    await server.stop();
  }
}, 20000);

test.each([
  {
    fixture: "pm_mock_approved",
    status: "SUCCEEDED",
    outcome: "Approved",
    effects: 1,
  },
  {
    fixture: "pm_mock_decline_lost_response",
    status: "UNKNOWN",
    outcome: "Declined",
    effects: 0,
  },
])(
  "$fixture remains final in the mock and retains committed Paybridge records after all processes restart",
  async ({ fixture, status, outcome, effects }) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    const { id } = type({ id: "string" }).assert(
      await (await create(app.url)).json(),
    );
    const ack = await confirm(app.url, id, { fixture });
    expect(ack.status).toBe(202);
    const bytes = await ack.text();
    const a = await app.startWorker();
    await expect
      .poll(() => lookup(app.url, id))
      .toMatchObject({ status, revision: 3 });
    const snapshot = await lookup(app.url, id);
    const committed = records(files.paybridge);
    const original = identity(files.paybridge);
    const accepted = ledger(files.mockFourcs);
    expect(accepted).toMatchObject([
      { final_outcome: outcome, effect_count: effects },
    ]);
    expect(committed.work).toMatchObject([
      {
        status: "COMPLETED",
        attempt_count: 1,
        claim_token: null,
        locked_by: null,
        lease_expires_at: null,
      },
    ]);
    expect(committed.webhooks).toHaveLength(1);
    expect(committed.cases).toHaveLength(status === "UNKNOWN" ? 1 : 0);
    await a.stop();
    await Promise.all([app.server.stop(), app.mock.stop()]);
    const server = startNodeProcess({
      entrypoint: serverEntry,
      args: [files.paybridge, "0"],
    });
    const mock = startNodeProcess({
      entrypoint: mockEntry,
      args: [files.mockFourcs, "0", "--test-control"],
    });
    try {
      const { url } = ready.assert(await server.message());
      const origin = ready.assert(await mock.message()).url;
      expect(await lookup(url, id)).toEqual(snapshot);
      expect(records(files.paybridge)).toEqual(committed);
      expect(await (await confirm(url, id, { fixture })).text()).toBe(bytes);
      const duplicate = await fetch(`${origin}${soapPath}`, {
        method: "POST",
        headers: { "content-type": "text/xml", soapaction: soapAction },
        body: buildFourcsRequest({
          merchantKey: "mock-provider-key-a",
          tranId: original.provider_transaction_id,
          invoice: original.provider_invoice,
          amountMinor: 7500,
          currency: "XCD",
          mockPaymentMethodRef: "pm_mock_approved",
        }),
      });
      expect(duplicate.status).toBe(200);
      expect(parseFourcsResponse(await duplicate.text())).toMatchObject({
        service: "DuplicateTransaction",
        financial: "",
      });
      expect(ledger(files.mockFourcs)).toEqual(accepted);
      expect(
        (await confirm(url, id, { key: "new-after-restart", revision: 3 }))
          .status,
      ).toBe(409);
      await using b = await recoveryWorker({ path: files.paybridge, origin });
      await b.advance(Date.now() + 60000);
      await b.start();
      const marker = type({ id: "string" }).assert(
        await (await create(url, { key: "restart-marker" })).json(),
      );
      expect(
        (await confirm(url, marker.id, { key: "marker-confirm" })).status,
      ).toBe(202);
      await expect
        .poll(() => lookup(url, marker.id))
        .toMatchObject({ status: "SUCCEEDED", revision: 3 });
      expect(await lookup(url, id)).toEqual(snapshot);
      const restarted = records(files.paybridge);
      for (const key of [
        "attempts",
        "work",
        "cases",
        "events",
        "webhooks",
      ] satisfies (keyof typeof committed)[]) {
        expect(restarted[key]).toEqual(expect.arrayContaining(committed[key]));
      }
      expect(restarted.work).toHaveLength(2);
      expect(restarted.attempts).toHaveLength(2);
      expect(restarted.webhooks).toHaveLength(2);
      expect(ledger(files.mockFourcs)).toHaveLength(2);
      expect(ledger(files.mockFourcs)).toEqual(
        expect.arrayContaining(accepted),
      );
    } finally {
      await Promise.all([server.stop(), mock.stop()]);
    }
  },
  20000,
);

test("SIGKILL after provider acceptance recovers the same identity across API, worker, and mock restart as one UNKNOWN", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using a = await recoveryWorker({
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
  const abandoned = claim(files.paybridge);
  const accepted = ledger(files.mockFourcs);
  expect(accepted).toMatchObject([
    { final_outcome: "Approved", effect_count: 1 },
  ]);
  await a.stop();
  await Promise.all([app.server.stop(), app.mock.stop()]);
  const server = startNodeProcess({
    entrypoint: serverEntry,
    args: [files.paybridge, "0"],
  });
  const mock = startNodeProcess({
    entrypoint: mockEntry,
    args: [files.mockFourcs, "0", "--test-control"],
  });
  try {
    const { url } = ready.assert(await server.message());
    const origin = ready.assert(await mock.message()).url;
    expect(await lookup(url, id)).toMatchObject({
      status: "PROCESSING",
      revision: 2,
    });
    expect(
      await (
        await confirm(url, id, { fixture: "pm_mock_delayed_response" })
      ).text(),
    ).toBe(bytes);
    await using b = await recoveryWorker({ path: files.paybridge, origin });
    await b.advance(Date.parse(abandoned.lease_expires_at) + 1);
    await b.start();
    await expect
      .poll(() => lookup(url, id))
      .toMatchObject({
        status: "UNKNOWN",
        revision: 3,
        latestAttempt: {
          id: original.payment_attempt_id,
          attemptNumber: 1,
          failureCode: "DuplicateTransaction",
        },
      });
    expect(identity(files.paybridge)).toEqual(original);
    expect(ledger(files.mockFourcs)).toEqual(accepted);
    const saved = records(files.paybridge);
    expect(saved.attempts).toHaveLength(1);
    expect(saved.work).toMatchObject([
      {
        status: "COMPLETED",
        attempt_count: 2,
        claim_token: null,
        locked_by: null,
        lease_expires_at: null,
      },
    ]);
    expect(saved.cases).toMatchObject([
      {
        payment_attempt_id: original.payment_attempt_id,
        status: "REQUIRED",
        reason: "DuplicateTransaction",
      },
    ]);
    expect(saved.webhooks).toMatchObject([{ event_type: "payment.unknown" }]);
    expect(saved.events.map((row) => row.type)).toEqual([
      "PAYMENT_CREATED",
      "ATTEMPT_CREATED",
      "PAYMENT_UNKNOWN",
    ]);
    expect(
      (await confirm(url, id, { key: "fresh-after-recovery", revision: 3 }))
        .status,
    ).toBe(409);
    expect(
      await (
        await confirm(url, id, { fixture: "pm_mock_delayed_response" })
      ).text(),
    ).toBe(bytes);
  } finally {
    await Promise.all([server.stop(), mock.stop()]);
  }
}, 20000);

test.each(["pm_mock_approved", "pm_mock_malformed"])(
  "SIGKILL during %s result persistence rolls back every final write and remains recoverable",
  async (fixture) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    await using a = await recoveryWorker({
      path: files.paybridge,
      origin: app.mockUrl,
      hold: "before-result-commit",
    });
    await using b = await recoveryWorker({
      path: files.paybridge,
      origin: app.mockUrl,
    });
    const { id } = type({ id: "string" }).assert(
      await (await create(app.url)).json(),
    );
    expect((await confirm(app.url, id, { fixture })).status).toBe(202);
    const initial = records(files.paybridge);
    const original = identity(files.paybridge);
    await a.start();
    await claimed(a);
    expect(await a.message()).toEqual({
      kind: "before-result-commit",
      workerId: a.workerId,
    });
    const abandoned = claim(files.paybridge);
    const accepted = ledger(files.mockFourcs);
    expect(accepted).toMatchObject([
      { final_outcome: "Approved", effect_count: 1 },
    ]);
    await a.stop();
    expect(await lookup(app.url, id)).toMatchObject({
      status: "PROCESSING",
      revision: 2,
      latestAttempt: { status: "PROCESSING" },
    });
    const rolledBack = records(files.paybridge);
    expect(rolledBack.attempts).toEqual(initial.attempts);
    expect(rolledBack.events).toEqual(initial.events);
    expect(rolledBack.cases).toEqual([]);
    expect(rolledBack.webhooks).toEqual([]);
    expect(rolledBack.work).toMatchObject([
      { status: "PROCESSING", completed_at: null, attempt_count: 1 },
    ]);
    await b.advance(Date.parse(abandoned.lease_expires_at) + 1);
    await b.start();
    await expect
      .poll(() => lookup(app.url, id))
      .toMatchObject({ status: "UNKNOWN", revision: 3 });
    expect(identity(files.paybridge)).toEqual(original);
    expect(ledger(files.mockFourcs)).toEqual(accepted);
    const recovered = records(files.paybridge);
    expect(recovered.attempts).toHaveLength(1);
    expect(recovered.attempts).toMatchObject([
      { status: "UNKNOWN", failure_code: "DuplicateTransaction" },
    ]);
    expect(recovered.work).toMatchObject([
      {
        status: "COMPLETED",
        completed_at: expect.any(String),
        attempt_count: 2,
        claim_token: null,
        locked_by: null,
        lease_expires_at: null,
      },
    ]);
    expect(recovered.cases).toMatchObject([
      { status: "REQUIRED", reason: "DuplicateTransaction" },
    ]);
    expect(recovered.events.map((row) => row.type)).toEqual([
      "PAYMENT_CREATED",
      "ATTEMPT_CREATED",
      "PAYMENT_UNKNOWN",
    ]);
    expect(recovered.webhooks).toMatchObject([
      { event_type: "payment.unknown" },
    ]);
  },
  20000,
);
