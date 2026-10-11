import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { startNodeProcess } from "../support/process.ts";
import Ajv from "ajv/dist/2020.js";
import { expect } from "vitest";

const headerResponse = type({ headers: { "[string]": { schema: "object" } } });
export function verifyResponseHeaders({
  documented,
  response,
  names,
}: {
  documented: unknown;
  response: Response;
  names: string[];
}) {
  const definition = headerResponse.assert(documented);
  const ajv = new Ajv.default({ strict: false });
  for (const name of names) {
    const header = type({ schema: "object" }).assert(definition.headers[name]);
    const value = response.headers.get(name);
    expect(value, `Missing HTTP header ${name}`).not.toBeNull();
    expect(
      ajv.compile(header.schema)(value),
      `Invalid HTTP header ${name}`,
    ).toBe(true);
  }
}

export const ready = type({ kind: "'ready'", url: "string" });
export const merchantEntry = fileURLToPath(
  new URL("../../apps/merchant/server.ts", import.meta.url),
);
export const controlledEntry = fileURLToPath(
  new URL("./fixtures/server.ts", import.meta.url),
);
export const orderBody = {
  businessReference: "ORDER-1",
  amount: 7500,
  currency: "XCD",
};
export const orderIdentity = type({ id: "string", merchantId: "string" });
export const paymentIdentity = type({ id: "string", checkoutUrl: "string" });
export const commandList = type({
  commands: type({
    id: "string",
    operation: "'create' | 'confirm'",
    commandNumber: "number",
    status: "'PREPARED' | 'COMPLETED'",
  }).array(),
});
export const checkpoint = type({
  kind: "'prepared' | 'received' | 'before-completion-commit'",
  commandId: "string",
});
export function post(url: string, path: string, body?: unknown) {
  return fetch(`${url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}
export async function launchMerchant({
  path,
  paybridgeUrl,
  fault,
}: {
  path: string;
  paybridgeUrl: string;
  fault?: string;
}) {
  const process = startNodeProcess({
    entrypoint: fault ? controlledEntry : merchantEntry,
    args: [path, "0", paybridgeUrl, ...(fault ? [fault] : [])],
  });
  try {
    return { ...process, url: ready.assert(await process.message()).url };
  } catch (error) {
    await process.stop();
    throw error;
  }
}
