import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { expect, test } from "vitest";
import {
  fourcsRequestInput,
  buildFourcsRequest,
  soapAction,
  soapPath,
} from "../../contracts/fourcs.ts";
import type { MockPaymentMethodRef } from "../../contracts/fourcs.ts";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";

const entrypoint = fileURLToPath(
  new URL("../../apps/mock-fourcs/main.ts", import.meta.url),
);
const ready = type({ kind: "'ready'", url: "string" });
const phase = type({
  kind: "'before-acceptance' | 'after-acceptance'",
  providerAccount: "string",
  tranId: "string",
  gateId: "string | null",
});
async function launch(path: string) {
  const process = startNodeProcess({
    entrypoint,
    args: [path, "0", "--test-control"],
  });
  try {
    const { url } = ready.assert(await process.message());
    return { ...process, url };
  } catch (error) {
    await process.stop();
    throw error;
  }
}
function submit({
  url,
  options: { ref = "pm_mock_approved", tranId = "TXN1" } = {},
}: {
  url: string;
  options?: { ref?: MockPaymentMethodRef; tranId?: string };
}) {
  return fetch(`${url}${soapPath}`, {
    method: "POST",
    headers: { "content-type": "text/xml", soapaction: soapAction },
    body: buildFourcsRequest(
      fourcsRequestInput.assert({
        merchantKey: "mock-provider-key-a",
        invoice: "INV1",
        tranId,
        amountMinor: 7500,
        currency: "XCD",
        mockPaymentMethodRef: ref,
      }),
    ),
  });
}
function facts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT provider_account, tran_id, invoice, amount_minor, currency, final_outcome, effect_count FROM mock_transactions ORDER BY tran_id",
      )
      .all();
  } finally {
    db.close();
  }
}

test("lost response commits once; same-ID recovery after actual process restart is a duplicate", async () => {
  await using files = await isolatedDatabases();
  const first = await launch(files.mockFourcs);
  try {
    const response = submit({
      url: first.url,
      options: { ref: "pm_mock_lost_response" },
    }).catch(() => null);
    expect(phase.assert(await first.message())).toMatchObject({
      kind: "after-acceptance",
      providerAccount: "mock-account-a",
      tranId: "TXN1",
    });
    expect(await response).toBeNull();
    expect(facts(files.mockFourcs)).toEqual([
      {
        provider_account: "mock-account-a",
        tran_id: "TXN1",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Approved",
        effect_count: 1,
      },
    ]);
  } finally {
    await first.stop();
  }
  const restarted = await launch(files.mockFourcs);
  try {
    const response = await submit({ url: restarted.url });
    expect(await response.text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    expect(facts(files.mockFourcs)).toHaveLength(1);
    expect(restarted.output()).not.toMatch(
      /mock-provider-key|9900000000000008|<MerchantKey>/,
    );
  } finally {
    await restarted.stop();
  }
});

test("an absent ledger entry and one rejected submission do not prevent a held request executing later", async () => {
  await using files = await isolatedDatabases();
  const provider = await launch(files.mockFourcs);
  try {
    const controller = new AbortController();
    const held = fetch(`${provider.url}${soapPath}`, {
      method: "POST",
      headers: { "content-type": "text/xml", soapaction: soapAction },
      signal: controller.signal,
      body: buildFourcsRequest(
        fourcsRequestInput.assert({
          merchantKey: "mock-provider-key-a",
          invoice: "INV1",
          tranId: "HELD",
          amountMinor: 7500,
          currency: "XCD",
          mockPaymentMethodRef: "pm_mock_held_before_acceptance",
        }),
      ),
    }).catch(() => null);
    const before = phase.assert(await provider.message());
    expect(before.kind).toBe("before-acceptance");
    expect(before.gateId).toEqual(expect.any(String));
    expect(facts(files.mockFourcs)).toEqual([]);
    controller.abort();
    expect(await held).toBeNull();
    const rejected = await submit({
      url: provider.url,
      options: {
        tranId: "HELD",
        ref: "pm_mock_fail_before_acceptance",
      },
    });
    expect(await rejected.text()).toContain(
      "<ResultCode>Unavailable</ResultCode>",
    );
    expect(facts(files.mockFourcs)).toEqual([]);
    provider.child.send({ kind: "release", gateId: before.gateId });
    expect(phase.assert(await provider.message()).kind).toBe(
      "after-acceptance",
    );
    expect(facts(files.mockFourcs)).toEqual([
      {
        provider_account: "mock-account-a",
        tran_id: "HELD",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Approved",
        effect_count: 1,
      },
    ]);
  } finally {
    await provider.stop();
  }
});

test("a delayed same-ID submission cannot replace a stored decline, even after its response was lost", async () => {
  await using files = await isolatedDatabases();
  const provider = await launch(files.mockFourcs);
  try {
    const held = submit({
      url: provider.url,
      options: {
        ref: "pm_mock_held_before_acceptance",
      },
    }).catch(() => null);
    const before = phase.assert(await provider.message());
    expect(before.kind).toBe("before-acceptance");
    const lost = submit({
      url: provider.url,
      options: {
        ref: "pm_mock_decline_lost_response",
      },
    }).catch(() => null);
    expect(phase.assert(await provider.message()).kind).toBe(
      "after-acceptance",
    );
    expect(await lost).toBeNull();
    expect(facts(files.mockFourcs)[0]).toMatchObject({
      final_outcome: "Declined",
      effect_count: 0,
    });
    provider.child.send({ kind: "release", gateId: before.gateId });
    expect(await (await held)?.text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    const rejectedFixture = await submit({
      url: provider.url,
      options: {
        ref: "pm_mock_fail_before_acceptance",
      },
    });
    expect(await rejectedFixture.text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    expect(facts(files.mockFourcs)).toEqual([
      {
        provider_account: "mock-account-a",
        tran_id: "TXN1",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Declined",
        effect_count: 0,
      },
    ]);
  } finally {
    await provider.stop();
  }
  const restarted = await launch(files.mockFourcs);
  try {
    expect(await (await submit({ url: restarted.url })).text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    expect(facts(files.mockFourcs)[0]).toMatchObject({
      final_outcome: "Declined",
      effect_count: 0,
    });
  } finally {
    await restarted.stop();
  }
});

test("an accepted delayed response remains durable when the provider is killed before replying", async () => {
  await using files = await isolatedDatabases();
  const provider = await launch(files.mockFourcs);
  try {
    const delayed = submit({
      url: provider.url,
      options: {
        ref: "pm_mock_delayed_response",
      },
    }).catch(() => null);
    const after = phase.assert(await provider.message());
    expect(after).toMatchObject({
      kind: "after-acceptance",
      gateId: expect.any(String),
    });
    expect(facts(files.mockFourcs)[0]).toMatchObject({
      final_outcome: "Approved",
      effect_count: 1,
    });
    expect(await (await submit({ url: provider.url })).text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    await provider.stop();
    expect(await delayed).toBeNull();
  } finally {
    await provider.stop();
  }
  const restarted = await launch(files.mockFourcs);
  try {
    expect(await (await submit({ url: restarted.url })).text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    expect(facts(files.mockFourcs)).toHaveLength(1);
    expect(facts(files.mockFourcs)[0]?.effect_count).toBe(1);
  } finally {
    await restarted.stop();
  }
});

test("overlapping same-ID submissions across two provider processes produce one accepted effect", async () => {
  await using files = await isolatedDatabases();
  const first = await launch(files.mockFourcs);
  const second = await launch(files.mockFourcs);
  try {
    const responses = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const response = await submit({
          url: index % 2 ? first.url : second.url,
        });
        return { status: response.status, xml: await response.text() };
      }),
    );
    expect(
      responses.every((response) => response.status === 200),
      first.output() + second.output(),
    ).toBe(true);
    expect(
      responses.filter((response) =>
        response.xml.includes("<ResultCode>OK</ResultCode>"),
      ),
    ).toHaveLength(1);
    expect(
      responses.filter((response) =>
        response.xml.includes("<ResultCode>DuplicateTransaction</ResultCode>"),
      ),
    ).toHaveLength(11);
    expect(facts(files.mockFourcs)).toEqual([
      {
        provider_account: "mock-account-a",
        tran_id: "TXN1",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Approved",
        effect_count: 1,
      },
    ]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("the trusted operator inspector reports matching final evidence without credentials or card fields", async () => {
  await using files = await isolatedDatabases();
  const provider = await launch(files.mockFourcs);
  const inspector = fileURLToPath(
    new URL("../../apps/mock-fourcs/inspect.ts", import.meta.url),
  );
  try {
    expect(await (await submit({ url: provider.url })).text()).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
    const recorded = await promisify(execFile)(
      process.execPath,
      [inspector, files.mockFourcs, "mock-account-a", "TXN1"],
      { timeout: 10_000 },
    );
    const output: unknown = JSON.parse(recorded.stdout);
    expect(output).toEqual({
      kind: "recorded",
      evidence: {
        providerAccount: "mock-account-a",
        tranId: "TXN1",
        invoice: "INV1",
        amountMinor: 7500,
        currency: "XCD",
        finalOutcome: "Approved",
        effectCount: 1,
        hostReference: expect.stringMatching(/^[a-f0-9]{16}$/),
        approvalCode: "MOCK01",
        acceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(recorded.stdout).not.toMatch(
      /mock-provider-key|9900000000000001|CardNumber|MerchantKey/,
    );
    const absent = await promisify(execFile)(
      process.execPath,
      [inspector, files.mockFourcs, "mock-account-b", "TXN1"],
      { timeout: 10_000 },
    );
    expect(JSON.parse(absent.stdout)).toEqual({
      kind: "absent",
      providerAccount: "mock-account-b",
      tranId: "TXN1",
    });
  } finally {
    await provider.stop();
  }
});

test("releasing a delayed response sends the original committed approval after duplicate handling", async () => {
  await using files = await isolatedDatabases();
  const provider = await launch(files.mockFourcs);
  try {
    const delayed = submit({
      url: provider.url,
      options: {
        ref: "pm_mock_delayed_response",
      },
    }).catch(() => null);
    const after = phase.assert(await provider.message());
    expect(after.kind).toBe("after-acceptance");
    expect(facts(files.mockFourcs)[0]?.effect_count).toBe(1);
    expect(await (await submit({ url: provider.url })).text()).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    provider.child.send({ kind: "release", gateId: after.gateId });
    const response = await delayed;
    expect(await response?.text()).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
    expect(facts(files.mockFourcs)).toHaveLength(1);
  } finally {
    await provider.stop();
  }
});
