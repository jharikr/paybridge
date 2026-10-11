import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { soapAction } from "../../contracts/fourcs.ts";
import { type } from "arktype";
import { expect } from "vitest";
import { confirm, create, lookup, rows } from "../provider/support.ts";
import { identity } from "../recovery/support.ts";
import type { journey } from "../provider/support.ts";

export const commandEntry = fileURLToPath(
  new URL("../../apps/paybridge/reconcile.ts", import.meta.url),
);
export async function command({
  path,
  directory,
  input,
  entrypoint = commandEntry,
}: {
  path: string;
  directory: string;
  input: unknown;
  entrypoint?: string;
}) {
  const file = join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(input));
  return new Promise<{ code: string | number; body: unknown; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [entrypoint, path, file],
        { timeout: 10000, maxBuffer: 65536 },
        (error, stdout, stderr) => {
          try {
            resolve({
              code: error?.code ?? 0,
              body: stdout ? JSON.parse(stdout) : null,
              stderr,
            });
          } catch (cause) {
            reject(cause);
          }
        },
      );
    },
  );
}
export async function unknownPayment(
  app: Awaited<ReturnType<typeof journey>>,
  path: string,
  {
    fixture = "pm_mock_lost_response",
    origin = app.mockUrl,
    merchant = "a",
  } = {},
) {
  const { id } = type({ id: "string" }).assert(
    await (await create(app.url, { merchant })).json(),
  );
  expect((await confirm(app.url, id, { fixture, merchant })).status).toBe(202);
  const worker = await app.startWorker({ origin });
  await expect
    .poll(() => lookup(app.url, id, merchant))
    .toMatchObject({ status: "UNKNOWN", revision: 3 });
  await worker.stop();
  const { id: reconciliationId } = type({ id: "string" }).assert(
    rows(path, "SELECT id FROM reconciliations")[0],
  );
  return { id, reconciliationId, identity: identity(path) };
}
export async function inspect(
  path: string,
  account: string,
  tranId: string,
): Promise<unknown> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../apps/mock-fourcs/inspect.ts", import.meta.url),
      ),
      path,
      account,
      tranId,
    ],
    { timeout: 10000, maxBuffer: 16384 },
  );
  return JSON.parse(stdout);
}
export function resolutionInput(
  reconciliationId: string,
  evidence: unknown,
  resolution = "SUCCEEDED",
) {
  return {
    kind: "resolve",
    reconciliationId,
    operator: "operator-a",
    resolution,
    reason: "Verified immutable synthetic ledger outcome",
    evidenceReference: "mock-ledger/export-1",
    evidence,
  };
}
export async function providerProxy({
  upstream,
  reply,
}: {
  upstream: string;
  reply: (xml: string, response: ServerResponse) => Promise<void> | void;
}) {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstreamResponse = await fetch(`${upstream}${request.url}`, {
        method: "POST",
        headers: { "content-type": "text/xml", soapaction: soapAction },
        body: Buffer.concat(chunks),
        signal: AbortSignal.timeout(10000),
      });
      response.setHeader("content-type", "text/xml; charset=utf-8");
      await reply(await upstreamResponse.text(), response);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = type({ port: "number" }).assert(server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
