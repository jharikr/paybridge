import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type } from "arktype";
import { runJourney } from "./journey.ts";
import { DemoFailure } from "./process.ts";
import { implementationFingerprint } from "./evidence.ts";

process.umask(0o077);
async function main() {
  const { values } = parseArgs({
    options: {
      "data-parent": { type: "string" },
      "paybridge-port": { type: "string" },
    },
  });
  const parent = resolve(values["data-parent"] ?? ".data");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = join(parent, `demo-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  process.stdout.write(
    `${JSON.stringify({ event: "demo-started", directory })}\n`,
  );
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  try {
    const paybridgePort = type("0 <= number.integer <= 65535").assert(
      Number(values["paybridge-port"] ?? 0),
    );
    await writeFile(
      join(directory, "implementation.json"),
      JSON.stringify({
        sha256: await implementationFingerprint(),
        node: process.version,
        capturedAt: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    const result = await runJourney({
      directory,
      paybridgePort,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({ status: "completed", ...result }, null, 2) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ event: "demo-completed", directory })}\n`,
    );
  } catch (error) {
    const code = controller.signal.aborted
      ? "demo_interrupted"
      : error instanceof DemoFailure
        ? error.code
        : "demo_failed";
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({ status: "failed", code }) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ event: "demo-failed", directory, code })}\n`,
    );
    process.exitCode = 1;
  }
}

try {
  await main();
} catch {
  process.stdout.write(
    `${JSON.stringify({ event: "demo-failed", code: "demo_setup_failed" })}\n`,
  );
  process.exitCode = 1;
}
