import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { journey, lookup, ready, serverEntry } from "../provider/support.ts";
import { records } from "../recovery/support.ts";
import {
  command,
  inspect,
  resolutionInput,
  unknownPayment,
} from "./support.ts";

test.each([false, true])(
  "concurrent resolution processes commit one decision with conflicting input = %s",
  async (conflicting) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    const payment = await unknownPayment(app, files.paybridge);
    const evidence = await inspect(
      files.mockFourcs,
      payment.identity.provider_account_ref,
      payment.identity.provider_transaction_id,
    );
    const input = resolutionInput(payment.reconciliationId, evidence);
    const inputs = [
      input,
      conflicting
        ? {
            ...input,
            operator: "operator-b",
            reason: "Separate verified decision",
          }
        : input,
    ];
    const results = await Promise.all(
      inputs.map((item) =>
        command({
          path: files.paybridge,
          directory: files.directory,
          input: item,
        }),
      ),
    );
    expect(results.map((result) => result.code).sort()).toEqual(
      conflicting ? [0, 1] : [0, 0],
    );
    if (conflicting)
      expect(results.find((result) => result.code === 1)?.body).toEqual({
        kind: "error",
        code: "reconciliation_conflict",
      });
    else expect(results[0]?.body).toEqual(results[1]?.body);
    expect(await lookup(app.url, payment.id)).toMatchObject({
      status: "SUCCEEDED",
      revision: 4,
    });
    const saved = records(files.paybridge);
    expect(saved.events.map((row) => row.type)).toEqual([
      "PAYMENT_CREATED",
      "ATTEMPT_CREATED",
      "PAYMENT_UNKNOWN",
      "RECONCILIATION_RESOLVED",
      "PAYMENT_SUCCEEDED",
    ]);
    expect(saved.webhooks).toHaveLength(2);
    expect(saved.cases).toHaveLength(1);
    for (const changed of [
      { resolution: "FAILED" },
      { evidenceReference: "different-evidence" },
      { notes: "Different decision notes" },
    ]) {
      const result = await command({
        path: files.paybridge,
        directory: files.directory,
        input: { ...input, ...changed },
      });
      expect(result.body).toEqual({
        kind: "error",
        code: "reconciliation_conflict",
      });
      expect(records(files.paybridge)).toEqual(saved);
    }
  },
  20000,
);

test("failed start and resolution transactions roll back all records, and a killed resolution is safely retried", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  const payment = await unknownPayment(app, files.paybridge);
  const evidence = await inspect(
    files.mockFourcs,
    payment.identity.provider_account_ref,
    payment.identity.provider_transaction_id,
  );
  const input = resolutionInput(payment.reconciliationId, evidence);
  const initial = records(files.paybridge);
  for (const candidate of [
    {
      kind: "start",
      reconciliationId: payment.reconciliationId,
      operator: "operator-a",
    },
    input,
  ]) {
    const result = await command({
      path: files.paybridge,
      directory: files.directory,
      input: candidate,
      entrypoint: fileURLToPath(
        new URL("./fixtures/rollback.ts", import.meta.url),
      ),
    });
    expect(result).toMatchObject({
      code: 1,
      body: { kind: "error", code: "reconciliation_failed" },
    });
    expect(records(files.paybridge)).toEqual(initial);
    expect(await lookup(app.url, payment.id)).toMatchObject({
      status: "UNKNOWN",
      revision: 3,
    });
  }
  const file = join(files.directory, "held-resolution.json");
  await writeFile(file, JSON.stringify(input));
  const held = startNodeProcess({
    entrypoint: fileURLToPath(new URL("./fixtures/held.ts", import.meta.url)),
    args: [files.paybridge, file],
  });
  try {
    expect(await held.message()).toEqual({ kind: "resolution-writes-held" });
    expect(records(files.paybridge)).toEqual(initial);
    await held.stop();
  } finally {
    await held.stop();
  }
  expect(records(files.paybridge)).toEqual(initial);
  await app.server.stop();
  const restarted = startNodeProcess({
    entrypoint: serverEntry,
    args: [files.paybridge, "0"],
  });
  try {
    const { url } = ready.assert(await restarted.message());
    expect(await lookup(url, payment.id)).toMatchObject({
      status: "UNKNOWN",
      revision: 3,
    });
    const resolved = await command({
      path: files.paybridge,
      directory: files.directory,
      input,
    });
    expect(resolved.code).toBe(0);
    expect(await lookup(url, payment.id)).toMatchObject({
      status: "SUCCEEDED",
      revision: 4,
    });
    const committed = records(files.paybridge);
    await restarted.stop();
    const reopened = startNodeProcess({
      entrypoint: serverEntry,
      args: [files.paybridge, "0"],
    });
    try {
      const next = ready.assert(await reopened.message());
      expect(await lookup(next.url, payment.id)).toMatchObject({
        status: "SUCCEEDED",
        revision: 4,
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
      expect(records(files.paybridge)).toEqual(committed);
    } finally {
      await reopened.stop();
    }
  } finally {
    await restarted.stop();
  }
}, 20000);
