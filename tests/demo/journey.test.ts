import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";

const entrypoint = fileURLToPath(
  new URL("../../scripts/demo/main.ts", import.meta.url),
);
const run = promisify(execFile);

test(
  "the retained demo pays each merchant's bound order through direct and checkout notification paths",
  { timeout: 30000 },
  async () => {
    await using files = await isolatedDatabases();
    const result = await run(
      process.execPath,
      [entrypoint, "--data-parent", files.directory],
      {
        timeout: 25000,
        maxBuffer: 65536,
      },
    );
    expect(result.stdout + result.stderr).not.toMatch(
      /mock-paybridge-key|mock-provider-key|mock-webhook-secret|token=|CardNumber|<s:Envelope/,
    );
    const [name] = await readdir(files.directory);
    const directory = join(files.directory, type("string").assert(name));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
    ).toMatchObject({ status: "completed" });
    const merchant = new DatabaseSync(join(directory, "merchant.db"), {
      readOnly: true,
    });
    const mock = new DatabaseSync(join(directory, "mock-fourcs.db"), {
      readOnly: true,
    });
    try {
      expect(
        merchant
          .prepare(
            "SELECT merchant_id,state FROM orders WHERE business_reference='demo-shared-order' ORDER BY merchant_id",
          )
          .all(),
      ).toEqual([
        { merchant_id: "merchant-a", state: "PAID" },
        { merchant_id: "merchant-b", state: "PAID" },
      ]);
      expect(
        merchant
          .prepare(
            "SELECT count(*) AS count FROM webhook_inbox i JOIN merchant_payments p ON p.payment_intent_id=i.payment_intent_id JOIN orders o ON o.id=p.order_id WHERE i.status='PROCESSED' AND o.business_reference='demo-shared-order'",
          )
          .get(),
      ).toMatchObject({ count: 3 });
      expect(
        mock
          .prepare(
            "SELECT provider_account,sum(effect_count) AS effect_count FROM mock_transactions GROUP BY provider_account ORDER BY provider_account",
          )
          .all(),
      ).toEqual([
        { provider_account: "mock-account-a", effect_count: 1 },
        { provider_account: "mock-account-b", effect_count: 3 },
      ]);
    } finally {
      merchant.close();
      mock.close();
    }
  },
);

test(
  "the demonstration retains delivery work across receiver, provider and worker process restarts",
  { timeout: 30000 },
  async () => {
    await using files = await isolatedDatabases();
    await run(
      process.execPath,
      [entrypoint, "--data-parent", files.directory],
      {
        timeout: 25000,
        maxBuffer: 65536,
      },
    );
    const [name] = await readdir(files.directory);
    const directory = join(files.directory, type("string").assert(name));
    const manifest = type({
      processes: type({
        kind: "'started' | 'stopped'",
        name: "string",
        pid: "number.integer",
      }).array(),
    }).assert(
      JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
    );
    for (const name of ["merchant-api", "mock", "paybridge-worker"]) {
      const starts = manifest.processes.filter(
        (item) => item.kind === "started" && item.name === name,
      );
      expect(new Set(starts.map((item) => item.pid)).size).toBe(2);
    }
    const paybridge = new DatabaseSync(join(directory, "paybridge.db"), {
      readOnly: true,
    });
    try {
      expect(
        paybridge
          .prepare(
            "SELECT count(*) AS count FROM webhook_outbox WHERE status='DELIVERED'",
          )
          .get(),
      ).toEqual({ count: 11 });
      expect(
        paybridge
          .prepare(
            "SELECT count(*) AS count FROM webhook_outbox WHERE attempt_count >= 2",
          )
          .get(),
      ).toMatchObject({ count: expect.any(Number) });
      const retries = type({ count: "number" }).assert(
        paybridge
          .prepare(
            "SELECT count(*) AS count FROM webhook_outbox WHERE attempt_count >= 2",
          )
          .get(),
      ).count;
      expect(retries).toBeGreaterThanOrEqual(7);
      expect(
        paybridge
          .prepare("SELECT count(*) AS count FROM payment_attempts")
          .get(),
      ).toEqual({ count: 8 });
    } finally {
      paybridge.close();
    }
  },
);

test(
  "retained operator evidence resolves success and failure while an absent outcome stays UNKNOWN",
  { timeout: 30000 },
  async () => {
    await using files = await isolatedDatabases();
    await run(
      process.execPath,
      [entrypoint, "--data-parent", files.directory],
      {
        timeout: 25000,
        maxBuffer: 65536,
      },
    );
    const [name] = await readdir(files.directory);
    const directory = join(files.directory, type("string").assert(name));
    const paybridge = new DatabaseSync(join(directory, "paybridge.db"), {
      readOnly: true,
    });
    const merchant = new DatabaseSync(join(directory, "merchant.db"), {
      readOnly: true,
    });
    const mock = new DatabaseSync(join(directory, "mock-fourcs.db"), {
      readOnly: true,
    });
    try {
      expect(
        paybridge
          .prepare(
            "SELECT status,count(*) AS count FROM payment_intents GROUP BY status ORDER BY status",
          )
          .all(),
      ).toEqual([
        { status: "CANCELLED", count: 1 },
        { status: "FAILED", count: 1 },
        { status: "SUCCEEDED", count: 4 },
        { status: "UNKNOWN", count: 1 },
      ]);
      expect(
        paybridge
          .prepare(
            "SELECT status,resolution,count(*) AS count FROM reconciliations GROUP BY status,resolution ORDER BY status,resolution",
          )
          .all(),
      ).toEqual([
        { status: "IN_PROGRESS", resolution: null, count: 1 },
        { status: "RESOLVED", resolution: "FAILED", count: 1 },
        { status: "RESOLVED", resolution: "SUCCEEDED", count: 1 },
      ]);
      expect(
        merchant
          .prepare(
            "SELECT state,count(*) AS count FROM orders GROUP BY state ORDER BY state",
          )
          .all(),
      ).toEqual([
        { state: "PAID", count: 4 },
        { state: "UNPAID", count: 3 },
      ]);
      expect(
        mock
          .prepare(
            "SELECT count(*) AS count,sum(effect_count) AS effects FROM mock_transactions",
          )
          .get(),
      ).toEqual({ count: 7, effects: 4 });
      const evidenceFiles = await readdir(join(directory, "operator"));
      expect(evidenceFiles).toContain("resolve-success.json");
      expect(evidenceFiles).toContain("resolve-failure.json");
      expect(evidenceFiles).toContain("reject-absent.json");
    } finally {
      paybridge.close();
      merchant.close();
      mock.close();
    }
  },
);
