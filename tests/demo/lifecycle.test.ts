import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";

const entrypoint = fileURLToPath(
  new URL("../../scripts/demo/main.ts", import.meta.url),
);

test("a failed demo retains its new directory and leaves an occupied owner port alone", async () => {
  await using files = await isolatedDatabases();
  const owner = createServer((socket) => socket.end("owner"));
  await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const { port } = type({ port: "number.integer" }).assert(owner.address());
  try {
    const child = spawn(
      process.execPath,
      [
        entrypoint,
        "--data-parent",
        files.directory,
        "--paybridge-port",
        String(port),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on(
      "data",
      (value: Buffer) => (output += value.toString("utf8")),
    );
    const code = await new Promise((resolve) => child.once("exit", resolve));
    expect(code).toBe(1);
    expect(output).toContain('"code":"port_unavailable"');
    expect(owner.listening).toBe(true);
    const names = await readdir(files.directory);
    expect(names).toHaveLength(1);
    const name = type("string").assert(names[0]);
    expect(name).toMatch(/^demo-[a-f0-9-]+$/);
    expect(
      JSON.parse(
        await readFile(join(files.directory, name, "result.json"), "utf8"),
      ),
    ).toEqual({ status: "failed", code: "port_unavailable" });
    expect(
      JSON.parse(
        await readFile(join(files.directory, name, "manifest.json"), "utf8"),
      ),
    ).toMatchObject({ processes: [] });
  } finally {
    await new Promise<void>((resolve) => owner.close(() => resolve()));
  }
});

test(
  "interrupting the demo stops its owned processes and retains failed evidence",
  { timeout: 15000 },
  async () => {
    await using files = await isolatedDatabases();
    const child = spawn(
      process.execPath,
      [entrypoint, "--data-parent", files.directory],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let directory = "";
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const names = await readdir(files.directory);
        if (names[0]) {
          directory = join(files.directory, names[0]);
          try {
            const manifest = type({
              processes: type({ kind: "string", name: "string" }).array(),
            }).assert(
              JSON.parse(
                await readFile(join(directory, "manifest.json"), "utf8"),
              ),
            );
            if (
              manifest.processes.some(
                (item) =>
                  item.kind === "started" && item.name === "merchant-api",
              )
            )
              break;
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              ) &&
              !(error instanceof SyntaxError)
            )
              throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(directory).not.toBe("");
      child.kill("SIGTERM");
      expect(await exited).toBe(1);
      expect(
        JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
      ).toEqual({ status: "failed", code: "demo_interrupted" });
      const manifest = type({
        processes: type({
          kind: "'started' | 'stopped'",
          name: "string",
          pid: "number.integer",
        }).array(),
      }).assert(
        JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
      );
      const starts = manifest.processes
        .filter((item) => item.kind === "started")
        .map((item) => item.pid)
        .sort();
      const stops = manifest.processes
        .filter((item) => item.kind === "stopped")
        .map((item) => item.pid)
        .sort();
      expect(starts.length).toBeGreaterThanOrEqual(3);
      expect(stops).toEqual(starts);
      for (const pid of starts) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
    }
  },
);
