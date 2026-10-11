import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { confirm, create, headers, journey, lookup, rows } from "./support.ts";

test("a committed confirmation reaches approval through the local worker and retains its original acknowledgments", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const creation = await create(app.url);
  expect(creation.status).toBe(201);
  const creationBody = await creation.text();
  const { id } = type({ id: "string" }).assert(JSON.parse(creationBody));
  const confirmation = await confirm(app.url, id);
  expect(confirmation.status).toBe(202);
  const accepted = await confirmation.text();
  await app.startWorker();
  await expect
    .poll(() => lookup(app.url, id))
    .toMatchObject({
      status: "SUCCEEDED",
      revision: 3,
      latestAttempt: { status: "SUCCEEDED", attemptNumber: 1 },
    });
  expect(
    rows(
      files.mockFourcs,
      "SELECT provider_account, amount_minor, currency, final_outcome, effect_count FROM mock_transactions",
    ),
  ).toEqual([
    {
      provider_account: "mock-account-a",
      amount_minor: 7500,
      currency: "XCD",
      final_outcome: "Approved",
      effect_count: 1,
    },
  ]);
  expect(
    rows(
      files.paybridge,
      "SELECT status, attempt_count, claim_token, completed_at FROM provider_outbox",
    ),
  ).toEqual([
    {
      status: "COMPLETED",
      attempt_count: 1,
      claim_token: null,
      completed_at: expect.any(String),
    },
  ]);
  const webhook = type({ payload: "string" }).assert(
    rows(files.paybridge, "SELECT payload FROM webhook_outbox")[0],
  );
  const payload: unknown = JSON.parse(webhook.payload);
  expect(payload).toEqual({
    id: expect.stringMatching(/^evt_/),
    type: "payment.succeeded",
    createdAt: expect.any(String),
    data: {
      paymentIntentId: id,
      merchantReference: "Order <&> 😀",
      amount: 7500,
      currency: "XCD",
      status: "SUCCEEDED",
      revision: 3,
    },
  });
  expect(await (await create(app.url)).text()).toBe(creationBody);
  expect(await (await confirm(app.url, id)).text()).toBe(accepted);
  expect(
    (
      await fetch(`${app.url}/v1/payment-intents/${id}/cancel`, {
        method: "POST",
        headers: { authorization: headers().authorization },
      })
    ).status,
  ).toBe(409);
  expect(
    (await confirm(app.url, id, { key: "after-success", revision: 3 })).status,
  ).toBe(409);
  expect(
    rows(
      files.paybridge,
      "SELECT type, intent_revision FROM payment_events WHERE type = 'PAYMENT_SUCCEEDED'",
    ),
  ).toEqual([{ type: "PAYMENT_SUCCEEDED", intent_revision: 3 }]);
});

test.each([
  ["pm_mock_incomplete", "FAILED", "Incomplete", "Incomplete", 0],
  ["pm_mock_malformed", "UNKNOWN", "MalformedResponse", "Approved", 1],
  ["pm_mock_mismatched_echo", "UNKNOWN", "MismatchedEcho", "Approved", 1],
  ["pm_mock_invalid_service", "UNKNOWN", "InvalidServiceResult", "Approved", 1],
  [
    "pm_mock_invalid_operation",
    "UNKNOWN",
    "InvalidOperationResult",
    "Approved",
    1,
  ],
  ["pm_mock_lost_response", "UNKNOWN", "TransportFailure", "Approved", 1],
  [
    "pm_mock_decline_lost_response",
    "UNKNOWN",
    "TransportFailure",
    "Declined",
    0,
  ],
  ["pm_mock_delayed_response", "UNKNOWN", "Timeout", "Approved", 1],
])(
  "%s persists %s and completes financial work",
  async (fixture, status, code, finalOutcome, effectCount) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    const { id } = type({ id: "string" }).assert(
      await (await create(app.url)).json(),
    );
    expect(
      (await confirm(app.url, id, { fixture: String(fixture) })).status,
    ).toBe(202);
    const worker = await app.startWorker();
    await expect
      .poll(() => lookup(app.url, id), { timeout: 5000 })
      .toMatchObject({
        status,
        revision: 3,
        latestAttempt: { status, failureCode: code },
      });
    expect(
      rows(
        files.mockFourcs,
        "SELECT final_outcome, effect_count FROM mock_transactions",
      ),
    ).toEqual([{ final_outcome: finalOutcome, effect_count: effectCount }]);
    expect(
      rows(
        files.paybridge,
        "SELECT status, claim_token, locked_by, lease_expires_at FROM provider_outbox",
      ),
    ).toEqual([
      {
        status: "COMPLETED",
        claim_token: null,
        locked_by: null,
        lease_expires_at: null,
      },
    ]);
    expect(
      rows(
        files.paybridge,
        "SELECT status, resolution, resolved_at FROM reconciliations",
      ),
    ).toEqual(
      status === "UNKNOWN"
        ? [{ status: "REQUIRED", resolution: null, resolved_at: null }]
        : [],
    );
    expect(
      rows(
        files.paybridge,
        "SELECT type, intent_revision FROM payment_events WHERE from_status = 'PROCESSING'",
      ),
    ).toEqual([{ type: `PAYMENT_${status}`, intent_revision: 3 }]);
    const event = type({ event_type: "string", payload: "string" }).assert(
      rows(
        files.paybridge,
        "SELECT event_type, payload FROM webhook_outbox",
      )[0],
    );
    expect(event.event_type).toBe(
      status === "FAILED" ? "payment.failed" : "payment.unknown",
    );
    expect(JSON.parse(event.payload)).toMatchObject({
      type: event.event_type,
      data: { paymentIntentId: id, status, revision: 3 },
    });
    await worker.stop();
    await app.startWorker();
    await lookup(app.url, id);
    await lookup(app.url, id);
    expect(
      rows(files.paybridge, "SELECT attempt_count FROM provider_outbox"),
    ).toEqual([{ attempt_count: 1 }]);
    expect(
      (
        await fetch(`${app.url}/v1/payment-intents/${id}/cancel`, {
          method: "POST",
          headers: { authorization: headers().authorization },
        })
      ).status,
    ).toBe(409);
    if (status === "UNKNOWN")
      expect(
        (await confirm(app.url, id, { key: "blocked", revision: 3 })).status,
      ).toBe(409);
    expect(worker.output()).not.toMatch(
      /mock-provider-key|CardNumber|VerificationValue|<.*Envelope|mock-paybridge-key/,
    );
  },
);

test("a decline preserves acceptance replay, rejects a delayed stale key, and permits a deliberate current-revision attempt", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url, { merchant: "b", amount: 1 })).json(),
  );
  const input = { fixture: "pm_mock_declined", merchant: "b" };
  const response = await confirm(app.url, id, input);
  expect(response.status).toBe(202);
  const acknowledgment = await response.text();
  await app.startWorker();
  await expect
    .poll(() => lookup(app.url, id, "b"))
    .toMatchObject({
      status: "FAILED",
      revision: 3,
      latestAttempt: { status: "FAILED", failureCode: "Declined" },
    });
  expect(
    (await confirm(app.url, id, { ...input, key: "delayed-command" })).status,
  ).toBe(409);
  expect(await (await confirm(app.url, id, input)).text()).toBe(acknowledgment);
  expect(
    rows(files.paybridge, "SELECT attempt_number FROM payment_attempts"),
  ).toEqual([{ attempt_number: 1 }]);
  expect(
    (
      await confirm(app.url, id, {
        merchant: "b",
        key: "deliberate-retry",
        revision: 3,
      })
    ).status,
  ).toBe(202);
  await expect
    .poll(() => lookup(app.url, id, "b"))
    .toMatchObject({
      status: "SUCCEEDED",
      revision: 5,
      latestAttempt: { status: "SUCCEEDED", attemptNumber: 2 },
    });
  expect(
    rows(
      files.mockFourcs,
      "SELECT provider_account, amount_minor, currency, final_outcome, effect_count FROM mock_transactions ORDER BY accepted_at",
    ),
  ).toEqual([
    {
      provider_account: "mock-account-b",
      amount_minor: 1,
      currency: "XCD",
      final_outcome: "Declined",
      effect_count: 0,
    },
    {
      provider_account: "mock-account-b",
      amount_minor: 1,
      currency: "XCD",
      final_outcome: "Approved",
      effect_count: 1,
    },
  ]);
  const identities = type({ provider_transaction_id: "string" })
    .array()
    .assert(
      rows(
        files.paybridge,
        "SELECT provider_transaction_id FROM payment_attempts",
      ),
    );
  expect(
    new Set(identities.map((attempt) => attempt.provider_transaction_id)).size,
  ).toBe(2);
  expect(
    rows(
      files.paybridge,
      "SELECT event_type FROM webhook_outbox ORDER BY created_at",
    ),
  ).toEqual([
    { event_type: "payment.failed" },
    { event_type: "payment.succeeded" },
  ]);
});
