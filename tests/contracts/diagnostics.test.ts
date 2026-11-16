import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { create, ready, rows } from "../provider/support.ts";

test("unexpected HTTP failures retain safe operation and cause classifications without raw sensitive details", async () => {
  await using files = await isolatedDatabases();
  const api = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("./fixtures/diagnostic-api.ts", import.meta.url),
    ),
    args: [files.paybridge],
  });
  try {
    const { url } = ready.assert(await api.message());
    const response = await create({ url });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    await expect
      .poll(api.output)
      .toContain('"causes":["type_error","SQLITE_BUSY","reference_error"]');
    expect(api.output()).toContain('"operation":"http_request"');
    expect(api.output()).toContain('"route":"/v1/payment-intents"');
    expect(api.output() + JSON.stringify(body)).not.toMatch(
      /sensitive|<SOAP>|credential=|token=/,
    );
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_intents" }),
    ).toEqual([]);
  } finally {
    await api.stop();
  }
});

test.each([
  {
    app: "paybridge",
    entry: "paybridge/server.ts",
    operation: "paybridge_migration",
  },
  {
    app: "merchant",
    entry: "merchant/server.ts",
    operation: "merchant_migration",
  },
  {
    app: "mockFourcs",
    entry: "mock-fourcs/main.ts",
    operation: "mock_migration",
  },
] as const)(
  "$app migration failures expose a bounded safe cause without database contents",
  async ({ app, entry, operation }) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await using files = await isolatedDatabases();
    const bytes = "not a database: credential=sensitive-database-contents";
    await writeFile(files[app], bytes);
    const server = startNodeProcess({
      entrypoint: fileURLToPath(
        new URL(`../../apps/${entry}`, import.meta.url),
      ),
      args: [files[app], "0"],
    });
    try {
      await expect.poll(() => server.child.exitCode).not.toBeNull();
      expect(server.child.exitCode).toBe(1);
      expect(server.output()).toContain(operation);
      expect(server.output()).toContain("ERR_SQLITE_ERROR");
      expect(server.output()).not.toMatch(/sensitive|credential=/);
      expect(await readFile(files[app], "utf8")).toBe(bytes);
    } finally {
      await server.stop();
    }
  },
);
