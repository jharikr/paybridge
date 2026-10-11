import { type } from "arktype";
import { expect, test } from "vitest";
import {
  fourcsRequestInput,
  buildFourcsRequest,
  parseFourcsResponse,
  soapAction,
  soapPath,
} from "../../contracts/fourcs.ts";
import { isolatedDatabases } from "../support/databases.ts";
import {
  confirm,
  journey,
  lookup,
  mockEntry,
  ready,
  rows,
} from "../provider/support.ts";
import { startNodeProcess } from "../support/process.ts";
import { ledger, records } from "../recovery/support.ts";
import {
  command,
  inspect,
  providerProxy,
  resolutionInput,
  unknownPayment,
} from "./support.ts";

test.each([
  { fixture: "pm_mock_decline_lost_response", classification: "Declined" },
  { fixture: "pm_mock_incomplete", classification: "Incomplete" },
])(
  "final $classification evidence permits one deliberate retry and old resolution replay after later state changes",
  async ({ fixture, classification }) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    await using proxy = await providerProxy({
      upstream: app.mockUrl,
      reply: ({ response }) => {
        response.destroy();
      },
    });
    const payment = await unknownPayment({
      app,
      path: files.paybridge,
      options: {
        fixture,
        origin: classification === "Incomplete" ? proxy.origin : app.mockUrl,
      },
    });
    const exported = type({ kind: "'recorded'", evidence: "object" }).assert(
      await inspect({
        path: files.mockFourcs,
        account: payment.identity.provider_account_ref,
        tranId: payment.identity.provider_transaction_id,
      }),
    );
    const input = resolutionInput({
      reconciliationId: payment.reconciliationId,
      evidence: exported,
      resolution: "FAILED",
    });
    const resolved = await command({
      path: files.paybridge,
      directory: files.directory,
      input,
    });
    expect(resolved.code, JSON.stringify(resolved.body)).toBe(0);
    expect(await lookup({ url: app.url, id: payment.id })).toMatchObject({
      status: "FAILED",
      revision: 4,
      latestAttempt: { status: "FAILED", failureCode: classification },
    });
    const oldProvider = ledger(files.mockFourcs);
    expect(oldProvider).toMatchObject([
      { final_outcome: classification, effect_count: 0 },
    ]);
    const oldCase = records(files.paybridge).cases;
    const retry = await confirm({
      url: app.url,
      id: payment.id,
      options: {
        key: "deliberate-retry",
        revision: 4,
      },
    });
    expect(retry.status).toBe(202);
    const accepted = type({
      paymentAttemptId: "string",
      attemptNumber: "number",
    }).assert(await retry.json());
    expect(accepted.attemptNumber).toBe(2);
    expect(accepted.paymentAttemptId).not.toBe(
      payment.identity.payment_attempt_id,
    );
    await app.startWorker();
    await expect
      .poll(() => lookup({ url: app.url, id: payment.id }))
      .toMatchObject({ status: "SUCCEEDED", revision: 6 });
    const beforeReplay = records(files.paybridge);
    const reordered = Object.fromEntries(
      Object.entries({
        ...input,
        evidence: {
          evidence: Object.fromEntries(
            Object.entries(exported.evidence).reverse(),
          ),
          kind: "recorded",
        },
      }).reverse(),
    );
    expect(
      (
        await command({
          path: files.paybridge,
          directory: files.directory,
          input: reordered,
        })
      ).body,
    ).toEqual(resolved.body);
    expect(records(files.paybridge)).toEqual(beforeReplay);
    const attempts = rows({
      path: files.paybridge,
      sql: "SELECT id, provider_transaction_id, status, failure_code FROM payment_attempts ORDER BY attempt_number",
    });
    expect(attempts).toMatchObject([
      {
        id: payment.identity.payment_attempt_id,
        status: "FAILED",
        failure_code: classification,
      },
      { id: accepted.paymentAttemptId, status: "SUCCEEDED" },
    ]);
    expect(attempts[1]?.provider_transaction_id).not.toBe(
      payment.identity.provider_transaction_id,
    );
    expect(records(files.paybridge).cases).toEqual(oldCase);
    await app.mock.stop();
    const restarted = startNodeProcess({
      entrypoint: mockEntry,
      args: [files.mockFourcs, "0"],
    });
    try {
      const { url } = ready.assert(await restarted.message());
      const duplicate = await fetch(`${url}${soapPath}`, {
        method: "POST",
        headers: { "content-type": "text/xml", soapaction: soapAction },
        body: buildFourcsRequest(
          fourcsRequestInput.assert({
            merchantKey: "mock-provider-key-a",
            tranId: payment.identity.provider_transaction_id,
            invoice: payment.identity.provider_invoice,
            amountMinor: 7500,
            currency: "XCD",
            mockPaymentMethodRef: "pm_mock_approved",
          }),
        ),
      });
      expect(parseFourcsResponse(await duplicate.text())).toMatchObject({
        service: "DuplicateTransaction",
        financial: "",
      });
    } finally {
      await restarted.stop();
    }
    expect(ledger(files.mockFourcs)).toEqual(
      expect.arrayContaining(oldProvider),
    );
    expect(ledger(files.mockFourcs)).toHaveLength(2);
    expect(records(files.paybridge)).toEqual(beforeReplay);
    expect(
      (
        await confirm({
          url: app.url,
          id: payment.id,
          options: {
            key: "terminal-retry",
            revision: 6,
          },
        })
      ).status,
    ).toBe(409);
  },
  20000,
);
